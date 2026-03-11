import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const ghostWireAdminJson = (body: unknown, status = 200): NextResponse =>
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

const getGhostWireOperatorSecret = (): string | null =>
  normalizeSecret(process.env.GHOSTWIRE_OPERATOR_SECRET) ??
  normalizeSecret(process.env.GHOST_WIRE_OPERATOR_SECRET) ??
  normalizeSecret(process.env.GHOST_SETTLEMENT_OPERATOR_SECRET);

const getGhostWireSupportSecret = (): string | null =>
  normalizeSecret(process.env.GHOSTWIRE_SUPPORT_SECRET) ?? normalizeSecret(process.env.GHOST_WIRE_SUPPORT_SECRET);

export const isGhostWireOperatorAuthorized = (request: NextRequest): boolean => {
  const provided = getProvidedSecret(request, "x-ghostwire-operator-secret");
  const expected = getGhostWireOperatorSecret();
  return safeSecretEquals(provided, expected);
};

export const isGhostWireSupportAuthorized = (request: NextRequest): boolean => {
  const provided = getProvidedSecret(request, "x-ghostwire-support-secret");
  const expected = getGhostWireSupportSecret();
  return safeSecretEquals(provided, expected);
};
