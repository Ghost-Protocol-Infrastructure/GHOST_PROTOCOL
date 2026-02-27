import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { recoverTypedDataAddress, verifyTypedData } from "viem";
import { FULFILLMENT_API_VERSION } from "@/lib/fulfillment-types";
import { FULFILLMENT_ZERO_HASH_32 } from "@/lib/fulfillment-hash";
import {
  buildFulfillmentDeliveryProofTypedData,
  hashFulfillmentDeliveryProofTypedData,
  parseWireFulfillmentDeliveryProofMessage,
} from "@/lib/fulfillment-eip712";
import { captureFulfillmentHold } from "@/lib/db";
import { fulfillmentJson, normalizeHex32Lower, normalizeHexSignatureLower } from "@/lib/fulfillment-route";
import { consumeFulfillmentRateLimit } from "@/lib/fulfillment-rate-limit";
import { extractFulfillmentErrorCode, observeFulfillmentResponseEvent } from "@/lib/fulfillment-observability";

export const runtime = "nodejs";

const MAX_PRISMA_INT = 2_147_483_647n;

const toIsoStringSafe = (value: Date | string, field: string): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${field} is not a valid date.`);
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} is not a valid date.`);
  return parsed.toISOString();
};

type CompletionMeta = {
  statusCode: number;
  latencyMs: number;
  responseHash?: `0x${string}` | null;
};

const parseCompletionMeta = (value: unknown): CompletionMeta | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const statusCodeRaw = typeof record.statusCode === "number" ? record.statusCode : null;
  const latencyMsRaw = typeof record.latencyMs === "number" ? record.latencyMs : null;
  const responseHash =
    record.responseHash == null ? null : normalizeHex32Lower(record.responseHash);
  if (statusCodeRaw == null || !Number.isInteger(statusCodeRaw) || statusCodeRaw < 100 || statusCodeRaw > 599) {
    return null;
  }
  if (latencyMsRaw == null || !Number.isInteger(latencyMsRaw) || latencyMsRaw < 0) return null;
  if (record.responseHash != null && !responseHash) return null;
  return { statusCode: statusCodeRaw, latencyMs: latencyMsRaw, responseHash };
};

const parseCaptureRequest = (body: unknown): {
  ticketId: `0x${string}`;
  deliveryProof: { payload: string; signature: `0x${string}` };
  completionMeta?: CompletionMeta;
} | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const ticketId = normalizeHex32Lower(record.ticketId);
  const deliveryProof = record.deliveryProof;
  if (!ticketId || typeof deliveryProof !== "object" || deliveryProof === null || Array.isArray(deliveryProof)) {
    return null;
  }
  const proofRecord = deliveryProof as Record<string, unknown>;
  const payload = typeof proofRecord.payload === "string" ? proofRecord.payload.trim() : "";
  const signature = normalizeHexSignatureLower(proofRecord.signature);
  if (!payload || !signature) return null;

  let completionMetaParsed: CompletionMeta | undefined;
  if (record.completionMeta != null) {
    const parsedCompletionMeta = parseCompletionMeta(record.completionMeta);
    if (!parsedCompletionMeta) return null;
    completionMetaParsed = parsedCompletionMeta;
  }

  return {
    ticketId,
    deliveryProof: { payload, signature },
    completionMeta: completionMetaParsed,
  };
};

