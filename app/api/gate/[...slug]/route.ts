import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import {
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
} from "viem";
import {
  consumeUserCreditsForGate,
  getServiceCreditCost,
  getUserCredits,
  logGateAccessEvent,
  prisma,
} from "@/lib/db";
import { GHOST_PREFERRED_CHAIN_ID } from "@/lib/constants";

export const runtime = "nodejs";

const REPLAY_WINDOW_SECONDS = 60n;

const DOMAIN = {
  name: "GhostGate",
  version: "1",
  chainId: GHOST_PREFERRED_CHAIN_ID,
} as const;

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

interface AccessPayloadRaw {
  service: unknown;
  timestamp: unknown;
  nonce: unknown;
}

interface AccessPayload {
  service: string;
  timestamp: bigint;
  nonce: string;
}

interface RouteContext {
  params: { slug?: string[] } | Promise<{ slug?: string[] }>;
}

const DEFAULT_REQUEST_COST = (() => {
  const raw = process.env.GHOST_REQUEST_CREDIT_COST?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = BigInt(raw);
    if (parsed > 0n) return parsed;
  }
  return 1n;
})();

const ALLOW_CLIENT_COST_OVERRIDE = (process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE?.trim() ?? "") !== "false";
const NONCE_STORE_ENABLED = process.env.GHOST_GATE_NONCE_STORE_ENABLED?.trim() === "true";
const ENFORCE_NONCE_UNIQUENESS = process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS?.trim() === "true";
const ENABLE_DB_SERVICE_PRICING = process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED?.trim() === "true";
const RECEIPT_SIGNING_SECRET = process.env.GHOST_GATE_RECEIPT_SIGNING_SECRET?.trim() ?? "";
const ENFORCE_LIVE_GATEWAY_READINESS = process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS?.trim() === "true";
const ENFORCE_LIVE_GATEWAY_READINESS_AGENT_ONLY =
  (process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS_AGENT_ONLY?.trim() ?? "") !== "false";

const ENV_SERVICE_PRICING = (() => {
  const raw = process.env.GHOST_GATE_SERVICE_PRICING_JSON?.trim();
  const pricing = new Map<string, bigint>();
  if (!raw) return pricing;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [service, value] of Object.entries(parsed)) {
      if (typeof service !== "string") continue;

      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        pricing.set(service, BigInt(value));
        continue;
      }

      if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") {
        pricing.set(service, BigInt(value));
      }
    }
  } catch {
    // Ignore malformed config and fall back to default pricing.
  }

  return pricing;
})();

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseTimestamp = (value: unknown): bigint | null => {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
};

const parseAndValidatePayload = (rawPayload: string): AccessPayload | null => {
  let parsed: AccessPayloadRaw;
  try {
    parsed = JSON.parse(rawPayload) as AccessPayloadRaw;
  } catch {
    return null;
  }

  if (typeof parsed.service !== "string" || parsed.service.length === 0) return null;
  if (typeof parsed.nonce !== "string" || parsed.nonce.length === 0 || parsed.nonce.length > 256) {
    return null;
  }
  if (!/^[\x21-\x7E]+$/.test(parsed.nonce)) return null;

  const ts = parseTimestamp(parsed.timestamp);
  if (ts == null) return null;

  return {
    service: parsed.service,
    timestamp: ts,
    nonce: parsed.nonce,
  };
};

const parseSignature = (rawSig: string): `0x${string}` | null => {
  if (!/^0x[0-9a-fA-F]+$/.test(rawSig)) return null;
  return rawSig as `0x${string}`;
};

const resolveServiceFromSlug = async (context: RouteContext): Promise<string | null> => {
  const params = await Promise.resolve(context.params);
  const slug = params.slug;
  if (!slug || slug.length === 0) return null;
  return slug.join("/");
};

