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
import { consumeFulfillmentRateLimit } from "@/lib/fulfillment-rate-limit";

export const runtime = "nodejs";

const REPLAY_WINDOW_SECONDS = 60n;
const X402_VERSION = 2;

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

const ALLOW_CLIENT_COST_OVERRIDE = process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE?.trim() === "true";
const NONCE_STORE_ENABLED = (process.env.GHOST_GATE_NONCE_STORE_ENABLED?.trim() ?? "true") !== "false";
const ENFORCE_NONCE_UNIQUENESS = (process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS?.trim() ?? "true") !== "false";
const ENABLE_DB_SERVICE_PRICING = process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED?.trim() === "true";
const RECEIPT_SIGNING_SECRET = process.env.GHOST_GATE_RECEIPT_SIGNING_SECRET?.trim() ?? "";
const ENFORCE_LIVE_GATEWAY_READINESS = process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS?.trim() === "true";
const ENFORCE_LIVE_GATEWAY_READINESS_AGENT_ONLY =
  (process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS_AGENT_ONLY?.trim() ?? "") !== "false";
const GHOST_GATE_X402_ENABLED = process.env.GHOST_GATE_X402_ENABLED?.trim() === "true";
const GHOST_GATE_X402_SCHEME = process.env.GHOST_GATE_X402_SCHEME?.trim() || "ghost-eip712-credit-v1";
const GHOST_GATE_X402_ASSET = process.env.GHOST_GATE_X402_ASSET?.trim() || "GHOST_CREDIT";
const GHOST_GATE_X402_HINT =
  process.env.GHOST_GATE_X402_HINT?.trim() || "Send PAYMENT-SIGNATURE containing base64 JSON with payload+signature.";

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

const json = (body: unknown, status = 200, extraHeaders?: Record<string, string>): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", ...(extraHeaders ?? {}) },
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

const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const decodeBase64Json = (raw: string): unknown | null => {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
};

type X402ExtractionResult =
  | {
      ok: true;
      rawSig: string;
      rawPayload: string;
      parsedEnvelope: unknown;
    }
  | {
      ok: false;
      reason:
        | "missing_payment_signature"
        | "invalid_payment_signature_base64"
        | "missing_envelope_signature_or_payload";
    };

