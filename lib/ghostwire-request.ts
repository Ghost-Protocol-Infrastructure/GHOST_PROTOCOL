import { getAddress, isAddress, keccak256, stringToHex } from "viem";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GhostWireRequestPayload = {
  version: 1;
  prompt: string;
  walletAddress?: string | null;
  metadata?: { [key: string]: JsonValue } | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeJsonValue = (value: unknown): JsonValue | undefined => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized === undefined) return undefined;
      items.push(normalized);
    }
    return items;
  }
  if (!isRecord(value)) return undefined;

  const normalizedRecord: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeJsonValue(entry);
    if (normalized === undefined) return undefined;
    normalizedRecord[key] = normalized;
  }
  return normalizedRecord;
};

const sortJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value)
      .sort()
      .reduce<{ [key: string]: JsonValue }>((result, key) => {
        result[key] = sortJsonValue(value[key]);
        return result;
      }, {});
  }
  return value;
};

export const normalizeGhostWireRequestPayload = (value: unknown): GhostWireRequestPayload | null => {
  if (!isRecord(value)) return null;

  const prompt = normalizeOptionalString(value.prompt);
  if (!prompt) return null;

  const version = value.version;
  if (version != null && version !== 1) return null;

  const walletAddressRaw = normalizeOptionalString(value.walletAddress);
  if (walletAddressRaw && !isAddress(walletAddressRaw)) {
    return null;
  }

  const hasMetadataField = Object.prototype.hasOwnProperty.call(value, "metadata");
  const metadataValue = hasMetadataField ? normalizeJsonValue(value.metadata) : undefined;
  if (hasMetadataField && metadataValue === undefined) {
    return null;
  }

  const normalized: GhostWireRequestPayload = {
    version: 1,
    prompt,
  };

  if (walletAddressRaw) {
    normalized.walletAddress = getAddress(walletAddressRaw);
  }

  if (hasMetadataField) {
    normalized.metadata = metadataValue as GhostWireRequestPayload["metadata"];
  }

  return normalized;
};

export const canonicalizeGhostWireRequestPayload = (value: GhostWireRequestPayload): string => {
  const normalized = normalizeGhostWireRequestPayload(value);
  if (!normalized) {
    throw new Error("Invalid GhostWire request payload.");
  }

  const canonicalValue: JsonValue = {
    version: normalized.version,
    prompt: normalized.prompt,
    ...(normalized.walletAddress ? { walletAddress: normalized.walletAddress } : {}),
    ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
  };

  return JSON.stringify(sortJsonValue(canonicalValue));
};

export const hashGhostWireRequestPayload = (value: GhostWireRequestPayload): `0x${string}` =>
  keccak256(stringToHex(canonicalizeGhostWireRequestPayload(value)));
