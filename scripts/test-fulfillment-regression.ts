import { config as loadEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const run = async (): Promise<void> => {
  const { prisma, createFulfillmentHold, updateUserCredits } = await import("../lib/db");
  const { GhostFulfillmentMerchant } = await import("../packages/sdk/src/fulfillment");

  const consumer = privateKeyToAccount(generatePrivateKey());
  const consumerWallet = consumer.address.toLowerCase();
  const serviceSlug = `agent-regression-${Date.now()}`;
  const ticketIdA = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const ticketIdB = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const requestNonceA = `nonce-a-${Date.now()}`;
  const requestNonceB = `nonce-b-${Date.now()}`;
  const merchantOwnerAddress = "0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe";
  const now = Date.now();

  try {
    await updateUserCredits(consumer.address, 3n);

    const firstHold = await createFulfillmentHold({
      walletAddress: consumer.address,
      serviceSlug,
      agentId: null,
      gatewayConfigId: null,
      merchantOwnerAddress,
      requestMethod: "POST",
      requestPath: "/ask",
      queryHash: `0x${"00".repeat(32)}`,
      bodyHash: `0x${"11".repeat(32)}`,
      cost: 1n,
      ticketId: ticketIdA,
      issuedAt: new Date(now - 120_000),
      expiresAt: new Date(now - 60_000),
      requestNonce: requestNonceA,
      requestAuthIssuedAtSeconds: BigInt(Math.floor((now - 120_000) / 1000)),
      walletHoldCap: 3,
    });

    assert(firstHold.status === "ok", `Expected first hold creation to succeed, got ${firstHold.status}`);

    const secondHold = await createFulfillmentHold({
      walletAddress: consumer.address,
      serviceSlug,
      agentId: null,
      gatewayConfigId: null,
      merchantOwnerAddress,
      requestMethod: "POST",
      requestPath: "/ask",
      queryHash: `0x${"00".repeat(32)}`,
      bodyHash: `0x${"22".repeat(32)}`,
      cost: 1n,
      ticketId: ticketIdB,
      issuedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      requestNonce: requestNonceB,
      requestAuthIssuedAtSeconds: BigInt(Math.floor(now / 1000)),
      walletHoldCap: 3,
    });

    assert(secondHold.status === "ok", `Expected expired prior hold to be released before issuing a new one, got ${secondHold.status}`);

    const holds = await prisma.fulfillmentHold.findMany({
      where: { walletAddress: consumerWallet, serviceSlug },
      orderBy: { createdAt: "asc" },
      select: {
        ticketId: true,
        state: true,
      },
    });

    assert(holds.length === 2, `Expected two holds for regression wallet, got ${holds.length}`);
    assert(
      holds[0]?.ticketId === ticketIdA && holds[0]?.state === "EXPIRED",
      `Expected first hold ${ticketIdA} to be EXPIRED, got ${holds[0]?.ticketId ?? "missing"} / ${holds[0]?.state ?? "missing"}`,
    );
    assert(
      holds[1]?.ticketId === ticketIdB && holds[1]?.state === "HELD",
      `Expected second hold ${ticketIdB} to remain HELD, got ${holds[1]?.ticketId ?? "missing"} / ${holds[1]?.state ?? "missing"}`,
    );

    const balance = await prisma.creditBalance.findUnique({
      where: { walletAddress: consumerWallet },
      select: { credits: true, heldCredits: true },
    });

    assert(balance?.credits === 2, `Expected credits to settle at 2 after hold rollover, got ${String(balance?.credits)}`);
    assert(balance?.heldCredits === 1, `Expected heldCredits to settle at 1 after hold rollover, got ${String(balance?.heldCredits)}`);

    const merchant = new GhostFulfillmentMerchant({
      baseUrl: "https://ghostprotocol.cc",
    });

    const signerSet = (merchant as unknown as { protocolSignerAddresses?: Set<string> }).protocolSignerAddresses;
    assert(signerSet instanceof Set, "Expected merchant SDK to initialize a default protocol signer set.");
    const protocolSignerAddresses = signerSet as Set<string>;
    assert(
      protocolSignerAddresses.has("0xf879f5e26aa52663887f97a51d3444afef8df3fc"),
      "Expected merchant SDK default protocol signer set to include the production signer address.",
    );

    console.log("Fulfillment regression tests passed.");
  } finally {
    await prisma.accessNonce.deleteMany({
      where: {
        signer: consumerWallet,
        service: `fulfillment_ticket:${serviceSlug}`,
      },
    });
    await prisma.creditLedger.deleteMany({ where: { walletAddress: consumerWallet } });
    await prisma.fulfillmentHold.deleteMany({ where: { walletAddress: consumerWallet, serviceSlug } });
    await prisma.creditBalance.deleteMany({ where: { walletAddress: consumerWallet } });
    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("Fulfillment regression tests failed.");
  console.error(error);
  process.exitCode = 1;
});
