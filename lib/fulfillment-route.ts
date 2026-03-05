import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const FULFILLMENT_EXPIRE_SWEEP_DEFAULT_LIMIT = 100;
export const FULFILLMENT_EXPIRE_SWEEP_MAX_LIMIT = 1000;
export const FULFILLMENT_JSON_BODY_MAX_BYTES = 32 * 1024;

export const fulfillmentJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const parseBooleanFlag = (value: string | null): boolean =>
  value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export const parsePositiveIntBounded = (input: {
  value: string | null;
  fallback: number;
  max: number;
}): number => {
  const raw = input.value?.trim();
  if (!raw) return input.fallback;
  if (!/^\d+$/.test(raw)) return input.fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return input.fallback;
  return Math.min(parsed, input.max);
};

export const normalizeHex32Lower = (value: unknown): `0x${string}` | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

export const normalizeHexSignatureLower = (value: unknown): `0x${string}` | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]+$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

const normalizeSecret = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const getProvidedSecret = (request: NextRequest, customHeaderName: string): string | null => {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const headerSecret = request.headers.get(customHeaderName)?.trim();
  if (headerSecret) return headerSecret;
  return null;
};

const secretsEqual = (expected: string, provided: string): boolean => {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
};

export const parseJsonBodyWithLimit = async (
  request: NextRequest,
  options?: {
    maxBytes?: number;
    invalidJsonErrorCode?: string;
    payloadTooLargeErrorCode?: string;
  },
): Promise<
  | { ok: true; body: unknown }
  | {
      ok: false;
      status: 400 | 413;
      error: string;
      errorCode: string;
    }
> => {
  const maxBytes = Math.max(1_024, options?.maxBytes ?? FULFILLMENT_JSON_BODY_MAX_BYTES);
  const contentLengthRaw = request.headers.get("content-length")?.trim();
  if (contentLengthRaw && /^\d+$/.test(contentLengthRaw)) {
    const contentLength = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: "Request body too large.",
        errorCode: options?.payloadTooLargeErrorCode ?? "PAYLOAD_TOO_LARGE",
      };
    }
  }

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Invalid JSON body.",
      errorCode: options?.invalidJsonErrorCode ?? "INVALID_JSON_BODY",
    };
  }

  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "Request body too large.",
      errorCode: options?.payloadTooLargeErrorCode ?? "PAYLOAD_TOO_LARGE",
    };
  }

  try {
    return { ok: true, body: JSON.parse(rawBody) };
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Invalid JSON body.",
      errorCode: options?.invalidJsonErrorCode ?? "INVALID_JSON_BODY",
    };
  }
};

export const isFulfillmentExpireSweepAuthorized = (request: NextRequest): boolean => {
  const expected = normalizeSecret(process.env.GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET);
  if (!expected) return false;
  const provided = getProvidedSecret(request, "x-ghost-fulfillment-expire-secret");
  if (!provided) return false;
  return secretsEqual(expected, provided);
};

export const isFulfillmentSupportAuthorized = (request: NextRequest): boolean => {
  const expected = normalizeSecret(process.env.GHOST_FULFILLMENT_SUPPORT_SECRET);
  if (!expected) return false;
  const provided = getProvidedSecret(request, "x-ghost-fulfillment-support-secret");
  if (!provided) return false;
  return secretsEqual(expected, provided);
};
