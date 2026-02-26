import { privateKeyToAccount } from "viem/accounts";

import { prisma, expireFulfillmentHolds } from "../lib/db";
import { GhostFulfillmentConsumer } from "../sdks/node/fulfillment";

const DEFAULT_BASE_URL = "http://localhost:3000";
const BOOSKI_AGENT_ID = "18755";
const BOOSKI_SERVICE_SLUG = "agent-18755";
const BOOSKI_ALPHA_BASE_PATH = "/api/fulfillment-alpha/booski";
const BOOSKI_ALPHA_CANARY_PATH = "/canary";
const BOOSKI_ALPHA_ASK_PATH = "/ask";
const DEFAULT_COST = 1;

type ExecuteSummary = {
  ticketId: string;
  ticketStatus: number;
  merchantStatus: number | null;
  merchantUrl: string | null;
  captureDisposition: string | null;
  holdState: string | null;
  credits: string | null;
  heldCredits: string | null;
  ledgerReasons: string[];
  attempts: string[];
};

const jsonFetch = async (url: string): Promise<{ status: number; bodyText: string; bodyJson: unknown | null }> => {
  const response = await fetch(url, { cache: "no-store" });
  const bodyText = await response.text();
  let bodyJson: unknown | null = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return { status: response.status, bodyText, bodyJson };
};

const parseObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const requireHexPrivateKey = (value: string | undefined | null, name: string): `0x${string}` => {
  const trimmed = value?.trim();
  if (!trimmed || !/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return trimmed as `0x${string}`;
};

const getEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const ensureLocalAlphaCanary = async (baseUrl: string): Promise<void> => {
  const canaryUrl = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_CANARY_PATH}`;
  const result = await jsonFetch(canaryUrl);
  if (result.status !== 200) {
    throw new Error(`Local alpha canary returned HTTP ${result.status} at ${canaryUrl}`);
  }
  const body = parseObject(result.bodyJson);
  if (!body || body.ghostgate !== "ready" || body.service !== BOOSKI_SERVICE_SLUG) {
    throw new Error(`Local alpha canary contract mismatch at ${canaryUrl}. Received: ${result.bodyText}`);
  }
};

const ensureAlphaMerchantRouteConfigured = async (baseUrl: string): Promise<void> => {
  const askUrl = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_ASK_PATH}`;
  const response = await fetch(askUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ prompt: "config-check" }),
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const body = parseObject(payload);
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : null;
  if (errorCode === "FULFILLMENT_ALPHA_NOT_CONFIGURED") {
    throw new Error(
      "Local alpha merchant route is not configured. Set GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY in .env.local and restart npm run dev.",
    );
  }
};

