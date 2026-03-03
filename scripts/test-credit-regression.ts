import { config as loadEnv } from "dotenv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { buildGateSettlementId, calculateSettlementAmounts } from "../lib/merchant-settlement";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";
process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS = "true";
process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE = "false";
process.env.GHOST_REQUEST_CREDIT_COST = "1";
process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS = "true";

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

type GateResponseBody = Record<string, unknown>;

const createLiveGatewayConfig = async (
  prisma: PrismaClient,
  input: { agentId: string; serviceSlug: string; ownerAddress: string },
): Promise<void> => {
  const ownerAddress = input.ownerAddress.toLowerCase();
  const agentAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

  await prisma.agent.create({
    data: {
      address: agentAddress,
      agentId: input.agentId,
      name: `Regression Agent ${input.agentId}`,
      creator: ownerAddress,
      owner: ownerAddress,
    },
  });

  await prisma.agentGatewayConfig.create({
    data: {
      agentId: input.agentId,
      ownerAddress,
      serviceSlug: input.serviceSlug,
      endpointUrl: `https://example.com/${input.serviceSlug}`,
      readinessStatus: "LIVE",
    },
  });
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
): Promise<{ status: number; body: GateResponseBody }> => {
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
  const body = (await res.json()) as GateResponseBody;
  return { status: res.status, body };
};