const isReplayWindowValid = (timestamp: bigint): boolean => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (timestamp > now) return false;
  return now - timestamp <= REPLAY_WINDOW_SECONDS;
};

const parseCreditCost = (value: string | null): bigint | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) return null;
  return parsed;
};

const resolveRequestCost = async (
  request: NextRequest,
  service: string,
): Promise<{ cost: bigint; source: "header" | "db" | "env" | "default" }> => {
  const requestScopedCost = parseCreditCost(request.headers.get("x-ghost-credit-cost"));
  if (ALLOW_CLIENT_COST_OVERRIDE && requestScopedCost != null) {
    return { cost: requestScopedCost, source: "header" };
  }

  if (ENABLE_DB_SERVICE_PRICING) {
    const dbServiceCost = await getServiceCreditCost(service);
    if (dbServiceCost != null) {
      return { cost: dbServiceCost, source: "db" };
    }
  }

  const envServiceCost = ENV_SERVICE_PRICING.get(service);
  if (envServiceCost != null) {
    return { cost: envServiceCost, source: "env" };
  }

  return { cost: DEFAULT_REQUEST_COST, source: "default" };
};

const buildRequestId = (request: NextRequest, service: string, signer: Address, nonce: string): string => {
  const explicitRequestId = request.headers.get("x-ghost-request-id")?.trim();
  if (explicitRequestId && explicitRequestId.length <= 128) {
    return explicitRequestId;
  }

  return `${service}:${signer.toLowerCase()}:${nonce}`;
};

const buildSignedReceipt = (input: {
  service: string;
  signer: Address;
  cost: bigint;
  remainingCredits: bigint;
  nonce: string;
  requestId: string;
  issuedAt: string;
}): { algorithm: "hmac-sha256"; signature: string; issuedAt: string; requestId: string } | null => {
  if (!RECEIPT_SIGNING_SECRET) {
    return null;
  }

  const canonical = JSON.stringify({
    service: input.service,
    signer: input.signer.toLowerCase(),
    cost: input.cost.toString(),
    remainingCredits: input.remainingCredits.toString(),
    nonce: input.nonce,
    requestId: input.requestId,
    issuedAt: input.issuedAt,
  });

  const signature = createHmac("sha256", RECEIPT_SIGNING_SECRET).update(canonical).digest("hex");

  return {
    algorithm: "hmac-sha256",
    signature,
    issuedAt: input.issuedAt,
    requestId: input.requestId,
  };
};

type ServiceGatewayReadiness = {
  agentId: string | null;
  ownerAddress: string | null;
  readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  lastCanaryCheckedAt: string | null;
  lastCanaryPassedAt: string | null;
};

const shouldEnforceServiceGatewayReadiness = (service: string): boolean => {
  if (!ENFORCE_LIVE_GATEWAY_READINESS) return false;
  if (!ENFORCE_LIVE_GATEWAY_READINESS_AGENT_ONLY) return true;
  return /^agent-\d+$/i.test(service);
};

const resolveServiceGatewayReadiness = async (service: string): Promise<ServiceGatewayReadiness> => {
  try {
    const config = await prisma.agentGatewayConfig.findFirst({
      where: { serviceSlug: service },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        agentId: true,
        ownerAddress: true,
        readinessStatus: true,
        lastCanaryCheckedAt: true,
        lastCanaryPassedAt: true,
      },
    });

    if (!config) {
      return {
        agentId: null,
        ownerAddress: null,
        readinessStatus: "UNCONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
      };
    }

    return {
      agentId: config.agentId,
      ownerAddress: config.ownerAddress.toLowerCase(),
      readinessStatus: config.readinessStatus,
      lastCanaryCheckedAt: config.lastCanaryCheckedAt?.toISOString() ?? null,
      lastCanaryPassedAt: config.lastCanaryPassedAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code?: string }).code === "P2021" || (error as { code?: string }).code === "P2022")
    ) {
      return {
        agentId: null,
        ownerAddress: null,
        readinessStatus: "UNCONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
      };
    }
    throw error;
  }
};

