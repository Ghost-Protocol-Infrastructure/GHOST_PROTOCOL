import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const settlementJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const normalizeSecret = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const safeSecretEquals = (provided: string | null, expected: string | null): boolean => {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
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

const getSettlementOperatorSecrets = (): string[] => {
  const settlementSecret = normalizeSecret(process.env.GHOST_SETTLEMENT_OPERATOR_SECRET);
  if (settlementSecret) return [settlementSecret];

  // Temporary rollout fallback: if the dedicated settlement secret is not yet
  // configured in the deployed app env, allow the existing operator secret that
  // already protects the fulfillment expire-sweep automation.
  const expireSweepSecret = normalizeSecret(process.env.GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET);
  return expireSweepSecret ? [expireSweepSecret] : [];
};

export const isSettlementOperatorAuthorized = (request: NextRequest): boolean => {
  const provided = getProvidedSecret(request, "x-ghost-settlement-operator-secret");
  return getSettlementOperatorSecrets().some((expected) => safeSecretEquals(provided, expected));
};

export const isSettlementSupportAuthorized = (request: NextRequest): boolean => {
  const expected = normalizeSecret(process.env.GHOST_SETTLEMENT_SUPPORT_SECRET);
  const provided = getProvidedSecret(request, "x-ghost-settlement-support-secret");
  return safeSecretEquals(provided, expected);
};
