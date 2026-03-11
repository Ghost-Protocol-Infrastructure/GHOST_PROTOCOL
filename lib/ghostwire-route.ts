import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { parseJsonBodyWithLimit } from "@/lib/fulfillment-route";

export const GHOSTWIRE_JSON_BODY_MAX_BYTES = 32 * 1024;

export const ghostWireJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const parseGhostWireJsonBody = async (request: NextRequest) =>
  parseJsonBodyWithLimit(request, {
    maxBytes: GHOSTWIRE_JSON_BODY_MAX_BYTES,
    invalidJsonErrorCode: "INVALID_WIRE_JSON_BODY",
    payloadTooLargeErrorCode: "WIRE_PAYLOAD_TOO_LARGE",
  });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseRequiredString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const parseOptionalString = (value: unknown): string | null => {
  if (value == null) return null;
  return parseRequiredString(value);
};

export const parseHttpUrlString = (value: unknown): string | null => {
  const parsed = parseOptionalString(value);
  if (!parsed) return null;

  try {
    const url = new URL(parsed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export const parseAtomicAmountString = (value: unknown): bigint | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
};

export const parseHex32String = (value: unknown): `0x${string}` | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

export const parseAddressString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value.trim()).toLowerCase();
  } catch {
    return null;
  }
};