const captureResponse = (
  body: unknown,
  status = 200,
  options?: { retryAfterSeconds?: number; meta?: Record<string, unknown> },
): NextResponse => {
  observeFulfillmentResponseEvent({
    route: "capture",
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
  const rateLimit = consumeFulfillmentRateLimit({ request, action: "capture" });
  if (!rateLimit.ok) {
    return captureResponse(
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

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return captureResponse({ code: 400, error: "Invalid JSON body.", errorCode: "INVALID_CAPTURE_REQUEST" }, 400);
    }

    const parsed = parseCaptureRequest(body);
    if (!parsed) {
      return captureResponse(
        { code: 400, error: "Invalid fulfillment capture request shape.", errorCode: "INVALID_CAPTURE_REQUEST" },
        400,
      );
    }

    let deliveryProof;
    try {
      deliveryProof = parseWireFulfillmentDeliveryProofMessage(parsed.deliveryProof.payload);
    } catch (error) {
      return captureResponse(
        {
          code: 400,
          error: "Invalid delivery proof payload.",
          errorCode: "INVALID_DELIVERY_PROOF",
          details: error instanceof Error ? error.message : "Failed to parse delivery proof payload.",
        },
        400,
      );
    }

    if (deliveryProof.ticketId !== parsed.ticketId) {
      return captureResponse(
        {
          code: 400,
          error: "ticketId does not match deliveryProof.ticketId.",
          errorCode: "DELIVERY_PROOF_TICKET_MISMATCH",
        },
        400,
      );
    }

    if (parsed.completionMeta) {
    if (
      deliveryProof.statusCode !== BigInt(parsed.completionMeta.statusCode) ||
      deliveryProof.latencyMs !== BigInt(parsed.completionMeta.latencyMs)
    ) {
      return captureResponse(
        {
          code: 400,
          error: "completionMeta does not match signed delivery proof fields.",
          errorCode: "DELIVERY_PROOF_COMPLETION_META_MISMATCH",
        },
        400,
      );
    }
    if (parsed.completionMeta.responseHash && deliveryProof.responseHash !== parsed.completionMeta.responseHash) {
      return captureResponse(
        {
          code: 400,
          error: "completionMeta.responseHash does not match signed delivery proof.",
          errorCode: "DELIVERY_PROOF_RESPONSE_HASH_MISMATCH",
        },
        400,
      );
    }
    }

    if (deliveryProof.statusCode < 100n || deliveryProof.statusCode > 599n) {
    return captureResponse(
      {
        code: 400,
        error: "deliveryProof.statusCode is out of valid HTTP status range.",
        errorCode: "INVALID_DELIVERY_PROOF",
      },
      400,
    );
    }

    if (deliveryProof.latencyMs < 0n || deliveryProof.latencyMs > MAX_PRISMA_INT) {
    return captureResponse(
      {
        code: 400,
        error: "deliveryProof.latencyMs exceeds supported range.",
        errorCode: "INVALID_DELIVERY_PROOF",
      },
      400,
    );
    }

    let recoveredSigner: `0x${string}`;
    let proofSignatureValid = false;
    try {
      const typedData = buildFulfillmentDeliveryProofTypedData(deliveryProof);
      recoveredSigner = (await recoverTypedDataAddress({
        ...typedData,
        signature: parsed.deliveryProof.signature,
      })).toLowerCase() as `0x${string}`;
      proofSignatureValid = await verifyTypedData({
        address: recoveredSigner,
        ...typedData,
        signature: parsed.deliveryProof.signature,
      });
    } catch {
      return captureResponse(
        {
          code: 401,
          error: "Invalid merchant delivery proof signature.",
          errorCode: "INVALID_MERCHANT_SIGNATURE",
        },
        401,
      );
    }

    if (!proofSignatureValid) {
    return captureResponse(
      {
        code: 401,
        error: "Invalid merchant delivery proof signature.",
        errorCode: "INVALID_MERCHANT_SIGNATURE",
      },
      401,
    );
    }

    if (recoveredSigner !== deliveryProof.merchantSigner) {
    return captureResponse(
      {
        code: 401,
        error: "Delivery proof merchantSigner does not match signature signer.",
        errorCode: "MERCHANT_SIGNER_MISMATCH",
        details: {
          recoveredSigner,
          proofMerchantSigner: deliveryProof.merchantSigner,
        },
      },
      401,
    );
    }

    let captureResult;
    let proofTypedHash: `0x${string}`;
    try {
      proofTypedHash = hashFulfillmentDeliveryProofTypedData(deliveryProof);
      captureResult = await captureFulfillmentHold({
      ticketId: deliveryProof.ticketId,
      deliveryProofId: deliveryProof.deliveryProofId,
      merchantSigner: deliveryProof.merchantSigner,
      serviceSlug: deliveryProof.serviceSlug,
      completedAt: new Date(Number(deliveryProof.completedAt) * 1000),
      statusCode: deliveryProof.statusCode,
      latencyMs: deliveryProof.latencyMs,
      responseHash: deliveryProof.responseHash === FULFILLMENT_ZERO_HASH_32 ? null : deliveryProof.responseHash,
      proofTypedHash,
      rawMeta: {
        completionMetaProvided: parsed.completionMeta != null,
        completionMeta: parsed.completionMeta
          ? {
              statusCode: parsed.completionMeta.statusCode,
              latencyMs: parsed.completionMeta.latencyMs,
              responseHash: parsed.completionMeta.responseHash ?? null,
            }
          : null,
      },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2021" || error.code === "P2022")
      ) {
        return captureResponse(
          {
            code: 503,
            error: "Phase C fulfillment schema is not available in this environment yet.",
            errorCode: "PHASE_C_SCHEMA_UNAVAILABLE",
          },
          503,
        );
      }
      throw error;
    }

    if (captureResult.status === "hold_not_found") {
    return captureResponse(
      {
        code: 404,
        error: "Fulfillment hold not found for ticketId.",
        errorCode: "FULFILLMENT_HOLD_NOT_FOUND",
      },
      404,
    );
    }

    if (captureResult.status === "unauthorized_signer") {
    return captureResponse(
      {
        code: 403,
        error: "Merchant signer is not an active delegated signer for this gateway.",
        errorCode: "UNAUTHORIZED_DELEGATED_SIGNER",
        details: {
          ticketId: captureResult.ticketId,
          holdId: captureResult.holdId,
          gatewayConfigId: captureResult.gatewayConfigId,
          merchantSigner: deliveryProof.merchantSigner,
        },
      },
      403,
    );
    }

    if (captureResult.status === "service_mismatch") {
    return captureResponse(
      {
        code: 409,
        error: "Delivery proof service does not match the held ticket service.",
        errorCode: "SERVICE_MISMATCH",
        details: {
          ticketId: captureResult.ticketId,
          holdId: captureResult.holdId,
          expectedServiceSlug: captureResult.expectedServiceSlug,
          providedServiceSlug: captureResult.providedServiceSlug,
        },
      },
      409,
    );
    }

    if (captureResult.status === "expired_due") {
      return captureResponse(
        {
          code: 409,
          error: "Ticket hold expired before capture completion.",
          errorCode: "HOLD_EXPIRED",
          details: {
            ticketId: captureResult.ticketId,
            holdId: captureResult.holdId,
            expiresAt: toIsoStringSafe(captureResult.expiresAt, "captureResult.expiresAt"),
          },
        },
        409,
      );
    }

    if (captureResult.status === "terminal") {
    return captureResponse(
      {
        code: 409,
        error: "Ticket hold is not active.",
        errorCode: "HOLD_NOT_ACTIVE",
        details: {
          ticketId: captureResult.ticketId,
          holdId: captureResult.holdId,
          state: captureResult.state,
          deliveryProofId: captureResult.deliveryProofId,
        },
      },
      409,
    );
    }

    if (captureResult.status === "capture_conflict") {
    return captureResponse(
      {
        code: 409,
        error: "Ticket already captured with a different delivery proof.",
        errorCode: "CAPTURE_CONFLICT",
        details: {
          ticketId: captureResult.ticketId,
          holdId: captureResult.holdId,
          state: captureResult.state,
          existingDeliveryProofId: captureResult.existingDeliveryProofId,
          providedDeliveryProofId: deliveryProof.deliveryProofId,
        },
      },
      409,
    );
    }

    return captureResponse(
      {
        ok: true,
        apiVersion: FULFILLMENT_API_VERSION,
        ticketId: captureResult.ticketId,
        state: "CAPTURED",
        captureDisposition: captureResult.captureDisposition,
        deliveryProofId: captureResult.deliveryProofId,
        capturedAt: toIsoStringSafe(captureResult.capturedAt, "captureResult.capturedAt"),
        validated: {
          serviceSlug: captureResult.serviceSlug,
          merchantSigner: captureResult.merchantSigner,
          proofTypedHash,
          statusCode: Number(deliveryProof.statusCode),
          latencyMs: Number(deliveryProof.latencyMs),
          responseHash: deliveryProof.responseHash === FULFILLMENT_ZERO_HASH_32 ? null : deliveryProof.responseHash,
          ...(captureResult.status === "captured"
            ? {
                creditsBefore: captureResult.creditsBefore.toString(),
                creditsAfter: captureResult.creditsAfter.toString(),
                heldCreditsBefore: captureResult.heldCreditsBefore.toString(),
                heldCreditsAfter: captureResult.heldCreditsAfter.toString(),
                holdId: captureResult.holdId,
              }
            : { holdId: captureResult.holdId }),
        },
      },
      200,
    );
  } catch (error) {
    console.error("Fulfillment capture route error:", error);
    return captureResponse(
      {
        code: 500,
        error: "Fulfillment capture failed due to an internal error.",
        errorCode: "FULFILLMENT_CAPTURE_FAILED",
      },
      500,
    );
  }
}
