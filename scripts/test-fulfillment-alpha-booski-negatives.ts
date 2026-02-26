import { privateKeyToAccount } from "viem/accounts";

import { prisma, expireFulfillmentHolds } from "../lib/db";
import {
  GhostFulfillmentConsumer,
  fulfillmentTicketHeadersToRecord,
} from "../sdks/node/fulfillment";

const DEFAULT_BASE_URL = "http://localhost:3000";
const BOOSKI_AGENT_ID = "18755";
const BOOSKI_SERVICE_SLUG = "agent-18755";
const BOOSKI_ALPHA_BASE_PATH = "/api/fulfillment-alpha/booski";
const BOOSKI_ALPHA_CANARY_PATH = "/canary";
const BOOSKI_ALPHA_ASK_PATH = "/ask";
const DEFAULT_COST = 1;

type JsonResponse = {
  status: number;
  bodyText: string;
  bodyJson: unknown | null;
  headers: Headers;
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

const fetchJsonLike = async (
  url: string,
  init?: RequestInit,
): Promise<JsonResponse> => {
  const response = await fetch(url, { cache: "no-store", ...init });
  const bodyText = await response.text();
  let bodyJson: unknown | null = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return { status: response.status, bodyText, bodyJson, headers: response.headers };
};

const assertExpectedError = (
  result: JsonResponse,
  expectedStatus: number | number[],
  expectedErrorCode: string | string[],
  label: string,
): void => {
  const body = parseObject(result.bodyJson);
  const actualCode = typeof body?.errorCode === "string" ? body.errorCode : null;
  const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const allowedErrorCodes = Array.isArray(expectedErrorCode) ? expectedErrorCode : [expectedErrorCode];
  if (!allowed.includes(result.status) || !allowedErrorCodes.includes(actualCode ?? "")) {
    throw new Error(
      `${label} expected ${allowed.join("|")}/${allowedErrorCodes.join("|")}, got ${result.status}/${actualCode ?? "null"} :: ${result.bodyText}`,
    );
  }
};

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
    select: { id: true, ticketId: true, expiresAt: true },
  });
  if (held) {
    throw new Error(
      `Active HELD ticket exists for ${BOOSKI_SERVICE_SLUG}: ${held.ticketId} (expires ${held.expiresAt.toISOString()}). Clear it before running the negative smoke script.`,
    );
  }
};

const forceExpireTicketForTest = async (ticketId: string): Promise<void> => {
  await prisma.fulfillmentHold.update({
    where: { ticketId },
    data: {
      expiresAt: new Date(Date.now() - 5_000),
    },
  });
};

const sweepAndVerifyTicketExpired = async (ticketId: string): Promise<void> => {
  await expireFulfillmentHolds({ limit: 100 });
  const hold = await prisma.fulfillmentHold.findUnique({
    where: { ticketId },
    select: { state: true, releaseReason: true },
  });
  if (!hold) throw new Error(`Test hold not found during cleanup (${ticketId})`);
  if (hold.state !== "EXPIRED" || hold.releaseReason !== "TTL_EXPIRED") {
    throw new Error(`Cleanup sweep did not expire hold ${ticketId}. State=${hold.state} reason=${hold.releaseReason}`);
  }
};

const cleanupTicketIfHeld = async (ticketId: string | null): Promise<void> => {
  if (!ticketId) return;
  const hold = await prisma.fulfillmentHold.findUnique({
    where: { ticketId },
    select: { state: true },
  });
  if (!hold || hold.state !== "HELD") return;
  await forceExpireTicketForTest(ticketId);
  await expireFulfillmentHolds({ limit: 100 });
};

