export const MAX_TARGETED_ERC8004_REFRESH_IDS = 50;
export const MAX_ERC8004_METADATA_REFRESH_BATCH_SIZE = 2_000;

export type MirroredAgentMetadata = {
  name: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
};

export type MirroredAgentMetadataUpdate = {
  name?: string;
  image?: string | null;
  description?: string | null;
  telegram?: string | null;
  twitter?: string | null;
  website?: string | null;
};

export type RotatingBatchWindow = {
  offset: number;
  limit: number;
  nextOffset: number;
};

export type MetadataFetchFailureDetails = {
  message: string;
  code?: string | null;
  httpStatus?: number | null;
};

export type MetadataFetchFailureClassification = {
  reason:
    | "timeout"
    | "empty_token_uri"
    | "unfetchable_token_uri"
    | "invalid_json"
    | "invalid_url"
    | "dns_unresolved"
    | "connection_refused"
    | `http_${number}`
    | "unexpected_error";
  expected: boolean;
  permanent: boolean;
  timedOut: boolean;
};

const NUMERIC_ID_PATTERN = /^\d+$/;

export const parseNumericRefreshSelector = (
  rawValues: Array<string | null | undefined>,
  label: string,
  maxItems = MAX_TARGETED_ERC8004_REFRESH_IDS,
): string[] => {
  const values = rawValues
    .flatMap((raw) => (raw ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    return [];
  }

  const uniqueValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!NUMERIC_ID_PATTERN.test(value)) {
      throw new Error(`Invalid ${label} selector "${value}". Expected one or more numeric ids.`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    uniqueValues.push(value);
  }

  if (uniqueValues.length > maxItems) {
    throw new Error(
      `Targeted ERC-8004 metadata refresh supports at most ${maxItems} ${label} selector(s) per run.`,
    );
  }

  return uniqueValues;
};

export const computeMirroredMetadataPatch = (
  current: MirroredAgentMetadata,
  next: MirroredAgentMetadataUpdate,
): MirroredAgentMetadataUpdate => {
  const patch: MirroredAgentMetadataUpdate = {};

  for (const key of Object.keys(next) as Array<keyof MirroredAgentMetadata>) {
    const value = next[key];
    if (value === undefined) continue;
    if (current[key] === value) continue;
    if (key === "name") {
      if (typeof value === "string") {
        patch.name = value;
      }
      continue;
    }

    patch[key] = value as Exclude<MirroredAgentMetadata[typeof key], undefined>;
  }

  return patch;
};

export const computeRotatingBatchWindow = (
  totalItems: number,
  batchSize: number,
  cursorOffset: number,
): RotatingBatchWindow => {
  if (!Number.isFinite(totalItems) || totalItems <= 0) {
    return { offset: 0, limit: 0, nextOffset: 0 };
  }

  const normalizedBatchSize = Math.max(1, Math.min(Math.trunc(batchSize), totalItems));
  const normalizedCursor = Math.max(0, Math.trunc(cursorOffset));
  const offset = normalizedCursor >= totalItems ? 0 : normalizedCursor;
  const remaining = totalItems - offset;
  const limit = Math.min(normalizedBatchSize, remaining);
  const nextOffset = offset + limit >= totalItems ? 0 : offset + limit;

  return {
    offset,
    limit,
    nextOffset,
  };
};

export const classifyMetadataFetchFailure = (
  input: MetadataFetchFailureDetails,
): MetadataFetchFailureClassification => {
  const message = input.message.trim();
  const code = input.code?.trim() || null;
  const httpStatus = input.httpStatus ?? null;

  if (/abort|timed out|timeout/i.test(message) || code === "ABORT_ERR") {
    return {
      reason: "timeout",
      expected: true,
      permanent: false,
      timedOut: true,
    };
  }

  if (/tokenURI returned empty value/i.test(message)) {
    return {
      reason: "empty_token_uri",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  if (/tokenURI is not a fetchable metadata URI/i.test(message)) {
    return {
      reason: "unfetchable_token_uri",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  if (
    /Metadata payload is not a JSON object/i.test(message) ||
    /Unexpected token/i.test(message) ||
    /Unexpected end of JSON input/i.test(message) ||
    /not valid JSON/i.test(message)
  ) {
    return {
      reason: "invalid_json",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  if (httpStatus !== null) {
    if (httpStatus === 429) {
      return {
        reason: "http_429",
        expected: false,
        permanent: false,
        timedOut: false,
      };
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      return {
        reason: `http_${httpStatus}`,
        expected: true,
        permanent: true,
        timedOut: false,
      };
    }
    if (httpStatus >= 500) {
      return {
        reason: `http_${httpStatus}`,
        expected: false,
        permanent: false,
        timedOut: false,
      };
    }
  }

  if (code === "ERR_INVALID_URL") {
    return {
      reason: "invalid_url",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  if (code === "ENOTFOUND") {
    return {
      reason: "dns_unresolved",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  if (code === "ECONNREFUSED") {
    return {
      reason: "connection_refused",
      expected: true,
      permanent: true,
      timedOut: false,
    };
  }

  return {
    reason: "unexpected_error",
    expected: false,
    permanent: false,
    timedOut: false,
  };
};
