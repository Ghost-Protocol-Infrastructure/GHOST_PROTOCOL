import { config as loadEnv } from "dotenv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NextRequest } from "next/server";
import { X402_DEMO_SERVICE } from "../lib/x402-interop";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";
process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS = "true";
process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE = "false";
process.env.GHOST_REQUEST_CREDIT_COST = "1";
process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS = "true";
process.env.GHOST_GATE_X402_ENABLED = "false";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const decodeBase64Json = (value: string | null): unknown | null => {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
};

const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const run = async (): Promise<void> => {
  const { GET: pricingGet } = await import("../app/api/pricing/route");
  const { POST: gatePost } = await import("../app/api/gate/[...slug]/route");
  const { prisma, updateUserCredits, getUserCredits } = await import("../lib/db");

  const account = privateKeyToAccount(generatePrivateKey());
  const signer = account.address;
  const signerKey = signer.toLowerCase();

  try {
    await updateUserCredits(signer, 1n);

    const pricingReq = new NextRequest(`http://localhost/api/pricing?service=${encodeURIComponent(X402_DEMO_SERVICE)}`, {
      method: "GET",
    });
    const pricingRes = await pricingGet(pricingReq);
    const pricingBody = (await pricingRes.json()) as Record<string, unknown>;

    assert(pricingRes.status === 200, `Expected pricing 200, got ${pricingRes.status}`);
    assert(pricingBody.x402CompatibilityEnabled === true, "Expected x402CompatibilityEnabled=true for x402-demo.");
    assert(
      pricingBody.x402Scheme === "ghost-eip712-credit-v1",
      `Expected x402Scheme ghost-eip712-credit-v1, got ${String(pricingBody.x402Scheme)}`,
    );

    const missingAuthReq = new NextRequest(`http://localhost/api/gate/${X402_DEMO_SERVICE}`, { method: "POST" });
    const missingAuthRes = await gatePost(missingAuthReq, { params: { slug: [X402_DEMO_SERVICE] } });
    const paymentRequiredHeader = missingAuthRes.headers.get("payment-required");
    const paymentRequiredEnvelope = decodeBase64Json(paymentRequiredHeader) as Record<string, unknown> | null;

    assert(missingAuthRes.status === 402, `Expected missing-auth demo status 402, got ${missingAuthRes.status}`);
    assert(
      typeof paymentRequiredHeader === "string" && paymentRequiredHeader.length > 0,
      "Expected payment-required header.",
    );
    assert(paymentRequiredEnvelope?.x402Version === 2, "Expected x402Version=2 in payment-required envelope.");

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const nonce = `x402-demo-${Date.now()}`;
    const payload = {
      service: X402_DEMO_SERVICE,
      timestamp: timestamp.toString(),
      nonce,
    };

    const signature = await account.signTypedData({
      domain: {
        name: "GhostGate",
        version: "1",
        chainId: 8453,
      },
      types: {
        Access: [
          { name: "service", type: "string" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "string" },
        ],
      },
      primaryType: "Access",
      message: {
        service: X402_DEMO_SERVICE,
        timestamp,
        nonce,
      },
    });

    const successReq = new NextRequest(`http://localhost/api/gate/${X402_DEMO_SERVICE}`, {
      method: "POST",
      headers: {
        "payment-signature": encodeBase64Json({
          x402Version: 2,
          scheme: "ghost-eip712-credit-v1",
          network: "eip155:8453",
          payload,
          signature,
        }),
      },
    });
    const successRes = await gatePost(successReq, { params: { slug: [X402_DEMO_SERVICE] } });
    const successBody = (await successRes.json()) as Record<string, unknown>;
    const paymentResponseHeader = successRes.headers.get("payment-response");
    const paymentResponseEnvelope = decodeBase64Json(paymentResponseHeader) as Record<string, unknown> | null;
    const remainingCredits = await getUserCredits(signer);

    assert(successRes.status === 200, `Expected x402 demo success 200, got ${successRes.status}`);
    assert(successBody.ok === true, "Expected demo body ok=true.");
    assert(successBody.authorized === true, "Expected demo body authorized=true.");
    assert(successBody.mode === "x402-demo", `Expected demo mode x402-demo, got ${String(successBody.mode)}`);
    assert(
      successBody.authSource === "x402-payment-signature",
      `Expected authSource x402-payment-signature, got ${String(successBody.authSource)}`,
    );
    assert(
      typeof paymentResponseHeader === "string" && paymentResponseHeader.length > 0,
      "Expected payment-response header.",
    );
    assert(
      paymentResponseEnvelope?.scheme === "ghost-eip712-credit-v1",
      `Expected x402 payment-response scheme match, got ${String(paymentResponseEnvelope?.scheme)}`,
    );
    assert(remainingCredits === 0n, `Expected demo call to consume the last credit, got ${remainingCredits.toString()}`);

    console.log("x402 demo verification passed.");
  } finally {
    await prisma.merchantEarning.deleteMany({ where: { walletAddress: signerKey } });
    await prisma.accessNonce.deleteMany({ where: { signer: signerKey, service: X402_DEMO_SERVICE } });
    await prisma.creditLedger.deleteMany({ where: { walletAddress: signerKey } });
    try {
      await prisma.gateAccessEvent.deleteMany({ where: { signer: signerKey, service: X402_DEMO_SERVICE } });
    } catch {
      // Table may not exist in some local states.
    }
    await prisma.creditBalance.deleteMany({ where: { walletAddress: signerKey } });
    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("x402 demo verification failed.");
  console.error(error);
  process.exitCode = 1;
});
