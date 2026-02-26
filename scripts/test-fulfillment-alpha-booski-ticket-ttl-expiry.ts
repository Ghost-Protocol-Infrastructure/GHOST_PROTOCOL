import { privateKeyToAccount } from "viem/accounts";

import { prisma, expireFulfillmentHolds } from "../lib/db";
import { GhostFulfillmentConsumer, fulfillmentTicketHeadersToRecord } from "../sdks/node/fulfillment";

const DEFAULT_BASE_URL = "http://localhost:3000";
const BOOSKI_AGENT_ID = "18755";
const BOOSKI_SERVICE_SLUG = "agent-18755";
const BOOSKI_ALPHA_BASE_PATH = "/api/fulfillment-alpha/booski";
const BOOSKI_ALPHA_CANARY_PATH = "/canary";
const BOOSKI_ALPHA_ASK_PATH = "/ask";
const DEFAULT_COST = 1;
const TTL_GRACE_MS = 2_000;

type JsonResponse = {
  status: number;
  bodyText: string;
  bodyJson: unknown | null;
};

const parseObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requireHexPrivateKey = (value: string | undefined | null, name: string): `0x${string}` => {
  const trimmed = value?.trim();
  if (!trimmed || !/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return trimmed as `0x${string}`;
};

const fetchJsonLike = async (url: string, init?: RequestInit): Promise<JsonResponse> => {
  const response = await fetch(url, { cache: "no-store", ...init });
  const bodyText = await response.text();
  let bodyJson: unknown | null = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return { status: response.status, bodyText, bodyJson };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ensureAlphaCanaryAndRoute = async (baseUrl: string): Promise<void> => {
  const canaryUrl = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_CANARY_PATH}`;
  const canary = await fetchJsonLike(canaryUrl);
  const canaryBody = parseObject(canary.bodyJson);
  if (canary.status !== 200 || !canaryBody || canaryBody.ghostgate !== "ready" || canaryBody.service !== BOOSKI_SERVICE_SLUG) {
    throw new Error(`Alpha canary contract check failed at ${canaryUrl}: HTTP ${canary.status} ${canary.bodyText}`);
  }

  const askProbe = await fetchJsonLike(`${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_ASK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ prompt: "probe" }),
  });
  const probeBody = parseObject(askProbe.bodyJson);
  const errorCode = typeof probeBody?.errorCode === "string" ? probeBody.errorCode : null;
  if (errorCode === "FULFILLMENT_ALPHA_NOT_CONFIGURED") {
    throw new Error(
      "Alpha merchant route is not configured. Set GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY in .env.local and restart npm run dev.",
    );
  }
};

const ensureGatewayReadyForAlpha = async (baseUrl: string): Promise<void> => {
  const now = new Date();
  await prisma.servicePricing.upsert({
    where: { service: BOOSKI_SERVICE_SLUG },
    create: { service: BOOSKI_SERVICE_SLUG, cost: DEFAULT_COST, isActive: true },
    update: { cost: DEFAULT_COST, isActive: true },
  });

  await prisma.agentGatewayConfig.update({
    where: { agentId: BOOSKI_AGENT_ID },
    data: {
      endpointUrl: `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}`,
      canaryPath: BOOSKI_ALPHA_CANARY_PATH,
      readinessStatus: "LIVE",
      lastCanaryCheckedAt: now,
      lastCanaryPassedAt: now,
      lastCanaryStatusCode: 200,
      lastCanaryLatencyMs: 1,
      lastCanaryError: null,
    },
  });
};

const ensureNoActiveHeldForService = async (walletAddress: string): Promise<void> => {
  await expireFulfillmentHolds({ limit: 100 });
  const held = await prisma.fulfillmentHold.findFirst({
    where: {
      walletAddress,
      serviceSlug: BOOSKI_SERVICE_SLUG,
      state: "HELD",
    },
    orderBy: { createdAt: "desc" },
    select: { ticketId: true, expiresAt: true },
  });
  if (held) {
    throw new Error(
      `Active HELD ticket exists for ${BOOSKI_SERVICE_SLUG}: ${held.ticketId} (expires ${held.expiresAt.toISOString()}). Clear it before running TTL expiry smoke.`,
    );
  }
};

