import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, verifyTypedData, type Address } from "viem";
import { createFulfillmentHold, getServiceCreditCost, prisma } from "@/lib/db";
import {
  buildFulfillmentTicketEnvelope,
  buildFulfillmentTicketRequestAuthTypedData,
  buildFulfillmentTicketTypedData,
  hashFulfillmentTicketTypedData,
  normalizeFulfillmentTicketMessage,
  parseWireFulfillmentTicketRequestAuthMessage,
} from "@/lib/fulfillment-eip712";
import { hashCanonicalFulfillmentQuery, sha256HexUtf8 } from "@/lib/fulfillment-hash";
import { fulfillmentJson, normalizeHexSignatureLower } from "@/lib/fulfillment-route";
import {
  assertFulfillmentPath,
  FULFILLMENT_API_VERSION,
  normalizeFulfillmentMethod,
  type FulfillmentTicketMessage,
} from "@/lib/fulfillment-types";
import { consumeFulfillmentRateLimit } from "@/lib/fulfillment-rate-limit";
import { extractFulfillmentErrorCode, observeFulfillmentResponseEvent } from "@/lib/fulfillment-observability";

export const runtime = "nodejs";

const TICKET_REQUEST_MAX_AGE_SECONDS = 60n;
const TICKET_REQUEST_FUTURE_SKEW_SECONDS = 30n;
const DEFAULT_HOLD_TTL_MS = 60_000;
const DEFAULT_WALLET_HOLD_CAP = 3;

let protocolSignerAccountCache: ReturnType<typeof privateKeyToAccount> | null | undefined;

const parseTopLevelRequest = (body: unknown): {
  serviceSlug: string;
  method: string;
  path: string;
  cost: string | number;
  query?: string | null;
  clientRequestId?: string | null;
  ticketRequestAuth: { payload: string; signature: `0x${string}` };
} | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const serviceSlug = typeof record.serviceSlug === "string" ? record.serviceSlug.trim() : "";
  const method = typeof record.method === "string" ? record.method.trim() : "";
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const cost = record.cost;
  const query = typeof record.query === "string" ? record.query : record.query == null ? null : undefined;
  const clientRequestId =
    typeof record.clientRequestId === "string" ? record.clientRequestId.trim() : record.clientRequestId == null ? null : undefined;

  if (!serviceSlug || !method || !path) return null;
  if (typeof cost !== "number" && typeof cost !== "string") return null;
  if (query === undefined || clientRequestId === undefined) return null;

  const auth = record.ticketRequestAuth;
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return null;
  const authRecord = auth as Record<string, unknown>;
  const payload = typeof authRecord.payload === "string" ? authRecord.payload.trim() : "";
  const signature = normalizeHexSignatureLower(authRecord.signature);
  if (!payload || !signature) return null;

  return {
    serviceSlug,
    method,
    path,
    cost,
    query,
    clientRequestId,
    ticketRequestAuth: { payload, signature },
  };
};

const parsePositiveCostBigInt = (value: string | number): bigint | null => {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) return null;
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
};

const parsePositiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getFulfillmentHoldTtlMs = (): number => parsePositiveIntEnv(process.env.GHOST_FULFILLMENT_HOLD_TTL_MS, DEFAULT_HOLD_TTL_MS);

const getFulfillmentWalletHoldCap = (): number =>
  parsePositiveIntEnv(process.env.GHOST_FULFILLMENT_WALLET_HOLD_CAP, DEFAULT_WALLET_HOLD_CAP);

const normalizeProtocolSignerPrivateKey = (raw: string | undefined): `0x${string}` | null => {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

const getProtocolSignerAccount = (): ReturnType<typeof privateKeyToAccount> | null => {
  if (protocolSignerAccountCache !== undefined) {
    return protocolSignerAccountCache;
  }
  const pk = normalizeProtocolSignerPrivateKey(process.env.GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY);
  protocolSignerAccountCache = pk ? privateKeyToAccount(pk) : null;
  return protocolSignerAccountCache;
};

const toLowerAddress = (value: Address | string): `0x${string}` => value.toLowerCase() as `0x${string}`;

const isTicketRequestWindowValid = (issuedAtSeconds: bigint): boolean => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (issuedAtSeconds > now + TICKET_REQUEST_FUTURE_SKEW_SECONDS) return false;
  if (now > issuedAtSeconds && now - issuedAtSeconds > TICKET_REQUEST_MAX_AGE_SECONDS) return false;
  return true;
};

type ServiceGatewayReadiness = {
  agentId: string | null;
  gatewayConfigId: string | null;
  ownerAddress: string | null;
  endpointUrl: string | null;
  readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  lastCanaryCheckedAt: string | null;
  lastCanaryPassedAt: string | null;
};