const ensureBooskiLocalAlphaGatewaySetup = async (input: {
  baseUrl: string;
  delegatedSignerAddress: string;
  consumerWalletAddress: string;
}): Promise<void> => {
  await prisma.servicePricing.upsert({
    where: { service: BOOSKI_SERVICE_SLUG },
    create: { service: BOOSKI_SERVICE_SLUG, cost: DEFAULT_COST, isActive: true },
    update: { cost: DEFAULT_COST, isActive: true },
  });

  const gateway = await prisma.agentGatewayConfig.findUnique({
    where: { agentId: BOOSKI_AGENT_ID },
    select: { id: true, ownerAddress: true, serviceSlug: true },
  });
  if (!gateway) {
    throw new Error(`AgentGatewayConfig for agentId=${BOOSKI_AGENT_ID} not found.`);
  }

  const now = new Date();
  await prisma.agentGatewayConfig.update({
    where: { agentId: BOOSKI_AGENT_ID },
    data: {
      endpointUrl: `${input.baseUrl}${BOOSKI_ALPHA_BASE_PATH}`,
      canaryPath: BOOSKI_ALPHA_CANARY_PATH,
      readinessStatus: "LIVE",
      lastCanaryCheckedAt: now,
      lastCanaryPassedAt: now,
      lastCanaryStatusCode: 200,
      lastCanaryLatencyMs: 1,
      lastCanaryError: null,
    },
  });

  const existingActive = await prisma.agentGatewayDelegatedSigner.findFirst({
    where: {
      gatewayConfigId: gateway.id,
      signerAddress: input.delegatedSignerAddress,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (!existingActive) {
    const activeCount = await prisma.agentGatewayDelegatedSigner.count({
      where: { gatewayConfigId: gateway.id, status: "ACTIVE" },
    });
    if (activeCount >= 2) {
      throw new Error(
        `Active delegated signer cap reached (${activeCount}/2). Revoke one before running alpha execute test.`,
      );
    }
    await prisma.agentGatewayDelegatedSigner.create({
      data: {
        gatewayConfigId: gateway.id,
        ownerAddress: gateway.ownerAddress.toLowerCase(),
        signerAddress: input.delegatedSignerAddress,
        status: "ACTIVE",
        label: "phase9-alpha-local-test",
      },
    });
  }

  await expireFulfillmentHolds({ limit: 100 });

  const activeHeld = await prisma.fulfillmentHold.findFirst({
    where: {
      walletAddress: input.consumerWalletAddress,
      serviceSlug: BOOSKI_SERVICE_SLUG,
      state: "HELD",
    },
    select: { id: true, ticketId: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (activeHeld) {
    throw new Error(
      `Active HELD ticket still exists for ${BOOSKI_SERVICE_SLUG} (${activeHeld.ticketId}) expiring ${activeHeld.expiresAt.toISOString()}. Wait for expiry or sweep again.`,
    );
  }
};

const summarizeTicketExecution = async (ticketId: string, walletAddress: string): Promise<ExecuteSummary> => {
  const hold = await prisma.fulfillmentHold.findUnique({
    where: { ticketId },
    select: {
      state: true,
      walletAddress: true,
      cost: true,
    },
  });

  const balance = await prisma.creditBalance.findUnique({
    where: { walletAddress },
    select: { credits: true, heldCredits: true },
  });

  const ledgerRows = await prisma.creditLedger.findMany({
    where: {
      metadata: { path: ["ticketId"], equals: ticketId },
    },
    orderBy: { createdAt: "asc" },
    select: { reason: true },
  });

  const attempts = await prisma.fulfillmentCaptureAttempt.findMany({
    where: { ticketId },
    orderBy: { receivedAt: "asc" },
    select: { captureDisposition: true },
  });

  return {
    ticketId,
    ticketStatus: 0,
    merchantStatus: null,
    merchantUrl: null,
    captureDisposition: null,
    holdState: hold?.state ?? null,
    credits: balance ? String(balance.credits) : null,
    heldCredits: balance ? String(balance.heldCredits) : null,
    ledgerReasons: ledgerRows.map((row) => row.reason),
    attempts: attempts.map((row) => row.captureDisposition ?? "UNKNOWN"),
  };
};

async function main() {
  const baseUrl = (getEnv("FULFILLMENT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const consumerPk = requireHexPrivateKey(getEnv("FULFILLMENT_CONSUMER_PRIVATE_KEY"), "FULFILLMENT_CONSUMER_PRIVATE_KEY");
  const delegatedPk = requireHexPrivateKey(
    getEnv("GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY") ??
      getEnv("PHASE7_MERCHANT_DELEGATED_PRIVATE_KEY") ??
      getEnv("PHASE9_MERCHANT_DELEGATED_PRIVATE_KEY"),
    "GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY (or PHASE7/PHASE9 fallback)",
  );

  const consumerWallet = privateKeyToAccount(consumerPk).address.toLowerCase();
  const delegatedSigner = privateKeyToAccount(delegatedPk).address.toLowerCase();

  await ensureLocalAlphaCanary(baseUrl);
  await ensureAlphaMerchantRouteConfigured(baseUrl);
  await ensureBooskiLocalAlphaGatewaySetup({
    baseUrl,
    delegatedSignerAddress: delegatedSigner,
    consumerWalletAddress: consumerWallet,
  });

  const consumer = new GhostFulfillmentConsumer({
    baseUrl,
    privateKey: consumerPk,
    defaultServiceSlug: BOOSKI_SERVICE_SLUG,
  });

  const executeResult = await consumer.execute({
    serviceSlug: BOOSKI_SERVICE_SLUG,
    method: "POST",
    path: BOOSKI_ALPHA_ASK_PATH,
    query: { mode: "consumer" },
    cost: DEFAULT_COST,
    body: {
      prompt: "phase9 alpha execute smoke",
    },
  });

  const ticketPayload = parseObject(executeResult.ticket.payload);
  const merchantBody = parseObject(executeResult.merchant.bodyJson);
  const fulfillment = parseObject(merchantBody?.fulfillment);
  const capturePayload = parseObject(fulfillment?.capturePayload);
  const captureDisposition =
    typeof capturePayload?.captureDisposition === "string" ? capturePayload.captureDisposition : null;

  if (!executeResult.ticket.ok) {
    throw new Error(
      `Ticket request failed (HTTP ${executeResult.ticket.status}): ${JSON.stringify(executeResult.ticket.payload)}`,
    );
  }
  if (executeResult.merchant.status !== 200) {
    throw new Error(
      `Merchant alpha route failed (HTTP ${executeResult.merchant.status}): ${executeResult.merchant.bodyText ?? "<empty>"}`,
    );
  }
  if (captureDisposition !== "CAPTURED") {
    throw new Error(
      `Expected captureDisposition=CAPTURED, received ${captureDisposition ?? "null"}: ${JSON.stringify(capturePayload)}`,
    );
  }

  const ticketId = executeResult.ticket.ticketId;
  if (!ticketId) {
    throw new Error(`Ticket response missing ticketId: ${JSON.stringify(ticketPayload)}`);
  }

  const summary = await summarizeTicketExecution(ticketId, consumerWallet);
  summary.ticketStatus = executeResult.ticket.status;
  summary.merchantStatus = executeResult.merchant.status;
  summary.merchantUrl = executeResult.merchant.url;
  summary.captureDisposition = captureDisposition;

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        consumerWallet,
        delegatedSigner,
        execute: {
          ticketStatus: executeResult.ticket.status,
          merchantStatus: executeResult.merchant.status,
          merchantUrl: executeResult.merchant.url,
          ticketId,
          captureDisposition,
        },
        db: {
          holdState: summary.holdState,
          credits: summary.credits,
          heldCredits: summary.heldCredits,
          attempts: summary.attempts,
          ledgerReasons: summary.ledgerReasons,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