async function main() {
  const baseUrl = (getEnv("FULFILLMENT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const consumerPk = requireHexPrivateKey(getEnv("FULFILLMENT_CONSUMER_PRIVATE_KEY"), "FULFILLMENT_CONSUMER_PRIVATE_KEY");
  const consumerWallet = privateKeyToAccount(consumerPk).address.toLowerCase();

  await ensureAlphaCanaryAndRoute(baseUrl);
  await ensureGatewayReadyForAlpha(baseUrl);
  await ensureNoActiveHeldForService(consumerWallet);

  const consumer = new GhostFulfillmentConsumer({
    baseUrl,
    privateKey: consumerPk,
    defaultServiceSlug: BOOSKI_SERVICE_SLUG,
  });

  const body = { prompt: "phase9 negative smoke" };
  let ticketIdForCleanup: string | null = null;

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
    const ticketHeaders = fulfillmentTicketHeadersToRecord({
      ticketId,
      ticket: ticketRes.ticket,
      clientRequestId: ticketRes.clientRequestId,
    });

    const urlOk = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_ASK_PATH}?mode=consumer`;
    const urlMismatch = `${baseUrl}${BOOSKI_ALPHA_BASE_PATH}${BOOSKI_ALPHA_ASK_PATH}?mode=attacker`;

    const missingHeaders = await fetchJsonLike(urlOk, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    assertExpectedError(missingHeaders, 401, "FULFILLMENT_TICKET_MISSING", "missingHeaders");

    const tamperedHeaders = { ...ticketHeaders };
    const sigKey = Object.keys(tamperedHeaders).find((k) => k.toLowerCase() === "x-ghost-fulfillment-ticket-sig");
    if (!sigKey) throw new Error("Ticket headers missing x-ghost-fulfillment-ticket-sig");
    const sig = tamperedHeaders[sigKey];
    const mutateIndex = Math.min(Math.max(10, 2), sig.length - 4);
    const currentNibble = sig[mutateIndex];
    const replacementNibble = currentNibble === "a" ? "b" : "a";
    tamperedHeaders[sigKey] = `${sig.slice(0, mutateIndex)}${replacementNibble}${sig.slice(mutateIndex + 1)}`;
    const invalidSignature = await fetchJsonLike(urlOk, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...tamperedHeaders,
      },
      body: JSON.stringify(body),
    });
    assertExpectedError(invalidSignature, [400, 401], "INVALID_FULFILLMENT_TICKET", "invalidSignature");

    const bindingMismatch = await fetchJsonLike(urlMismatch, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...ticketHeaders,
      },
      body: JSON.stringify(body),
    });
    assertExpectedError(
      bindingMismatch,
      400,
      ["FULFILLMENT_TICKET_BINDING_MISMATCH", "INVALID_FULFILLMENT_TICKET"],
      "bindingMismatch",
    );

    await forceExpireTicketForTest(ticketId);

    const expiredTicket = await fetchJsonLike(urlOk, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...ticketHeaders,
      },
      body: JSON.stringify(body),
    });
    assertExpectedError(expiredTicket, 502, "FULFILLMENT_CAPTURE_REJECTED", "expiredTicket");
    const expiredTicketBody = parseObject(expiredTicket.bodyJson);
    const nestedCapturePayload = parseObject(expiredTicketBody?.capturePayload);
    const nestedHoldErrorCode = typeof nestedCapturePayload?.errorCode === "string" ? nestedCapturePayload.errorCode : null;
    if (nestedHoldErrorCode !== "HOLD_EXPIRED") {
      throw new Error(
        `expiredTicket expected nested HOLD_EXPIRED, got ${nestedHoldErrorCode ?? "null"} :: ${expiredTicket.bodyText}`,
      );
    }

    await sweepAndVerifyTicketExpired(ticketId);
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
          checks: {
            missingHeaders: {
              status: missingHeaders.status,
              errorCode: parseObject(missingHeaders.bodyJson)?.errorCode ?? null,
            },
            invalidSignature: {
              status: invalidSignature.status,
              errorCode: parseObject(invalidSignature.bodyJson)?.errorCode ?? null,
            },
            bindingMismatch: {
              status: bindingMismatch.status,
              errorCode: parseObject(bindingMismatch.bodyJson)?.errorCode ?? null,
            },
          expiredTicket: {
            status: expiredTicket.status,
            errorCode: parseObject(expiredTicket.bodyJson)?.errorCode ?? null,
            nestedCaptureErrorCode:
              typeof parseObject(parseObject(expiredTicket.bodyJson)?.capturePayload)?.errorCode === "string"
                ? (parseObject(parseObject(expiredTicket.bodyJson)?.capturePayload)?.errorCode as string)
                : null,
          },
        },
          cleanup: {
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