const resolveServiceGatewayReadiness = async (serviceSlug: string): Promise<ServiceGatewayReadiness> => {
  try {
    const config = await prisma.agentGatewayConfig.findFirst({
      where: { serviceSlug },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        agentId: true,
        ownerAddress: true,
        endpointUrl: true,
        readinessStatus: true,
        lastCanaryCheckedAt: true,
        lastCanaryPassedAt: true,
      },
    });

    if (!config) {
      return {
        agentId: null,
        gatewayConfigId: null,
        ownerAddress: null,
        endpointUrl: null,
        readinessStatus: "UNCONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
      };
    }

    return {
      agentId: config.agentId,
      gatewayConfigId: config.id,
      ownerAddress: config.ownerAddress.toLowerCase(),
      endpointUrl: config.endpointUrl,
      readinessStatus: config.readinessStatus,
      lastCanaryCheckedAt: config.lastCanaryCheckedAt?.toISOString() ?? null,
      lastCanaryPassedAt: config.lastCanaryPassedAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2021" || error.code === "P2022")
    ) {
      return {
        agentId: null,
        gatewayConfigId: null,
        ownerAddress: null,
        endpointUrl: null,
        readinessStatus: "UNCONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
      };
    }
    throw error;
  }
};

const buildTicketId = (): `0x${string}` => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;

const parseClientRequestId = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) return null;
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return null;
  return trimmed;
};

const toSafeIntNumber = (value: bigint): number | null => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
};

