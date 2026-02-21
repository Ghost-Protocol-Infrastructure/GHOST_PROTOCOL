import { config as loadEnv } from "dotenv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NextRequest } from "next/server";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";
process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS = "true";
process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE = "false";
process.env.GHOST_REQUEST_CREDIT_COST = "1";

const DOMAIN = {
  name: "GhostGate",
  version: "1",
  chainId: 8453,
} as const;

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const callGate = async (
  gateGet: (request: NextRequest, context: { params: { slug: string[] } }) => Promise<Response>,
  input: {
    service: string;
    signature: `0x${string}`;
    payloadJson: string;
    requestId: string;
    requestScopedCost: string;
  },
): Promise<{ status: number; body: any }> => {
  const req = new NextRequest(`http://localhost/api/gate/${input.service}`, {
    method: "GET",
    headers: {
      "x-ghost-payload": input.payloadJson,
      "x-ghost-sig": input.signature,
      "x-ghost-request-id": input.requestId,
      "x-ghost-credit-cost": input.requestScopedCost,
    },
  });

  const res = await gateGet(req, { params: { slug: input.service.split("/") } });
  return { status: res.status, body: await res.json() };
};

const run = async (): Promise<void> => {
  const { GET: gateGet } = await import("../app/api/gate/[...slug]/route");
  const { prisma, updateUserCredits, getUserCredits } = await import("../lib/db");

  const cleanupWallets = new Set<string>();

  try {
    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 3n);

      const service = "regression/replay";
      const nonce = `reg-nonce-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const signature = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Access",
        message: { service, timestamp, nonce },
      });

      const payloadJson = JSON.stringify({
        service,
        timestamp: timestamp.toString(),
        nonce,
      });

      const first = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-replay-1-${Date.now()}`,
        requestScopedCost: "999",
      });
      const second = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-replay-2-${Date.now()}`,
        requestScopedCost: "999",
      });

      const balanceAfter = await getUserCredits(signer);
      const nonceCount = await prisma.accessNonce.count({
        where: { signer: signerKey, service, nonce },
      });
      const gateDebitCount = await prisma.creditLedger.count({
        where: { walletAddress: signerKey, reason: "gate_debit" },
      });

      assert(first.status === 200, `Expected first gate call 200, got ${first.status}`);
      assert(second.status === 409, `Expected replay gate call 409, got ${second.status}`);
      assert(balanceAfter === 2n, `Expected balance 2 after replay test, got ${balanceAfter.toString()}`);
      assert(nonceCount === 1, `Expected nonce count 1, got ${nonceCount}`);
      assert(gateDebitCount === 1, `Expected one gate debit row, got ${gateDebitCount}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 3n);

      const service = "regression/cost";
      const nonce = `reg-cost-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const signature = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Access",
        message: { service, timestamp, nonce },
      });

      const payloadJson = JSON.stringify({
        service,
        timestamp: timestamp.toString(),
        nonce,
      });

      const res = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-cost-1-${Date.now()}`,
        requestScopedCost: "999",
      });

      const latestDebit = await prisma.creditLedger.findFirst({
        where: { walletAddress: signerKey, reason: "gate_debit" },
        orderBy: { createdAt: "desc" },
        select: { amount: true, direction: true },
      });

      assert(res.status === 200, `Expected cost test status 200, got ${res.status}`);
      assert(res.body?.cost === "1", `Expected cost '1', got ${String(res.body?.cost)}`);
      assert(
        res.body?.costSource === "default",
        `Expected costSource 'default', got ${String(res.body?.costSource)}`,
      );
      assert(latestDebit?.amount === 1, `Expected ledger debit amount 1, got ${String(latestDebit?.amount)}`);
      assert(latestDebit?.direction === "DEBIT", `Expected debit direction DEBIT, got ${String(latestDebit?.direction)}`);
    }

    console.log("Credit regression tests passed.");
  } finally {
    for (const walletAddress of cleanupWallets) {
      await prisma.accessNonce.deleteMany({ where: { signer: walletAddress } });
      await prisma.creditLedger.deleteMany({ where: { walletAddress } });
      try {
        await prisma.gateAccessEvent.deleteMany({ where: { signer: walletAddress } });
      } catch {
        // Table may not exist before migration.
      }
      await prisma.creditBalance.deleteMany({ where: { walletAddress } });
    }

    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("Credit regression tests failed.");
  console.error(error);
  process.exitCode = 1;
});
