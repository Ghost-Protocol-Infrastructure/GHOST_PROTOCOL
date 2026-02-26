import { NextRequest, NextResponse } from "next/server";

export const FULFILLMENT_EXPIRE_SWEEP_DEFAULT_LIMIT = 100;
export const FULFILLMENT_EXPIRE_SWEEP_MAX_LIMIT = 1000;

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

const getProvidedExpireSweepSecret = (request: NextRequest): string | null => {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const headerSecret = request.headers.get("x-ghost-fulfillment-expire-secret")?.trim();
  if (headerSecret) return headerSecret;
  const querySecret = request.nextUrl.searchParams.get("secret")?.trim();
  if (querySecret) return querySecret;
  return null;
};

export const isFulfillmentExpireSweepAuthorized = (request: NextRequest): boolean => {
  const expected = normalizeSecret(process.env.GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET);
  if (!expected) return false;
  const provided = getProvidedExpireSweepSecret(request);
  return provided === expected;
};

