import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

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

export const resolveGhostWireExecSecret = (): string | null =>
  normalizeSecret(process.env.GHOSTWIRE_EXEC_SECRET) ??
  normalizeSecret(process.env.GHOST_WIRE_EXEC_SECRET);

export const isGhostWireExecSecretConfigured = (): boolean => Boolean(resolveGhostWireExecSecret());

export const resolveGhostWireExecProvidedSecret = (request: NextRequest): string | null => {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const headerSecret = request.headers.get("x-ghostwire-exec-secret")?.trim();
  if (headerSecret) return headerSecret;

  return null;
};

export const isGhostWireExecAuthorized = (request: NextRequest): boolean =>
  safeSecretEquals(resolveGhostWireExecProvidedSecret(request), resolveGhostWireExecSecret());
