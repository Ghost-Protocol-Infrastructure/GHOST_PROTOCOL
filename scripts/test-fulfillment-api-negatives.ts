import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildFulfillmentDeliveryProofTypedData,
  encodeTypedPayloadBase64Url,
  normalizeFulfillmentDeliveryProofMessage,
} from "../lib/fulfillment-eip712";
import {
  GhostFulfillmentConsumer,
  fulfillmentTicketHeadersToRecord,
} from "../sdks/node/fulfillment";

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_SERVICE_SLUG = "agent-18755";
const DEFAULT_PATH = "/ask";
const DEFAULT_COST = 1;
const DEFAULT_UNAUTHORIZED_SIGNER_PRIVATE_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

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

const buildCapturePayload = async (input: {
  ticketId: `0x${string}`;
  deliveryProofId?: `0x${string}`;
  merchantPrivateKey: `0x${string}`;
  serviceSlug: string;
  statusCode?: number;
  latencyMs?: number;
}) => {
  const merchant = privateKeyToAccount(input.merchantPrivateKey);
  const message = normalizeFulfillmentDeliveryProofMessage({
    ticketId: input.ticketId,
    deliveryProofId: input.deliveryProofId ?? (`0x${randomBytes(32).toString("hex")}` as `0x${string}`),
    merchantSigner: merchant.address.toLowerCase(),
    serviceSlug: input.serviceSlug,
    completedAt: Math.floor(Date.now() / 1000),
    statusCode: input.statusCode ?? 200,
    latencyMs: input.latencyMs ?? 1,
  });
  const signature = await merchant.signTypedData(buildFulfillmentDeliveryProofTypedData(message));
  return {
    ticketId: input.ticketId,
    deliveryProof: {
      payload: encodeTypedPayloadBase64Url(message),
      signature: String(signature).toLowerCase(),
    },
    completionMeta: {
      statusCode: Number(message.statusCode),
      latencyMs: Number(message.latencyMs),
    },
    deliveryProofId: message.deliveryProofId,
  };
};

const assertExpected = (
  response: JsonResponse,
  expectedStatus: number,
  expectedErrorCode: string,
  label: string,
): void => {
  const body = parseObject(response.bodyJson);
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : null;
  if (response.status !== expectedStatus || errorCode !== expectedErrorCode) {
    throw new Error(
      `${label} expected HTTP ${expectedStatus} / ${expectedErrorCode}, got HTTP ${response.status} / ${errorCode ?? "null"} :: ${response.bodyText}`,
    );
  }
};