const handle = async (request: NextRequest, context: RouteContext): Promise<NextResponse> => {
  const requestedService = await resolveServiceFromSlug(context);
  if (!requestedService) {
    return json({ error: "Missing service slug", code: 400 }, 400);
  }

  const respondWithOutcome = async (input: {
    outcome:
      | "AUTHORIZED"
      | "REPLAY"
      | "INSUFFICIENT_CREDITS"
      | "MALFORMED_AUTH"
      | "SERVICE_MISMATCH"
      | "SIGNATURE_EXPIRED"
      | "INVALID_SIGNATURE";
    status: number;
    body: Record<string, unknown>;
    signer?: Address | string | null;
    nonce?: string | null;
    requestId?: string | null;
    cost?: bigint | null;
    remainingCredits?: bigint | null;
    metadata?: Record<string, unknown>;
  }): Promise<NextResponse> => {
    await logGateAccessEvent({
      service: requestedService,
      outcome: input.outcome,
      signer: input.signer ?? null,
      nonce: input.nonce ?? null,
      requestId: input.requestId ?? null,
      cost: input.cost ?? null,
      remainingCredits: input.remainingCredits ?? null,
      metadata: input.metadata ?? null,
    });
    return json(input.body, input.status);
  };

  const rawSig = request.headers.get("x-ghost-sig");
  const rawPayload = request.headers.get("x-ghost-payload");
  if (!rawSig || !rawPayload) {
    return respondWithOutcome({
      outcome: "MALFORMED_AUTH",
      status: 400,
      body: { error: "Missing required auth headers", code: 400 },
      metadata: { reason: "missing_auth_headers" },
    });
  }

  const signature = parseSignature(rawSig);
  const payload = parseAndValidatePayload(rawPayload);
  if (!signature || !payload) {
    return respondWithOutcome({
      outcome: "MALFORMED_AUTH",
      status: 400,
      body: { error: "Malformed signature or payload", code: 400 },
      metadata: { reason: "malformed_signature_or_payload" },
    });
  }

  if (payload.service !== requestedService) {
    return respondWithOutcome({
      outcome: "SERVICE_MISMATCH",
      status: 401,
      body: { error: "Service mismatch", code: 401 },
      nonce: payload.nonce,
      metadata: { payloadService: payload.service },
    });
  }

  if (!isReplayWindowValid(payload.timestamp)) {
    return respondWithOutcome({
      outcome: "SIGNATURE_EXPIRED",
      status: 401,
      body: { error: "Signature expired", code: 401 },
      nonce: payload.nonce,
      metadata: { payloadTimestamp: payload.timestamp.toString() },
    });
  }

  let signer: Address;
  let isValidSig = false;
  try {
    signer = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Access",
      message: payload,
      signature,
    });

    isValidSig = await verifyTypedData({
      address: signer,
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Access",
      message: payload,
      signature,
    });
  } catch {
    return respondWithOutcome({
      outcome: "INVALID_SIGNATURE",
      status: 401,
      body: { error: "Invalid Signature", code: 401 },
      nonce: payload.nonce,
      metadata: { reason: "recover_or_verify_throw" },
    });
  }

  if (!isValidSig) {
    return respondWithOutcome({
      outcome: "INVALID_SIGNATURE",
      status: 401,
      body: { error: "Invalid Signature", code: 401 },
      signer,
      nonce: payload.nonce,
      metadata: { reason: "verify_false" },
    });
  }

  const requestId = buildRequestId(request, requestedService, signer, payload.nonce);
  const enforceGatewayReadiness = shouldEnforceServiceGatewayReadiness(requestedService);

  let serviceGatewayReadiness: ServiceGatewayReadiness = {
    agentId: null,
    ownerAddress: null,
    readinessStatus: "UNCONFIGURED",
    lastCanaryCheckedAt: null,
    lastCanaryPassedAt: null,
  };

  try {
    serviceGatewayReadiness = await resolveServiceGatewayReadiness(requestedService);
  } catch {
    if (enforceGatewayReadiness) {
      return respondWithOutcome({
        outcome: "SERVICE_MISMATCH",
        status: 500,
        body: {
          error: "Failed to resolve service gateway readiness",
          code: 500,
        },
        signer,
        nonce: payload.nonce,
        requestId,
        metadata: {
          reason: "service_gateway_readiness_lookup_failed",
        },
      });
    }
  }

  if (enforceGatewayReadiness) {
    if (serviceGatewayReadiness.readinessStatus !== "LIVE") {
      return respondWithOutcome({
        outcome: "SERVICE_MISMATCH",
        status: 423,
        body: {
          error: "Service not live",
          code: 423,
          authCode: "SERVICE_NOT_LIVE",
          details: {
            service: requestedService,
            readinessStatus: serviceGatewayReadiness.readinessStatus,
            lastCanaryCheckedAt: serviceGatewayReadiness.lastCanaryCheckedAt,
            lastCanaryPassedAt: serviceGatewayReadiness.lastCanaryPassedAt,
          },
        },
        signer,
        nonce: payload.nonce,
        requestId,
        metadata: {
          reason: "service_not_live",
          readinessStatus: serviceGatewayReadiness.readinessStatus,
          lastCanaryCheckedAt: serviceGatewayReadiness.lastCanaryCheckedAt,
          lastCanaryPassedAt: serviceGatewayReadiness.lastCanaryPassedAt,
        },
      });
    }
  }

  const { cost: requestCost, source: requestCostSource } = await resolveRequestCost(request, requestedService);

  const consumed = await consumeUserCreditsForGate(signer, requestCost, {
    service: requestedService,
    nonce: payload.nonce,
    payloadTimestamp: payload.timestamp,
    signature,
    requestId,
    enforceNonceUniqueness: ENFORCE_NONCE_UNIQUENESS && NONCE_STORE_ENABLED,
    merchantOwnerAddress: serviceGatewayReadiness.ownerAddress,
    agentId: serviceGatewayReadiness.agentId,
  });

  if (consumed.status === "replay") {
    return respondWithOutcome({
      outcome: "REPLAY",
      status: 409,
      body: {
        error: "Replay Detected",
        code: 409,
      },
      signer,
      nonce: payload.nonce,
      requestId,
      cost: requestCost,
    });
  }

  if (consumed.status === "insufficient_credits") {
    const balance = await getUserCredits(signer);
    return respondWithOutcome({
      outcome: "INSUFFICIENT_CREDITS",
      status: 402,
      body: {
        error: "Payment Required",
        code: 402,
        details: {
          balance: balance.toString(),
          required: requestCost.toString(),
        },
      },
      signer,
      nonce: payload.nonce,
      requestId,
      cost: requestCost,
      remainingCredits: balance,
    });
  }

  const issuedAt = new Date().toISOString();
  const receipt = buildSignedReceipt({
    service: requestedService,
    signer,
    cost: requestCost,
    remainingCredits: consumed.after,
    nonce: payload.nonce,
    requestId,
    issuedAt,
  });

  return respondWithOutcome({
    outcome: "AUTHORIZED",
    status: 200,
    body: {
      authorized: true,
      code: 200,
      service: requestedService,
      signer,
      cost: requestCost.toString(),
      remainingCredits: consumed.after.toString(),
      nonceAccepted: consumed.nonceAccepted,
      requestId,
      receipt,
      costSource: requestCostSource,
    },
    signer,
    nonce: payload.nonce,
    requestId,
    cost: requestCost,
    remainingCredits: consumed.after,
    metadata: {
      nonceAccepted: consumed.nonceAccepted,
      costSource: requestCostSource,
    },
  });
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}