const cleanupTicketIfHeld = async (ticketId: string | null): Promise<void> => {
  if (!ticketId) return;
  const hold = await prisma.fulfillmentHold.findUnique({
    where: { ticketId },
    select: { state: true },
  });
  if (!hold || hold.state !== "HELD") return;
  await prisma.fulfillmentHold.update({
    where: { ticketId },
    data: { expiresAt: new Date(Date.now() - 5_000) },
  });
  await expireFulfillmentHolds({ limit: 100 });
};

async function main() {
  const baseUrl = (getEnv("FULFILLMENT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const consumerPk = requireHexPrivateKey(getEnv("FULFILLMENT_CONSUMER_PRIVATE_KEY"), "FULFILLMENT_CONSUMER_PRIVATE_KEY");
  const consumerWallet = privateKeyToAccount(consumerPk).address.toLowerCase();
  let ticketIdForCleanup: string | null = null;

  await ensureAlphaCanaryAndRoute(baseUrl);
  await ensureGatewayReadyForAlpha(baseUrl);
  await ensureNoActiveHeldForService(consumerWallet);

  const consumer = new GhostFulfillmentConsumer({
    baseUrl,
    privateKey: consumerPk,
    defaultServiceSlug: BOOSKI_SERVICE_SLUG,
  });

  const body = { prompt: "phase9 ticket ttl expiry smoke" };

  try {
    const ticketRes = await consumer.requestTicket({
      serviceSlug: BOOSKI_SERVICE_SLUG,
      method: "POST",
      path: BOOSKI_ALPHA_ASK_PATH,
      query: { mode: "consumer" },
      cost: DEFAULT_COST,
      body,
    });

    if (!ticketRes.ok || !ticketRes.ticketId || !ticketRes.ticket) {
      throw new Error(`Ticket issuance failed: HTTP ${ticketRes.status} ${JSON.stringify(ticketRes.payload)}`);
    }

    const ticketId = ticketRes.ticketId;
    ticketIdForCleanup = ticketId;
    const payloadObj = parseObject(ticketRes.payload);
    const expiresAtRaw = typeof payloadObj?.expiresAt === "string" ? payloadObj.expiresAt : null;
    if (!expiresAtRaw) throw new Error("Ticket response missing expiresAt.");
    const expiresAtMs = Date.parse(expiresAtRaw);
    if (!Number.isFinite(expiresAtMs)) throw new Error(`Invalid expiresAt in ticket response: ${expiresAtRaw}`);

    const headers = fulfillmentTicketHeadersToRecord({
      ticketId,
      ticket: ticketRes.ticket,
      clientRequestId: ticketRes.clientRequestId,
    });

    const waitMs = Math.max(0, expiresAtMs + TTL_GRACE_MS - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const merchantUrl = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_ASK_PATH}?mode=consumer`;
    const expired = await fetchJsonLike(merchantUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

    const expiredBody = parseObject(expired.bodyJson);
    const errorCode = typeof expiredBody?.errorCode === "string" ? expiredBody.errorCode : null;
    if (expired.status !== 409 || errorCode !== "FULFILLMENT_TICKET_EXPIRED") {
      throw new Error(
        `Expected 409/FULFILLMENT_TICKET_EXPIRED, got ${expired.status}/${errorCode ?? "null"} :: ${expired.bodyText}`,
      );
    }

    await expireFulfillmentHolds({ limit: 100 });

    const hold = await prisma.fulfillmentHold.findUnique({
      where: { ticketId },
      select: { state: true, releaseReason: true },
    });
    if (!hold) throw new Error(`Hold not found after expiry test for ${ticketId}`);
    if (hold.state !== "EXPIRED" || hold.releaseReason !== "TTL_EXPIRED") {
      throw new Error(`Expected cleanup sweep to expire hold. Got state=${hold.state} reason=${hold.releaseReason}`);
    }
    ticketIdForCleanup = null;

    const ledgerReasons = (
      await prisma.creditLedger.findMany({
        where: { metadata: { path: ["ticketId"], equals: ticketId } },
        orderBy: { createdAt: "asc" },
        select: { reason: true },
      })
    ).map((row) => row.reason);

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          ticketId,
          waits: { untilExpiryMs: waitMs },
          checks: {
            merchantExpired: {
              status: expired.status,
              errorCode,
            },
          },
          cleanup: {
            holdState: hold.state,
            releaseReason: hold.releaseReason,
            ledgerReasons,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanupTicketIfHeld(ticketIdForCleanup);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