async function main() {
  const baseUrl = (getEnv("FULFILLMENT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const consumerPrivateKey = requireHexPrivateKey(
    getEnv("FULFILLMENT_CONSUMER_PRIVATE_KEY"),
    "FULFILLMENT_CONSUMER_PRIVATE_KEY",
  );
  const delegatedPrivateKey = requireHexPrivateKey(
    getEnv("GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY") ??
      getEnv("PHASEC_MERCHANT_DELEGATED_PRIVATE_KEY") ??
      getEnv("PHASE7_MERCHANT_DELEGATED_PRIVATE_KEY"),
    "GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY (or PHASEC/PHASE7 fallback)",
  );
  const unauthorizedPrivateKey = requireHexPrivateKey(
    getEnv("FULFILLMENT_UNAUTHORIZED_SIGNER_PRIVATE_KEY") ?? DEFAULT_UNAUTHORIZED_SIGNER_PRIVATE_KEY,
    "FULFILLMENT_UNAUTHORIZED_SIGNER_PRIVATE_KEY",
  );

  const serviceSlug = getEnv("FULFILLMENT_SERVICE_SLUG") ?? DEFAULT_SERVICE_SLUG;
  const method = "POST";
  const path = getEnv("FULFILLMENT_PATH") ?? DEFAULT_PATH;
  const query = getEnv("FULFILLMENT_QUERY") ?? "mode=consumer";
  const cost = Number.parseInt(getEnv("FULFILLMENT_COST") ?? String(DEFAULT_COST), 10);
  const requestBody = { prompt: "phase-c beta negative path coverage" };

  const consumer = new GhostFulfillmentConsumer({
    baseUrl,
    privateKey: consumerPrivateKey,
    defaultServiceSlug: serviceSlug,
  });

  const ticket = await consumer.requestTicket({
    serviceSlug,
    method,
    path,
    query,
    cost,
    body: requestBody,
  });
  if (!ticket.ok || !ticket.ticket || !ticket.ticketId) {
    throw new Error(`Ticket issuance failed: HTTP ${ticket.status} ${JSON.stringify(ticket.payload)}`);
  }
  if (!ticket.merchantTargetUrl) {
    throw new Error(`Ticket response missing merchantTargetUrl: ${JSON.stringify(ticket.payload)}`);
  }

  const captureUrl = `${baseUrl}/api/fulfillment/capture`;
  const ticketId = ticket.ticketId;

  const unauthorizedCapturePayload = await buildCapturePayload({
    ticketId,
    merchantPrivateKey: unauthorizedPrivateKey,
    serviceSlug,
  });
  const unauthorizedCapture = await fetchJsonLike(captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ticketId: unauthorizedCapturePayload.ticketId,
      deliveryProof: unauthorizedCapturePayload.deliveryProof,
      completionMeta: unauthorizedCapturePayload.completionMeta,
    }),
  });
  assertExpected(unauthorizedCapture, 403, "UNAUTHORIZED_DELEGATED_SIGNER", "unauthorizedCapture");

  const merchantHeaders = fulfillmentTicketHeadersToRecord({
    ticketId,
    ticket: ticket.ticket,
    clientRequestId: ticket.clientRequestId,
  });
  const merchantCapture = await fetchJsonLike(ticket.merchantTargetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...merchantHeaders,
    },
    body: JSON.stringify(requestBody),
  });
  if (merchantCapture.status !== 200) {
    throw new Error(`Merchant capture failed: HTTP ${merchantCapture.status} :: ${merchantCapture.bodyText}`);
  }

  const merchantCaptureBody = parseObject(merchantCapture.bodyJson);
  const capturePayload = parseObject(parseObject(merchantCaptureBody?.fulfillment)?.capturePayload);
  const captureDisposition = typeof capturePayload?.captureDisposition === "string" ? capturePayload.captureDisposition : null;
  const capturedDeliveryProofId =
    typeof capturePayload?.deliveryProofId === "string" ? capturePayload.deliveryProofId : null;
  if (captureDisposition !== "CAPTURED" || !capturedDeliveryProofId) {
    throw new Error(`Expected CAPTURED with deliveryProofId, received: ${merchantCapture.bodyText}`);
  }

  const replayPayload = await buildCapturePayload({
    ticketId,
    deliveryProofId: capturedDeliveryProofId as `0x${string}`,
    merchantPrivateKey: delegatedPrivateKey,
    serviceSlug,
  });
  const replayCapture = await fetchJsonLike(captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ticketId: replayPayload.ticketId,
      deliveryProof: replayPayload.deliveryProof,
      completionMeta: replayPayload.completionMeta,
    }),
  });
  const replayBody = parseObject(replayCapture.bodyJson);
  const replayDisposition = typeof replayBody?.captureDisposition === "string" ? replayBody.captureDisposition : null;
  if (replayCapture.status !== 200 || replayDisposition !== "IDEMPOTENT_REPLAY") {
    throw new Error(
      `Expected replay to return IDEMPOTENT_REPLAY, got HTTP ${replayCapture.status} / ${replayDisposition ?? "null"} :: ${replayCapture.bodyText}`,
    );
  }

  const conflictPayload = await buildCapturePayload({
    ticketId,
    merchantPrivateKey: delegatedPrivateKey,
    serviceSlug,
  });
  const captureConflict = await fetchJsonLike(captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ticketId: conflictPayload.ticketId,
      deliveryProof: conflictPayload.deliveryProof,
      completionMeta: conflictPayload.completionMeta,
    }),
  });
  assertExpected(captureConflict, 409, "CAPTURE_CONFLICT", "captureConflict");

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        serviceSlug,
        ticketId,
        checks: {
          unauthorizedCapture: {
            status: unauthorizedCapture.status,
            errorCode: parseObject(unauthorizedCapture.bodyJson)?.errorCode ?? null,
          },
          merchantCapture: {
            status: merchantCapture.status,
            captureDisposition,
            deliveryProofId: capturedDeliveryProofId,
          },
          replayCapture: {
            status: replayCapture.status,
            captureDisposition: replayDisposition,
          },
          captureConflict: {
            status: captureConflict.status,
            errorCode: parseObject(captureConflict.bodyJson)?.errorCode ?? null,
          },
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