const run = async (): Promise<void> => {
  const { GET: gateGet } = await import("../app/api/gate/[...slug]/route");
  const { prisma, updateUserCredits, getUserCredits, consumeUserCreditsForGate } = await import("../lib/db");

  const cleanupWallets = new Set<string>();
  const cleanupAgentIds = new Set<string>();

  try {
    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 3n);

      const agentId = `${Date.now()}01`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

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

      const firstRequestId = `reg-replay-1-${Date.now()}`;
      const first = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: firstRequestId,
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
      const expectedAmounts = calculateSettlementAmounts({ grossCredits: 1n });
      const earnings = await prisma.merchantEarning.findMany({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
        orderBy: { createdAt: "asc" },
        select: {
          merchantOwnerAddress: true,
          sourceId: true,
          grossCredits: true,
          grossWei: true,
          feeWei: true,
          netWei: true,
        },
      });

      assert(first.status === 200, `Expected first gate call 200, got ${first.status}`);
      assert(second.status === 409, `Expected replay gate call 409, got ${second.status}`);
      assert(balanceAfter === 2n, `Expected balance 2 after replay test, got ${balanceAfter.toString()}`);
      assert(nonceCount === 1, `Expected nonce count 1, got ${nonceCount}`);
      assert(gateDebitCount === 1, `Expected one gate debit row, got ${gateDebitCount}`);
      assert(earnings.length === 1, `Expected one merchant earning row, got ${earnings.length}`);
      assert(
        earnings[0]?.merchantOwnerAddress === ownerAddress,
        `Expected merchant owner ${ownerAddress}, got ${earnings[0]?.merchantOwnerAddress ?? "missing"}`,
      );
      assert(
        earnings[0]?.sourceId === `${signerKey}:${firstRequestId}`,
        `Expected gate sourceId ${signerKey}:${firstRequestId}, got ${earnings[0]?.sourceId ?? "missing"}`,
      );
      assert(earnings[0]?.grossCredits === 1, `Expected grossCredits 1, got ${String(earnings[0]?.grossCredits)}`);
      assert(
        earnings[0]?.grossWei === expectedAmounts.grossWei,
        `Expected grossWei ${expectedAmounts.grossWei}, got ${String(earnings[0]?.grossWei)}`,
      );
      assert(
        earnings[0]?.feeWei === expectedAmounts.feeWei,
        `Expected feeWei ${expectedAmounts.feeWei}, got ${String(earnings[0]?.feeWei)}`,
      );
      assert(
        earnings[0]?.netWei === expectedAmounts.netWei,
        `Expected netWei ${expectedAmounts.netWei}, got ${String(earnings[0]?.netWei)}`,
      );
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 3n);

      const agentId = `${Date.now()}02`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

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
      const earnings = await prisma.merchantEarning.count({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
      });

      assert(res.status === 200, `Expected cost test status 200, got ${res.status}`);
      assert(res.body?.cost === "1", `Expected cost '1', got ${String(res.body?.cost)}`);
      assert(
        res.body?.costSource === "default",
        `Expected costSource 'default', got ${String(res.body?.costSource)}`,
      );
      assert(latestDebit?.amount === 1, `Expected ledger debit amount 1, got ${String(latestDebit?.amount)}`);
      assert(latestDebit?.direction === "DEBIT", `Expected debit direction DEBIT, got ${String(latestDebit?.direction)}`);
      assert(earnings === 1, `Expected one merchant earning for cost flow, got ${earnings}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 0n);

      const agentId = `${Date.now()}03`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const nonce = `reg-insufficient-${Date.now()}`;
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
        requestId: `reg-insufficient-1-${Date.now()}`,
        requestScopedCost: "999",
      });

      const earnings = await prisma.merchantEarning.count({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
      });

      assert(res.status === 402, `Expected insufficient credits status 402, got ${res.status}`);
      assert(earnings === 0, `Expected no merchant earnings for insufficient credits, got ${earnings}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 2n);

      const agentId = `${Date.now()}04`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const requestId = `reg-rollback-${Date.now()}`;
      const settlementId = buildGateSettlementId({ walletAddress: signer, requestId });
      const amounts = calculateSettlementAmounts({ grossCredits: 1n });
      await prisma.merchantEarning.create({
        data: {
          settlementId,
          walletAddress: signerKey,
          merchantOwnerAddress: ownerAddress,
          agentId,
          serviceSlug: service,
          sourceType: "GATE_DEBIT",
          sourceId: `${signerKey}:${requestId}`,
          grossCredits: 1,
          grossWei: amounts.grossWei,
          feeWei: amounts.feeWei,
          netWei: amounts.netWei,
        },
      });

      const nonce = `reg-rollback-nonce-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const beforeBalance = await getUserCredits(signer);

      const result = await consumeUserCreditsForGate(signer, 1n, {
        service,
        nonce,
        payloadTimestamp: timestamp,
        requestId,
        merchantOwnerAddress: ownerAddress,
        agentId,
        enforceNonceUniqueness: true,
      });

      const balanceAfter = await getUserCredits(signer);
      const nonceCount = await prisma.accessNonce.count({
        where: { signer: signerKey, service, nonce },
      });
      const gateDebitCount = await prisma.creditLedger.count({
        where: { walletAddress: signerKey, reason: "gate_debit", requestId },
      });

      assert(result.status === "replay", `Expected duplicate earning source to return replay, got ${result.status}`);
      assert(balanceAfter === beforeBalance, `Expected balance rollback to ${beforeBalance}, got ${balanceAfter}`);
      assert(nonceCount === 0, `Expected nonce rollback on earning conflict, got ${nonceCount}`);
      assert(gateDebitCount === 0, `Expected no gate ledger debit on earning conflict, got ${gateDebitCount}`);
    }

    console.log("Credit regression tests passed.");
  } finally {
    for (const walletAddress of cleanupWallets) {
      await prisma.merchantEarning.deleteMany({ where: { walletAddress } });
      await prisma.accessNonce.deleteMany({ where: { signer: walletAddress } });
      await prisma.creditLedger.deleteMany({ where: { walletAddress } });
      try {
        await prisma.gateAccessEvent.deleteMany({ where: { signer: walletAddress } });
      } catch {
        // Table may not exist before migration.
      }
      await prisma.creditBalance.deleteMany({ where: { walletAddress } });
    }

    for (const agentId of cleanupAgentIds) {
      await prisma.agent.deleteMany({ where: { agentId } });
    }

    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("Credit regression tests failed.");
  console.error(error);
  process.exitCode = 1;
});
