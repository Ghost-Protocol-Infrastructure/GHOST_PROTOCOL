import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export const TELEMETRY_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const API_KEY_PREFIX_LENGTH = 8;

export const normalizeOptionalString = (value: unknown, maxLength = 256): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
};

export const normalizeOptionalStatusCode = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 100 || value > 999) return null;
  return value;
};

export const deriveApiKeyFields = (
  rawApiKey: unknown,
): { apiKeyHash: string | null; apiKeyPrefix: string | null } => {
  const apiKey = normalizeOptionalString(rawApiKey, 512);
  if (!apiKey) {
    return {
      apiKeyHash: null,
      apiKeyPrefix: null,
    };
  }

  const digest = createHash("sha256").update(apiKey).digest("hex");
  const prefix = apiKey.slice(0, Math.min(API_KEY_PREFIX_LENGTH, apiKey.length));

  return {
    apiKeyHash: digest,
    apiKeyPrefix: prefix,
  };
};

export const isSchemaUnavailableError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022");
