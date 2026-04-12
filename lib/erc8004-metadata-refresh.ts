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