const ticketResponse = (
  body: unknown,
  status = 200,
  options?: { retryAfterSeconds?: number; meta?: Record<string, unknown> },
): NextResponse => {
  observeFulfillmentResponseEvent({
    route: "ticket",
    status,
    errorCode: extractFulfillmentErrorCode(body),
    meta: options?.meta,
  });
  if (typeof options?.retryAfterSeconds === "number") {
    return NextResponse.json(body, {
      status,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(options.retryAfterSeconds),
      },
    });
  }
  return fulfillmentJson(body, status);
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimit = consumeFulfillmentRateLimit({ request, action: "ticket" });
  if (!rateLimit.ok) {
    return ticketResponse(
      {
        code: 429,
        error: rateLimit.error,
        errorCode: rateLimit.errorCode,
      },
      429,
      {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        meta: { rateLimited: true },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ticketResponse({ code: 400, error: "Invalid JSON body.", errorCode: "INVALID_TICKET_REQUEST" }, 400);
  }

  const parsed = parseTopLevelRequest(body);
  if (!parsed) {
    return ticketResponse(
      { code: 400, error: "Invalid fulfillment ticket request shape.", errorCode: "INVALID_TICKET_REQUEST" },
      400,
    );
  }

  const requestedCost = parsePositiveCostBigInt(parsed.cost);
  if (requestedCost == null) {
    return ticketResponse(
      { code: 400, error: "cost must be a positive integer.", errorCode: "INVALID_BINDING_INPUT" },
      400,
    );
  }

  let normalizedMethod: string;
  let normalizedPath: string;
  try {
    normalizedMethod = normalizeFulfillmentMethod(parsed.method);
    normalizedPath = assertFulfillmentPath(parsed.path);
  } catch (error) {
    return ticketResponse(
      {
        code: 400,
        error: "Invalid method or path binding input.",
        errorCode: "INVALID_BINDING_INPUT",
        details: error instanceof Error ? error.message : "Method/path validation failed.",
      },
      400,
    );
  }

  const clientRequestId = parseClientRequestId(parsed.clientRequestId);
  if (parsed.clientRequestId && !clientRequestId) {
    return ticketResponse(
      { code: 400, error: "clientRequestId is invalid.", errorCode: "INVALID_BINDING_INPUT" },
      400,
    );
  }

  let authMessage;
  try {
    authMessage = parseWireFulfillmentTicketRequestAuthMessage(parsed.ticketRequestAuth.payload);
  } catch (error) {
    return ticketResponse(
      {
        code: 400,
        error: "Invalid fulfillment ticket request auth payload.",
        errorCode: "INVALID_TICKET_REQUEST_AUTH",
        details: error instanceof Error ? error.message : "Failed to parse auth payload.",
      },
      400,
    );
  }

  const computedQueryHash = hashCanonicalFulfillmentQuery(parsed.query ?? null);
  if (
    authMessage.serviceSlug !== parsed.serviceSlug ||
    authMessage.method !== normalizedMethod ||
    authMessage.path !== normalizedPath ||
    authMessage.queryHash !== computedQueryHash
  ) {
    return ticketResponse(
      {
        code: 400,
        error: "Request fields do not match signed binding payload.",
        errorCode: "INVALID_BINDING_INPUT",
      },
      400,
    );
  }

  if (authMessage.cost !== requestedCost) {
    return ticketResponse(
      {
        code: 400,
        error: "Requested cost does not match signed cost binding.",
        errorCode: "COST_MISMATCH",
        details: {
          requestedCost: requestedCost.toString(),
          signedCost: authMessage.cost.toString(),
        },
      },
      400,
    );
  }

  if (!isTicketRequestWindowValid(authMessage.issuedAt)) {
    return ticketResponse(
      {
        code: 401,
        error: "Ticket request auth payload expired or not yet valid.",
        errorCode: "INVALID_TICKET_REQUEST_AUTH",
      },
      401,
    );
  }

  let consumerSigner: Address;
  let authSignatureValid = false;
  try {
    const typedData = buildFulfillmentTicketRequestAuthTypedData(authMessage);
    consumerSigner = await recoverTypedDataAddress({
      ...typedData,
      signature: parsed.ticketRequestAuth.signature,
    });
    authSignatureValid = await verifyTypedData({
      address: consumerSigner,
      ...typedData,
      signature: parsed.ticketRequestAuth.signature,
    });
  } catch {
    return ticketResponse(
      { code: 401, error: "Invalid consumer auth signature.", errorCode: "INVALID_CONSUMER_SIGNATURE" },
      401,
    );
  }

  if (!authSignatureValid) {
    return ticketResponse(
      { code: 401, error: "Invalid consumer auth signature.", errorCode: "INVALID_CONSUMER_SIGNATURE" },
      401,
    );
  }

  const readiness = await resolveServiceGatewayReadiness(parsed.serviceSlug);
  if (readiness.readinessStatus !== "LIVE" || !readiness.gatewayConfigId || !readiness.ownerAddress || !readiness.agentId) {
    return ticketResponse(
      {
        code: 423,
        error: "Service not live",
        errorCode: "SERVICE_NOT_LIVE",
        details: {
          serviceSlug: parsed.serviceSlug,
          readinessStatus: readiness.readinessStatus,
          lastCanaryCheckedAt: readiness.lastCanaryCheckedAt,
          lastCanaryPassedAt: readiness.lastCanaryPassedAt,
        },
      },
      423,
    );
  }

  const authoritativeCost = await getServiceCreditCost(parsed.serviceSlug);
  if (authoritativeCost == null) {
    return ticketResponse(
      {
        code: 409,
        error: "Authoritative service pricing is not configured.",
        errorCode: "SERVICE_PRICING_UNAVAILABLE",
      },
      409,
    );
  }

  if (authoritativeCost !== requestedCost) {
    return ticketResponse(
      {
        code: 400,
        error: "Requested cost does not match authoritative service pricing.",
        errorCode: "COST_MISMATCH",
        details: {
          requestedCost: requestedCost.toString(),
          authoritativeCost: authoritativeCost.toString(),
        },
      },
      400,
    );
  }

  const protocolSigner = getProtocolSignerAccount();
  if (!protocolSigner) {
    return ticketResponse(
      {
        code: 500,
        error: "Fulfillment protocol signer is not configured.",
        errorCode: "FULFILLMENT_SIGNER_NOT_CONFIGURED",
      },
      500,
    );
  }

  const nowMs = Date.now();
  const issuedAtDate = new Date(nowMs);
  const ttlMs = getFulfillmentHoldTtlMs();
  const expiresAtDate = new Date(nowMs + ttlMs);
  const ticketId = buildTicketId();

  let holdResult;
  try {
    holdResult = await createFulfillmentHold({
      walletAddress: consumerSigner,
      serviceSlug: parsed.serviceSlug,
      agentId: readiness.agentId,
      gatewayConfigId: readiness.gatewayConfigId,
      merchantOwnerAddress: readiness.ownerAddress,
      requestMethod: normalizedMethod,
      requestPath: normalizedPath,
      queryHash: authMessage.queryHash,
      bodyHash: authMessage.bodyHash,
      cost: authoritativeCost,
      ticketId,
      issuedAt: issuedAtDate,
      expiresAt: expiresAtDate,
      requestNonce: authMessage.nonce,
      requestAuthIssuedAtSeconds: authMessage.issuedAt,
      requestAuthSignature: parsed.ticketRequestAuth.signature,
      clientRequestId,
      walletHoldCap: getFulfillmentWalletHoldCap(),
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2021" || error.code === "P2022")
    ) {
      return ticketResponse(
        {
          code: 503,
          error: "Phase C fulfillment schema is not available in this environment yet.",
          errorCode: "PHASE_C_SCHEMA_UNAVAILABLE",
        },
        503,
      );
    }
    console.error("Fulfillment ticket issuance failed during hold creation.", {
      serviceSlug: parsed.serviceSlug,
      consumer: toLowerAddress(consumerSigner),
      error: error instanceof Error ? error.message : String(error),
    });
    return ticketResponse(
      {
        code: 500,
        error: "Fulfillment ticket issuance failed.",
        errorCode: "FULFILLMENT_TICKET_FAILED",
      },
      500,
    );
  }

  if (holdResult.status === "replay") {
    return ticketResponse({ code: 409, error: "Replay detected.", errorCode: "REPLAY" }, 409);
  }

  if (holdResult.status === "wallet_service_hold_exists") {
    return ticketResponse(
      {
        code: 409,
        error: "An active hold already exists for this wallet/service.",
        errorCode: "HOLD_CAP_EXCEEDED",
        details: { scope: "wallet_service" },
      },
      409,
    );
  }

  if (holdResult.status === "wallet_hold_cap_exceeded") {
    return ticketResponse(
      {
        code: 409,
        error: "Wallet active hold cap exceeded.",
        errorCode: "HOLD_CAP_EXCEEDED",
        details: {
          scope: "wallet",
          activeWalletHolds: holdResult.activeWalletHolds,
          walletHoldCap: holdResult.walletHoldCap,
        },
      },
      409,
    );
  }

  if (holdResult.status === "insufficient_credits") {
    return ticketResponse(
      {
        code: 402,
        error: "Payment Required",
        errorCode: "INSUFFICIENT_CREDITS",
        details: {
          balance: holdResult.balance.toString(),
          required: holdResult.required.toString(),
        },
      },
      402,
    );
  }

  const ticketIssuedAtSeconds = BigInt(Math.floor(issuedAtDate.getTime() / 1000));
  const ticketExpiresAtSeconds = BigInt(Math.floor(expiresAtDate.getTime() / 1000));
  const gatewayConfigIdHash = sha256HexUtf8(readiness.gatewayConfigId);

  let ticketMessage: FulfillmentTicketMessage;
  try {
    ticketMessage = normalizeFulfillmentTicketMessage({
      ticketId,
      consumer: toLowerAddress(consumerSigner),
      merchantOwner: readiness.ownerAddress,
      gatewayConfigIdHash,
      serviceSlug: parsed.serviceSlug,
      method: normalizedMethod,
      path: normalizedPath,
      queryHash: authMessage.queryHash,
      bodyHash: authMessage.bodyHash,
      cost: authoritativeCost,
      issuedAt: ticketIssuedAtSeconds,
      expiresAt: ticketExpiresAtSeconds,
    });
  } catch (error) {
    return ticketResponse(
      {
        code: 500,
        error: "Failed to build normalized fulfillment ticket.",
        errorCode: "TICKET_BUILD_FAILED",
        details: error instanceof Error ? error.message : "Unknown ticket normalization failure.",
      },
      500,
    );
  }

  const ticketSignature = await protocolSigner.signTypedData(buildFulfillmentTicketTypedData(ticketMessage));
  const ticketEnvelope = buildFulfillmentTicketEnvelope(ticketMessage, ticketSignature);
  const safeCost = toSafeIntNumber(authoritativeCost);
  if (safeCost == null) {
    return ticketResponse(
      { code: 500, error: "Authoritative cost exceeds safe integer response range.", errorCode: "TICKET_BUILD_FAILED" },
      500,
    );
  }

  return ticketResponse(
    {
      ok: true,
      apiVersion: FULFILLMENT_API_VERSION,
      ticketId,
      serviceSlug: parsed.serviceSlug,
      cost: safeCost,
      expiresAt: expiresAtDate.toISOString(),
      merchantTarget: {
        endpointUrl: readiness.endpointUrl,
        path: normalizedPath,
      },
      ticket: ticketEnvelope,
      validated: {
        consumer: toLowerAddress(consumerSigner),
        merchantOwner: readiness.ownerAddress,
        gatewayConfigIdHash,
        queryHash: authMessage.queryHash,
        bodyHash: authMessage.bodyHash,
        ticketTypedHash: hashFulfillmentTicketTypedData(ticketMessage),
        creditsBefore: holdResult.creditsBefore.toString(),
        creditsAfter: holdResult.creditsAfter.toString(),
        heldCreditsBefore: holdResult.heldCreditsBefore.toString(),
        heldCreditsAfter: holdResult.heldCreditsAfter.toString(),
        holdId: holdResult.holdId,
        requestNonce: authMessage.nonce,
        clientRequestId,
      },
    },
    200,
  );
}
