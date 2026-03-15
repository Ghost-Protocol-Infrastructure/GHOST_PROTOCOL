import { createHash } from "node:crypto";
import type { Hex32 } from "@/lib/fulfillment-types";

export class FulfillmentCanonicalizationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FulfillmentCanonicalizationError";
  }
}

export const FULFILLMENT_ZERO_HASH_32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const satisfies Hex32;

const textEncoder = new TextEncoder();
const PERCENT_ESCAPE_INVALID = /%(?![0-9A-Fa-f]{2})/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const jsonPrimitiveCanonical = (value: string | number | boolean | null): string => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_JSON_NON_FINITE_NUMBER",
      "JSON canonicalization rejects non-finite numbers.",
    );
  }
  const serialized = JSON.stringify(value);
  if (serialized == null) {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_JSON_UNSUPPORTED_PRIMITIVE",
      "Unsupported primitive during JSON canonicalization.",
    );
  }
  return serialized;
};

const canonicalizeJsonValue = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return jsonPrimitiveCanonical(value);
  }
  if (typeof value === "bigint") {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_JSON_BIGINT_UNSUPPORTED",
      "JSON canonicalization does not support bigint values. Convert to string first.",
    );
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") {
        throw new FulfillmentCanonicalizationError(
          "FULFILLMENT_JSON_ARRAY_UNSUPPORTED_VALUE",
          "Array contains unsupported value for canonical JSON hashing.",
        );
      }
      return canonicalizeJsonValue(item);
    });
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_JSON_NON_PLAIN_OBJECT",
      "Canonical JSON hashing only supports plain objects and arrays.",
    );
  }

  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const serialized = entries.map(([key, entryValue]) => {
    if (typeof entryValue === "undefined" || typeof entryValue === "function" || typeof entryValue === "symbol") {
      throw new FulfillmentCanonicalizationError(
        "FULFILLMENT_JSON_OBJECT_UNSUPPORTED_VALUE",
        `Object key '${key}' contains unsupported value for canonical JSON hashing.`,
      );
    }
    return `${JSON.stringify(key)}:${canonicalizeJsonValue(entryValue)}`;
  });
  return `{${serialized.join(",")}}`;
};

export const canonicalizeJsonJcs = (value: unknown): string => canonicalizeJsonValue(value);

const lowerHexSha256 = (bytes: Uint8Array): Hex32 => `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex32;

export const sha256HexUtf8 = (value: string): Hex32 => lowerHexSha256(textEncoder.encode(value));

export const hashCanonicalJsonJcs = (value: unknown): Hex32 => sha256HexUtf8(canonicalizeJsonJcs(value));

const validatePercentEscapes = (value: string): void => {
  if (PERCENT_ESCAPE_INVALID.test(value)) {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_QUERY_MALFORMED_PERCENT_ESCAPE",
      "Query string contains malformed percent escape.",
    );
  }
};

const decodeFormComponent = (value: string): string => {
  validatePercentEscapes(value);
  const plusAsSpace = value.replace(/\+/g, "%20");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    throw new FulfillmentCanonicalizationError(
      "FULFILLMENT_QUERY_INVALID_UTF8",
      "Query string contains invalid UTF-8 percent encoding.",
    );
  }
};

const encodeRfc3986Upper = (value: string): string =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (match) => match.toUpperCase());

export type FulfillmentCanonicalQueryPair = { key: string; value: string };

export const canonicalizeFulfillmentQuery = (
  rawQuery: string | null | undefined,
): { canonical: string; pairs: FulfillmentCanonicalQueryPair[] } => {
  const raw = (rawQuery ?? "").trim();
  const source = raw.startsWith("?") ? raw.slice(1) : raw;
  if (!source) {
    return { canonical: "", pairs: [] };
  }

  const parsedPairs: FulfillmentCanonicalQueryPair[] = [];
  const seenKeys = new Set<string>();
  const rawPairs = source.split("&").filter((segment) => segment.length > 0);

  for (const rawPair of rawPairs) {
    const eqIndex = rawPair.indexOf("=");
    const rawKey = eqIndex === -1 ? rawPair : rawPair.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : rawPair.slice(eqIndex + 1);

    const key = decodeFormComponent(rawKey);
    const value = decodeFormComponent(rawValue);

    if (!key) {
      throw new FulfillmentCanonicalizationError(
        "FULFILLMENT_QUERY_EMPTY_KEY",
        "Query string contains an empty key, which is not supported in the current fulfillment flow.",
      );
    }

    if (seenKeys.has(key)) {
      throw new FulfillmentCanonicalizationError(
        "FULFILLMENT_QUERY_DUPLICATE_KEY",
        `Query string contains duplicate key '${key}', which is not supported in the current fulfillment flow.`,
      );
    }
    seenKeys.add(key);
    parsedPairs.push({ key, value });
  }

  parsedPairs.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    if (a.value < b.value) return -1;
    if (a.value > b.value) return 1;
    return 0;
  });

  const canonical = parsedPairs
    .map(({ key, value }) => `${encodeRfc3986Upper(key)}=${encodeRfc3986Upper(value)}`)
    .join("&");

  return { canonical, pairs: parsedPairs };
};

export const hashCanonicalFulfillmentQuery = (rawQuery: string | null | undefined): Hex32 => {
  const { canonical } = canonicalizeFulfillmentQuery(rawQuery);
  return canonical ? sha256HexUtf8(canonical) : FULFILLMENT_ZERO_HASH_32;
};

export const hashCanonicalFulfillmentBodyJson = (payload: unknown): Hex32 => hashCanonicalJsonJcs(payload);