const extractX402AuthHeaders = (request: NextRequest): X402ExtractionResult => {
  const paymentSignature = request.headers.get("payment-signature");
  if (!paymentSignature) {
    return { ok: false, reason: "missing_payment_signature" };
  }

  const decodedEnvelope = decodeBase64Json(paymentSignature.trim());
  if (!decodedEnvelope || typeof decodedEnvelope !== "object") {
    return { ok: false, reason: "invalid_payment_signature_base64" };
  }

  const envelope = decodedEnvelope as Record<string, unknown>;
  const envelopeSignature =
    typeof envelope.signature === "string"
      ? envelope.signature
      : typeof envelope.xGhostSig === "string"
        ? envelope.xGhostSig
        : null;

  const envelopePayload = envelope.payload ?? envelope.xGhostPayload ?? null;
  if (!envelopeSignature || envelopePayload == null) {
    return { ok: false, reason: "missing_envelope_signature_or_payload" };
  }

  const rawPayload = typeof envelopePayload === "string" ? envelopePayload : JSON.stringify(envelopePayload);
  return {
    ok: true,
    rawSig: envelopeSignature,
    rawPayload,
    parsedEnvelope: decodedEnvelope,
  };
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

const buildRequestId = (service: string, signer: Address, nonce: string): string => {
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

const buildX402PaymentRequiredEnvelope = (input: {
  request: NextRequest;
  service: string;
  cost: bigint;
  reason:
    | "missing_payment_signature"
    | "invalid_payment_signature_base64"
    | "missing_envelope_signature_or_payload"
    | "insufficient_credits";
}) => ({
  x402Version: X402_VERSION,
  reason: input.reason,
  resource: {
    url: `${input.request.nextUrl.origin}/api/gate/${encodeURIComponent(input.service)}`,
    service: input.service,
  },
  accepts: [
    {
      scheme: GHOST_GATE_X402_SCHEME,
      network: `eip155:${GHOST_PREFERRED_CHAIN_ID}`,
      amount: input.cost.toString(),
      asset: GHOST_GATE_X402_ASSET,
      replayWindowSeconds: REPLAY_WINDOW_SECONDS.toString(),
      hint: GHOST_GATE_X402_HINT,
    },
  ],
});

const buildX402PaymentResponseEnvelope = (input: {
  service: string;
  signer: Address;
  cost: bigint;
  remainingCredits: bigint;
  requestId: string;
  issuedAt: string;
  receipt: { algorithm: "hmac-sha256"; signature: string; issuedAt: string; requestId: string } | null;
}) => ({
  x402Version: X402_VERSION,
  scheme: GHOST_GATE_X402_SCHEME,
  network: `eip155:${GHOST_PREFERRED_CHAIN_ID}`,
  service: input.service,
  signer: input.signer.toLowerCase(),
  amount: input.cost.toString(),
  asset: GHOST_GATE_X402_ASSET,
  remainingCredits: input.remainingCredits.toString(),
  requestId: input.requestId,
  issuedAt: input.issuedAt,
  receipt: input.receipt,
});

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

  const rateLimit = consumeFulfillmentRateLimit({
    request,
    action: "gate",
    scopeKey: requestedService,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      {
        error: rateLimit.error,
        errorCode: rateLimit.errorCode,
        code: 429,
      },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(rateLimit.retryAfterSeconds),
        },
      },
    );
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
    headers?: Record<string, string>;
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
    return json(input.body, input.status, input.headers);
  };

  let rawSig = request.headers.get("x-ghost-sig");
  let rawPayload = request.headers.get("x-ghost-payload");
  let authSource: "ghost-eip712" | "x402-payment-signature" = "ghost-eip712";
  let x402ParsedEnvelope: unknown = null;

  if (!rawSig || !rawPayload) {
    const hasAnyGhostAuthHeader = Boolean(rawSig) || Boolean(rawPayload);
    if (!GHOST_GATE_X402_ENABLED) {
      return respondWithOutcome({
        outcome: "MALFORMED_AUTH",
        status: 400,
        body: { error: "Missing required auth headers", code: 400 },
        metadata: { reason: "missing_auth_headers" },
      });
    }

    if (hasAnyGhostAuthHeader) {
      return respondWithOutcome({
        outcome: "MALFORMED_AUTH",
        status: 400,
        body: { error: "Malformed signature or payload", code: 400 },
        metadata: {
          reason: "partial_ghost_auth_headers",
          authSource,
        },
      });
    }

    const { cost: x402ExpectedCost } = await resolveRequestCost(request, requestedService);
    const extractedX402Headers = extractX402AuthHeaders(request);

    if (!extractedX402Headers.ok) {
      const paymentRequired = buildX402PaymentRequiredEnvelope({
        request,
        service: requestedService,
        cost: x402ExpectedCost,
        reason: extractedX402Headers.reason,
      });

      return respondWithOutcome({
        outcome: "MALFORMED_AUTH",
        status: 402,
        body: {
          error: "Payment Required",
          code: 402,
          details: {
            required: x402ExpectedCost.toString(),
            x402: paymentRequired,
          },
        },
        metadata: {
          reason: extractedX402Headers.reason,
          authSource: "x402",
        },
        headers: {
          "payment-required": encodeBase64Json(paymentRequired),
        },
      });
    }

    rawSig = extractedX402Headers.rawSig;
    rawPayload = extractedX402Headers.rawPayload;
    authSource = "x402-payment-signature";
    x402ParsedEnvelope = extractedX402Headers.parsedEnvelope;
  }

  const signature = parseSignature(rawSig);
  const payload = parseAndValidatePayload(rawPayload);
  if (!signature || !payload) {
    return respondWithOutcome({
      outcome: "MALFORMED_AUTH",
      status: 400,
      body: { error: "Malformed signature or payload", code: 400 },
      metadata: {
        reason: "malformed_signature_or_payload",
        authSource,
      },
    });
  }

  if (payload.service !== requestedService) {
    return respondWithOutcome({
      outcome: "SERVICE_MISMATCH",
      status: 401,
      body: { error: "Service mismatch", code: 401 },
      nonce: payload.nonce,
      metadata: { payloadService: payload.service, authSource },
    });
  }

  if (!isReplayWindowValid(payload.timestamp)) {
    return respondWithOutcome({
      outcome: "SIGNATURE_EXPIRED",
      status: 401,
      body: { error: "Signature expired", code: 401 },
      nonce: payload.nonce,
      metadata: { payloadTimestamp: payload.timestamp.toString(), authSource },
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
      metadata: { reason: "recover_or_verify_throw", authSource },
    });
  }

  if (!isValidSig) {
    return respondWithOutcome({
      outcome: "INVALID_SIGNATURE",
      status: 401,
      body: { error: "Invalid Signature", code: 401 },
      signer,
      nonce: payload.nonce,
      metadata: { reason: "verify_false", authSource },
    });
  }

  const requestId = buildRequestId(requestedService, signer, payload.nonce);
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
          authSource,
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
          authSource,
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
    const paymentRequired =
      authSource === "x402-payment-signature"
        ? buildX402PaymentRequiredEnvelope({
            request,
            service: requestedService,
            cost: requestCost,
            reason: "insufficient_credits",
          })
        : null;
    return respondWithOutcome({
      outcome: "INSUFFICIENT_CREDITS",
      status: 402,
      body: {
        error: "Payment Required",
        code: 402,
        details: {
          balance: balance.toString(),
          required: requestCost.toString(),
          ...(paymentRequired ? { x402: paymentRequired } : {}),
        },
      },
      signer,
      nonce: payload.nonce,
      requestId,
      cost: requestCost,
      remainingCredits: balance,
      metadata: {
        authSource,
      },
      headers: paymentRequired ? { "payment-required": encodeBase64Json(paymentRequired) } : undefined,
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

  const x402PaymentResponse =
    authSource === "x402-payment-signature"
      ? buildX402PaymentResponseEnvelope({
          service: requestedService,
          signer,
          cost: requestCost,
          remainingCredits: consumed.after,
          requestId,
          issuedAt,
          receipt,
        })
      : null;

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
      authSource,
      ...(x402PaymentResponse ? { x402: { paymentResponse: x402PaymentResponse } } : {}),
    },
    signer,
    nonce: payload.nonce,
    requestId,
    cost: requestCost,
    remainingCredits: consumed.after,
    metadata: {
      nonceAccepted: consumed.nonceAccepted,
      costSource: requestCostSource,
      authSource,
      ...(x402ParsedEnvelope ? { x402Envelope: true } : {}),
    },
    headers: x402PaymentResponse ? { "payment-response": encodeBase64Json(x402PaymentResponse) } : undefined,
  });
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}
