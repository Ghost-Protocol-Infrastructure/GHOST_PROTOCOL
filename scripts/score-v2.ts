import { createPublicClient, fallback, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { type AgentTier, SnapshotStatus } from "@prisma/client";
import { prisma } from "../lib/db";

type AgentIndexMode = "erc8004" | "olas";
type ScoreTxSource = "owner" | "creator";

type AgentSourceRow = {
  address: string;
  agentId: string;
  name: string;
  creator: string;
  owner: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
  status: string;
  yield: number;
  uptime: number;
  createdAt: Date;
  updatedAt: Date;
};

type ScoreInputRow = {
  agentAddress: string;
  agentId: string;
  name: string;
  creator: string;
  owner: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
  status: string;
  txSourceAddress: string | null;
  txCount: number;
  yield: number;
  uptime: number;
  isClaimed: boolean;
  txCountUpdatedAt: Date | null;
};

type PendingInputUpsert = {
  agentAddress: string;
  agentId: string;
  name: string;
  creator: string;
  owner: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
  status: string;
  txSourceAddress: string | null;
  txCount: number;
  yieldValue: number;
  uptime: number;
  isClaimed: boolean;
  txCountUpdatedAt: Date | null;
};

type FetchTxCountsResult = {
  txCountBySourceAddressLower: Map<string, number>;
  failures: number;
  fetched: number;
  total: number;
  budgetReached: boolean;
};

type SnapshotScoreRow = {
  agentAddress: string;
  agentId: string;
  name: string;
  creator: string;
  owner: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
  status: string;
  rank: number;
  tier: AgentTier;
  txCount: number;
  reputation: number;
  rankScore: number;
  yieldValue: number;
  uptime: number;
  volume: bigint;
  score: number;
  agentCreatedAt: Date;
  agentUpdatedAt: Date;
};

const AGENT_INDEX_MODE: AgentIndexMode =
  process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";
const SCORE_TX_SOURCE: ScoreTxSource = (() => {
  const raw = process.env.SCORE_TX_SOURCE?.trim().toLowerCase();
  if (raw === "owner" || raw === "creator") return raw;
  return AGENT_INDEX_MODE === "olas" ? "creator" : "owner";
})();

const SCORE_V2_ENABLED = process.env.SCORE_V2_ENABLED?.trim().toLowerCase() === "true";
const SCORE_V2_SHADOW_ONLY = process.env.SCORE_V2_SHADOW_ONLY?.trim().toLowerCase() !== "false";
const SCORE_V2_FORCE_RUN = process.argv.includes("--force");

const INDEXER_RPC_URL =
  process.env.BASE_RPC_URL_INDEXER?.trim() || process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const INDEXER_RPC_ENV = process.env.BASE_RPC_URL_INDEXER?.trim()
  ? "BASE_RPC_URL_INDEXER"
  : process.env.BASE_RPC_URL?.trim()
    ? "BASE_RPC_URL"
    : "default";

const parseBoundedInt = (raw: string | undefined, fallbackValue: number, min: number, max: number): number => {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallbackValue;
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(parsed, max));
};

const SCORE_V2_INGEST_BATCH_SIZE = parseBoundedInt(process.env.SCORE_V2_INGEST_BATCH_SIZE, 150, 25, 500);
const SCORE_V2_SNAPSHOT_BATCH_SIZE = parseBoundedInt(process.env.SCORE_V2_SNAPSHOT_BATCH_SIZE, 1_000, 100, 5_000);
const SCORE_V2_AGENT_WRITE_BATCH_SIZE = parseBoundedInt(process.env.SCORE_V2_AGENT_WRITE_BATCH_SIZE, 100, 25, 500);
const SCORE_V2_STALE_TX_BATCH = parseBoundedInt(process.env.SCORE_V2_STALE_TX_BATCH, 500, 0, 5_000);
const SCORE_V2_STALE_TX_MINUTES = parseBoundedInt(process.env.SCORE_V2_STALE_TX_MINUTES, 240, 5, 2_880);

const SCORE_V2_TX_CONCURRENCY = parseBoundedInt(process.env.SCORE_V2_TX_CONCURRENCY, 20, 1, 60);
const SCORE_V2_TX_BATCH_DELAY_MS = parseBoundedInt(process.env.SCORE_V2_TX_BATCH_DELAY_MS, 10, 0, 2_000);
const SCORE_V2_HEARTBEAT_INTERVAL = parseBoundedInt(process.env.SCORE_V2_HEARTBEAT_INTERVAL, 100, 10, 2_000);
const SCORE_V2_TX_CALL_TIMEOUT_MS = parseBoundedInt(process.env.SCORE_V2_TX_CALL_TIMEOUT_MS, 10_000, 2_000, 60_000);
const SCORE_V2_RPC_TIMEOUT_MS = parseBoundedInt(process.env.SCORE_V2_RPC_TIMEOUT_MS, 10_000, 2_000, 60_000);
const SCORE_V2_TX_RPC_TIMEOUT_MS = Math.min(SCORE_V2_TX_CALL_TIMEOUT_MS, SCORE_V2_RPC_TIMEOUT_MS);
const SCORE_V2_RPC_RETRY_COUNT = parseBoundedInt(process.env.SCORE_V2_RPC_RETRY_COUNT, 1, 0, 5);
const SCORE_V2_TX_BUDGET_MS = parseBoundedInt(process.env.SCORE_V2_TX_BUDGET_MS, 10 * 60_000, 60_000, 60 * 60_000);

const SCORE_V2_PRISMA_RETRY_ATTEMPTS = parseBoundedInt(process.env.SCORE_V2_PRISMA_RETRY_ATTEMPTS, 4, 1, 8);
const SCORE_V2_PRISMA_RETRY_DELAY_MS = parseBoundedInt(process.env.SCORE_V2_PRISMA_RETRY_DELAY_MS, 1_000, 100, 10_000);
const SCORE_V2_PRISMA_CONNECTION_TIMEOUT_MS = parseBoundedInt(
  process.env.SCORE_V2_PRISMA_CONNECTION_TIMEOUT_MS,
  12_000,
  2_000,
  60_000,
);
const SCORE_V2_STATE_PREFIX = process.env.SCORE_V2_STATE_PREFIX?.trim() || "score_v2";
const SCORE_V2_FORCE_EXIT_ON_FINISH =
  process.env.SCORE_V2_FORCE_EXIT_ON_FINISH?.trim().toLowerCase() === "true" ||
  process.env.CI?.trim().toLowerCase() === "true";

const UNCLAIMED_REPUTATION_CAP = 80;
const REPUTATION_TX_WEIGHT = 0.3;
const REPUTATION_UPTIME_WEIGHT = 0.5;
const REPUTATION_YIELD_WEIGHT = 0.2;
const RANK_REPUTATION_WEIGHT = 0.7;
const RANK_VELOCITY_WEIGHT = 0.3;
const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000";
const FAILURE_REASON_MAX_LENGTH = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

const normalizeLog100 = (value: number, maxValue: number): number => {
  if (maxValue <= 0) return 0;

  const numerator = Math.log10(value + 1);
  const denominator = Math.log10(maxValue + 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return clamp(roundToTwo((numerator / denominator) * 100), 0, 100);
};

const toSafeInt = (value: bigint | number): number => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
  }

  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max) return Number.MAX_SAFE_INTEGER;
  if (value < 0n) return 0;
  return Number(value);
};

const parseAddress = (value: string): Address | null => {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
};

const normalizeSourceAddress = (
  value: string,
): {
  sourceAddressLower: string;
  sourceAddress: Address;
} | null => {
  const parsed = parseAddress(value.trim());
  if (!parsed) return null;

  const sourceAddressLower = parsed.toLowerCase();
  if (sourceAddressLower === ZERO_ADDRESS_LOWER) return null;

  return { sourceAddressLower, sourceAddress: parsed };
};

const resolveTxSourceAddressLower = (row: Pick<AgentSourceRow, "owner" | "creator">): string | null => {
  const primary = SCORE_TX_SOURCE === "owner" ? row.owner : row.creator;
  const secondary = SCORE_TX_SOURCE === "owner" ? row.creator : row.owner;

  const normalizedPrimary = normalizeSourceAddress(primary ?? "");
  if (normalizedPrimary) return normalizedPrimary.sourceAddressLower;

  const normalizedSecondary = normalizeSourceAddress(secondary ?? "");
  return normalizedSecondary ? normalizedSecondary.sourceAddressLower : null;
};

const statusIndicatesClaimed = (status: string): boolean => {
  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return normalized.includes("claimed") || normalized.includes("verified") || normalized.includes("monetized");
};

const getTier = (txCount: number, isClaimed: boolean): AgentTier => {
  if (!isClaimed && txCount <= 0) return "GHOST";
  if (txCount > 500) return "WHALE";
  if (txCount > 50) return "ACTIVE";
  return "NEW";
};

const withTimeout = async <T>(label: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const isRecoverablePrismaError = (error: unknown): boolean => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(postgresql connection|kind:\s*closed|connection.*closed|engine is not yet connected|response from the engine was empty|genericfailure|prismaclientunknownrequesterror|P1001|P1017|timeout|timed out|socket hang up|ECONNRESET|connection reset)/i.test(
    message,
  );
};

const resetPrismaConnection = async (attempt: number): Promise<void> => {
  try {
    await withTimeout("score-v2 prisma.$disconnect", SCORE_V2_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$disconnect());
  } catch (error) {
    console.warn(
      `score-v2 prisma.$disconnect failed during retry reset (attempt ${attempt}/${SCORE_V2_PRISMA_RETRY_ATTEMPTS}). Continuing.`,
    );
    console.error(error);
  }

  await sleep(SCORE_V2_PRISMA_RETRY_DELAY_MS * attempt);

  try {
    await withTimeout("score-v2 prisma.$connect", SCORE_V2_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$connect());
  } catch (error) {
    console.warn(
      `score-v2 prisma.$connect failed during retry reset (attempt ${attempt}/${SCORE_V2_PRISMA_RETRY_ATTEMPTS}).`,
    );
    console.error(error);
  }
};

const withPrismaRetry = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= SCORE_V2_PRISMA_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRecoverablePrismaError(error) || attempt >= SCORE_V2_PRISMA_RETRY_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `${label} failed with recoverable Prisma error (attempt ${attempt}/${SCORE_V2_PRISMA_RETRY_ATTEMPTS}). Retrying...`,
      );
      console.error(error);
      await resetPrismaConnection(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed after retries`);
};

const buildClient = (rpcTimeoutMs: number = SCORE_V2_RPC_TIMEOUT_MS) =>
  createPublicClient({
    chain: base,
    transport: fallback([
      http(INDEXER_RPC_URL, { retryCount: SCORE_V2_RPC_RETRY_COUNT, retryDelay: 250, timeout: rpcTimeoutMs }),
      http("https://base.llamarpc.com", {
        retryCount: SCORE_V2_RPC_RETRY_COUNT,
        retryDelay: 250,
        timeout: rpcTimeoutMs,
      }),
      http("https://1rpc.io/base", {
        retryCount: SCORE_V2_RPC_RETRY_COUNT,
        retryDelay: 250,
        timeout: rpcTimeoutMs,
      }),
    ]),
  });

const stateKey = (key: string): string => `${SCORE_V2_STATE_PREFIX}:${key}`;

const getStateValue = async (key: string): Promise<string | null> => {
  const row = await withPrismaRetry(`score-v2 load state ${key}`, () =>
    prisma.scorePipelineState.findUnique({
      where: { key: stateKey(key) },
      select: { value: true },
    }),
  );
  return row?.value ?? null;
};

const setStateValue = async (key: string, value: string): Promise<void> => {
  await withPrismaRetry(`score-v2 persist state ${key}`, () =>
    prisma.scorePipelineState.upsert({
      where: { key: stateKey(key) },
      create: {
        key: stateKey(key),
        value,
      },
      update: {
        value,
      },
    }),
  );
};

const rotateByOffset = <T>(items: T[], offset: number): T[] => {
  if (items.length <= 1) return items;
  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  if (normalizedOffset === 0) return items;
  return [...items.slice(normalizedOffset), ...items.slice(0, normalizedOffset)];
};

const hasSourceDelta = (
  row: AgentSourceRow,
  existing: ScoreInputRow | undefined,
  txSourceAddress: string | null,
  isClaimed: boolean,
): boolean => {
  if (!existing) return true;
  const nextYield = Math.max(0, row.yield ?? 0);
  const nextUptime = clamp(row.uptime ?? 0, 0, 100);

  return (
    existing.agentId !== row.agentId ||
    existing.name !== row.name ||
    existing.creator !== row.creator ||
    existing.owner !== row.owner ||
    existing.image !== row.image ||
    existing.description !== row.description ||
    existing.telegram !== row.telegram ||
    existing.twitter !== row.twitter ||
    existing.website !== row.website ||
    existing.status !== row.status ||
    existing.txSourceAddress !== txSourceAddress ||
    existing.yield !== nextYield ||
    existing.uptime !== nextUptime ||
    existing.isClaimed !== isClaimed
  );
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};
const upsertScoreInputs = async (rows: PendingInputUpsert[]): Promise<void> => {
  if (rows.length === 0) return;

  let processed = 0;
  for (const chunk of chunkArray(rows, SCORE_V2_INGEST_BATCH_SIZE)) {
    await withPrismaRetry(
      `score-v2 upsert score inputs ${processed + 1}-${Math.min(processed + chunk.length, rows.length)}`,
      () =>
        prisma.$transaction(
          chunk.map((row) =>
            prisma.agentScoreInput.upsert({
              where: { agentAddress: row.agentAddress },
              create: {
                agentAddress: row.agentAddress,
                agentId: row.agentId,
                name: row.name,
                creator: row.creator,
                owner: row.owner,
                image: row.image,
                description: row.description,
                telegram: row.telegram,
                twitter: row.twitter,
                website: row.website,
                status: row.status,
                txSourceAddress: row.txSourceAddress,
                txCount: row.txCount,
                yield: row.yieldValue,
                uptime: row.uptime,
                isClaimed: row.isClaimed,
                txCountUpdatedAt: row.txCountUpdatedAt,
                lastIngestedAt: new Date(),
              },
              update: {
                agentId: row.agentId,
                name: row.name,
                creator: row.creator,
                owner: row.owner,
                image: row.image,
                description: row.description,
                telegram: row.telegram,
                twitter: row.twitter,
                website: row.website,
                status: row.status,
                txSourceAddress: row.txSourceAddress,
                txCount: row.txCount,
                yield: row.yieldValue,
                uptime: row.uptime,
                isClaimed: row.isClaimed,
                txCountUpdatedAt: row.txCountUpdatedAt,
                lastIngestedAt: new Date(),
              },
            }),
          ),
        ),
    );

    processed += chunk.length;
    if (processed % SCORE_V2_HEARTBEAT_INTERVAL === 0 || processed === rows.length) {
      console.log(`Heartbeat: score-v2 ingested ${processed}/${rows.length} score inputs`);
    }
  }
};

const resolveStaleSourceAddresses = async (): Promise<string[]> => {
  if (SCORE_V2_STALE_TX_BATCH <= 0) return [];
  const staleCutoff = new Date(Date.now() - SCORE_V2_STALE_TX_MINUTES * 60_000);
  const staleRows = await withPrismaRetry("score-v2 load stale tx source addresses", () =>
    prisma.agentScoreInput.findMany({
      where: {
        txSourceAddress: { not: null },
        OR: [{ txCountUpdatedAt: null }, { txCountUpdatedAt: { lt: staleCutoff } }],
      },
      select: { txSourceAddress: true },
      distinct: ["txSourceAddress"],
      take: SCORE_V2_STALE_TX_BATCH,
    }),
  );
  return staleRows
    .map((row) => row.txSourceAddress)
    .filter((value): value is string => Boolean(value));
};

const fetchTxCountsBySourceAddress = async (sourceAddresses: string[]): Promise<FetchTxCountsResult> => {
  const txCountBySourceAddressLower = new Map<string, number>();
  const normalizedAddressByLower = new Map<string, Address>();
  let invalidOrZeroCount = 0;

  for (const sourceAddress of sourceAddresses) {
    const normalized = normalizeSourceAddress(sourceAddress);
    if (!normalized) {
      invalidOrZeroCount += 1;
      continue;
    }
    if (!normalizedAddressByLower.has(normalized.sourceAddressLower)) {
      normalizedAddressByLower.set(normalized.sourceAddressLower, normalized.sourceAddress);
    }
  }

  const normalizedAddresses = Array.from(normalizedAddressByLower.entries()).map(
    ([sourceAddressLower, sourceAddress]) => ({
      sourceAddressLower,
      sourceAddress,
    }),
  );

  const duplicateCount = Math.max(0, sourceAddresses.length - invalidOrZeroCount - normalizedAddresses.length);
  if (invalidOrZeroCount > 0 || duplicateCount > 0) {
    console.log(
      `Heartbeat: score-v2 tx source normalization => requested=${sourceAddresses.length}, unique=${normalizedAddresses.length}, duplicate=${duplicateCount}, invalid_or_zero=${invalidOrZeroCount}`,
    );
  }

  const publicClient = buildClient(SCORE_V2_TX_RPC_TIMEOUT_MS);
  let failures = 0;
  const total = normalizedAddresses.length;
  const currentOffsetRaw = await getStateValue("tx_rotation_offset");
  const currentOffset = currentOffsetRaw && /^\d+$/.test(currentOffsetRaw) ? Number.parseInt(currentOffsetRaw, 10) : 0;
  const rotationOffset = total > 0 ? currentOffset % total : 0;
  const orderedAddresses = rotateByOffset(normalizedAddresses, rotationOffset);
  if (total > 1) {
    console.log(
      `Heartbeat: score-v2 tx fetch rotation => stored_offset=${currentOffset}, effective_offset=${rotationOffset}, total=${total}`,
    );
  }
  const startedAt = Date.now();
  let fetched = 0;
  let budgetReached = false;

  for (let index = 0; index < orderedAddresses.length; index += SCORE_V2_TX_CONCURRENCY) {
    if (Date.now() - startedAt >= SCORE_V2_TX_BUDGET_MS) {
      budgetReached = true;
      console.warn(
        `score-v2 tx fetch budget reached (${SCORE_V2_TX_BUDGET_MS}ms). Preserving old txCount values for remaining sources.`,
      );
      break;
    }

    const batch = orderedAddresses.slice(index, index + SCORE_V2_TX_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ sourceAddressLower, sourceAddress }) => {
        try {
          const txCountRaw = await withTimeout(`score-v2 txCount ${sourceAddress}`, SCORE_V2_TX_CALL_TIMEOUT_MS, () =>
            publicClient.getTransactionCount({ address: sourceAddress }),
          );
          txCountBySourceAddressLower.set(sourceAddressLower, toSafeInt(txCountRaw));
          fetched += 1;
        } catch (error) {
          failures += 1;
          txCountBySourceAddressLower.set(sourceAddressLower, 0);
          console.warn(`score-v2 failed txCount fetch for ${sourceAddress}. Defaulting to 0.`);
          console.error(error);
          fetched += 1;
        }
      }),
    );

    const processed = Math.min(index + batch.length, total);
    if (processed % SCORE_V2_HEARTBEAT_INTERVAL === 0 || processed === total) {
      console.log(`Heartbeat: score-v2 fetched txCounts ${processed}/${total}`);
    }

    if (index + SCORE_V2_TX_CONCURRENCY < orderedAddresses.length && SCORE_V2_TX_BATCH_DELAY_MS > 0) {
      await sleep(SCORE_V2_TX_BATCH_DELAY_MS);
    }
  }

  const nextOffset = total > 0 ? (currentOffset + Math.max(1, fetched)) % total : 0;
  await setStateValue("tx_rotation_offset", String(nextOffset));

  return { txCountBySourceAddressLower, failures, fetched, total, budgetReached };
};

const persistFetchedTxCounts = async (txCountsBySourceAddress: Map<string, number>): Promise<void> => {
  if (txCountsBySourceAddress.size === 0) return;
  const now = new Date();
  const txEntries = Array.from(txCountsBySourceAddress.entries());
  let processed = 0;

  for (const chunk of chunkArray(txEntries, SCORE_V2_INGEST_BATCH_SIZE)) {
    await withPrismaRetry(
      `score-v2 persist txCount updates ${processed + 1}-${Math.min(processed + chunk.length, txEntries.length)}`,
      () =>
        prisma.$transaction(
          chunk.map(([txSourceAddress, txCount]) =>
            prisma.agentScoreInput.updateMany({
              where: { txSourceAddress },
              data: {
                txCount,
                txCountUpdatedAt: now,
                lastIngestedAt: now,
              },
            }),
          ),
        ),
    );

    processed += chunk.length;
    if (processed % SCORE_V2_HEARTBEAT_INTERVAL === 0 || processed === txEntries.length) {
      console.log(`Heartbeat: score-v2 persisted txCounts ${processed}/${txEntries.length}`);
    }
  }
};

const buildSnapshotRows = (
  inputs: Array<
    ScoreInputRow & {
      createdAt: Date;
      updatedAt: Date;
    }
  >,
): {
  rows: SnapshotScoreRow[];
  maxTxCount: number;
  maxClaimedYield: number;
} => {
  const txCounts = inputs.map((input) => Math.max(0, input.txCount));
  const maxTxCount = txCounts.length > 0 ? Math.max(...txCounts) : 0;
  const claimedYields = inputs
    .map((input) => (input.isClaimed ? Math.max(0, input.yield) : 0))
    .filter((value) => value > 0);
  const maxClaimedYield = claimedYields.length > 0 ? Math.max(...claimedYields) : 0;

  const scored = inputs.map((input) => {
    const txCount = Math.max(0, input.txCount);
    const txVolumeNorm = normalizeLog100(txCount, maxTxCount);
    const velocityNorm = normalizeLog100(txCount, maxTxCount);
    const yieldValue = input.isClaimed ? Math.max(0, input.yield) : 0;
    const uptime = input.isClaimed ? clamp(input.uptime, 0, 100) : 0;
    const yieldNorm = maxClaimedYield > 0 ? clamp((yieldValue / maxClaimedYield) * 100, 0, 100) : 0;

    const reputation = input.isClaimed
      ? roundToTwo(
          txVolumeNorm * REPUTATION_TX_WEIGHT +
            uptime * REPUTATION_UPTIME_WEIGHT +
            yieldNorm * REPUTATION_YIELD_WEIGHT,
        )
      : roundToTwo(Math.min(txVolumeNorm, UNCLAIMED_REPUTATION_CAP));
    const rankScore = roundToTwo(reputation * RANK_REPUTATION_WEIGHT + velocityNorm * RANK_VELOCITY_WEIGHT);
    const tier = getTier(txCount, input.isClaimed);

    return {
      input,
      txCount,
      reputation,
      rankScore,
      tier,
      yieldValue,
      uptime,
      volume: BigInt(txCount),
      score: Math.round(rankScore),
    };
  });

  scored.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    if (b.txCount !== a.txCount) return b.txCount - a.txCount;
    return a.input.agentAddress.localeCompare(b.input.agentAddress);
  });

  const rows: SnapshotScoreRow[] = scored.map((row, index) => ({
    agentAddress: row.input.agentAddress,
    agentId: row.input.agentId,
    name: row.input.name,
    creator: row.input.creator,
    owner: row.input.owner,
    image: row.input.image,
    description: row.input.description,
    telegram: row.input.telegram,
    twitter: row.input.twitter,
    website: row.input.website,
    status: row.input.status,
    rank: index + 1,
    tier: row.tier,
    txCount: row.txCount,
    reputation: row.reputation,
    rankScore: row.rankScore,
    yieldValue: row.yieldValue,
    uptime: row.uptime,
    volume: row.volume,
    score: row.score,
    agentCreatedAt: row.input.createdAt,
    agentUpdatedAt: row.input.updatedAt,
  }));

  return { rows, maxTxCount, maxClaimedYield };
};

const buildFailureReason = (error: unknown): string => {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.slice(0, FAILURE_REASON_MAX_LENGTH);
};
const writeSnapshot = async (
  rows: SnapshotScoreRow[],
  maxTxCount: number,
  maxClaimedYield: number,
): Promise<string> => {
  const startedAt = new Date();
  let snapshotId = "";

  try {
    const snapshot = await withPrismaRetry("score-v2 create leaderboard snapshot", () =>
      prisma.leaderboardSnapshot.create({
        data: {
          mode: AGENT_INDEX_MODE,
          txSource: SCORE_TX_SOURCE,
          status: SnapshotStatus.BUILDING,
          isActive: false,
          totalAgents: rows.length,
          maxTxCount,
          maxClaimedYield,
          startedAt,
        },
        select: { id: true },
      }),
    );
    snapshotId = snapshot.id;

    let inserted = 0;
    for (const chunk of chunkArray(rows, SCORE_V2_SNAPSHOT_BATCH_SIZE)) {
      await withPrismaRetry(
        `score-v2 insert snapshot rows ${inserted + 1}-${Math.min(inserted + chunk.length, rows.length)}`,
        () =>
          prisma.leaderboardSnapshotRow.createMany({
            data: chunk.map((row) => ({
              snapshotId,
              agentAddress: row.agentAddress,
              agentId: row.agentId,
              name: row.name,
              creator: row.creator,
              owner: row.owner,
              image: row.image,
              description: row.description,
              telegram: row.telegram,
              twitter: row.twitter,
              website: row.website,
              status: row.status,
              rank: row.rank,
              tier: row.tier,
              txCount: row.txCount,
              reputation: row.reputation,
              rankScore: row.rankScore,
              yield: row.yieldValue,
              uptime: row.uptime,
              volume: row.volume,
              score: row.score,
              agentCreatedAt: row.agentCreatedAt,
              agentUpdatedAt: row.agentUpdatedAt,
            })),
          }),
      );

      inserted += chunk.length;
      if (inserted % SCORE_V2_HEARTBEAT_INTERVAL === 0 || inserted === rows.length) {
        console.log(`Heartbeat: score-v2 wrote snapshot rows ${inserted}/${rows.length}`);
      }
    }

    await withPrismaRetry("score-v2 activate snapshot", () =>
      prisma.$transaction([
        prisma.leaderboardSnapshot.updateMany({
          where: {
            isActive: true,
            id: { not: snapshotId },
          },
          data: { isActive: false },
        }),
        prisma.leaderboardSnapshot.update({
          where: { id: snapshotId },
          data: {
            status: SnapshotStatus.READY,
            isActive: true,
            completedAt: new Date(),
            totalAgents: rows.length,
            maxTxCount,
            maxClaimedYield,
          },
        }),
      ]),
    );

    return snapshotId;
  } catch (error) {
    if (snapshotId) {
      const failureReason = buildFailureReason(error);
      try {
        await withPrismaRetry("score-v2 mark snapshot failed", () =>
          prisma.leaderboardSnapshot.update({
            where: { id: snapshotId },
            data: {
              status: SnapshotStatus.FAILED,
              isActive: false,
              failureReason,
              completedAt: new Date(),
            },
          }),
        );
      } catch (markError) {
        console.error("score-v2 failed to mark snapshot as FAILED:", markError);
      }
    }
    throw error;
  }
};

const applySnapshotScoresToAgentTable = async (rows: SnapshotScoreRow[]): Promise<void> => {
  if (rows.length === 0) return;
  let processed = 0;
  for (const chunk of chunkArray(rows, SCORE_V2_AGENT_WRITE_BATCH_SIZE)) {
    await withPrismaRetry(
      `score-v2 apply snapshot scores to agent table ${processed + 1}-${Math.min(processed + chunk.length, rows.length)}`,
      () =>
        prisma.$transaction(
          chunk.map((row) =>
            prisma.agent.update({
              where: { address: row.agentAddress },
              data: {
                txCount: row.txCount,
                tier: row.tier,
                reputation: row.reputation,
                rankScore: row.rankScore,
                yield: row.yieldValue,
                uptime: row.uptime,
                volume: row.volume,
                score: row.score,
              },
            }),
          ),
        ),
    );

    processed += chunk.length;
    if (processed % SCORE_V2_HEARTBEAT_INTERVAL === 0 || processed === rows.length) {
      console.log(`Heartbeat: score-v2 applied agent score updates ${processed}/${rows.length}`);
    }
  }
};

const ingestScoreInputs = async (): Promise<{
  totalAgents: number;
  changedInputs: number;
  refreshedSources: number;
  txFetchFailures: number;
  budgetReached: boolean;
}> => {
  const agents = await withPrismaRetry("score-v2 load agents", () =>
    prisma.agent.findMany({
      select: {
        address: true,
        agentId: true,
        name: true,
        creator: true,
        owner: true,
        image: true,
        description: true,
        telegram: true,
        twitter: true,
        website: true,
        status: true,
        yield: true,
        uptime: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  if (agents.length === 0) {
    return {
      totalAgents: 0,
      changedInputs: 0,
      refreshedSources: 0,
      txFetchFailures: 0,
      budgetReached: false,
    };
  }

  const existingInputs = await withPrismaRetry("score-v2 load score inputs", () =>
    prisma.agentScoreInput.findMany({
      select: {
        agentAddress: true,
        agentId: true,
        name: true,
        creator: true,
        owner: true,
        image: true,
        description: true,
        telegram: true,
        twitter: true,
        website: true,
        status: true,
        txSourceAddress: true,
        txCount: true,
        yield: true,
        uptime: true,
        isClaimed: true,
        txCountUpdatedAt: true,
      },
    }),
  );
  const existingByAddress = new Map(existingInputs.map((row) => [row.agentAddress, row]));

  const pendingUpserts: PendingInputUpsert[] = [];
  const changedSourceSet = new Set<string>();

  for (const agent of agents) {
    const txSourceAddress = resolveTxSourceAddressLower(agent);
    const isClaimed = statusIndicatesClaimed(agent.status);
    const existing = existingByAddress.get(agent.address);
    const hasDelta = hasSourceDelta(agent, existing, txSourceAddress, isClaimed);
    if (!hasDelta) continue;

    const sourceChanged = existing?.txSourceAddress !== txSourceAddress;
    const seedTxCount = !sourceChanged && existing ? Math.max(0, existing.txCount) : 0;
    const seedTxCountUpdatedAt = !sourceChanged && existing ? existing.txCountUpdatedAt : null;

    pendingUpserts.push({
      agentAddress: agent.address,
      agentId: agent.agentId,
      name: agent.name,
      creator: agent.creator,
      owner: agent.owner,
      image: agent.image,
      description: agent.description,
      telegram: agent.telegram,
      twitter: agent.twitter,
      website: agent.website,
      status: agent.status,
      txSourceAddress,
      txCount: seedTxCount,
      yieldValue: Math.max(0, agent.yield ?? 0),
      uptime: clamp(agent.uptime ?? 0, 0, 100),
      isClaimed,
      txCountUpdatedAt: seedTxCountUpdatedAt,
    });

    if (txSourceAddress) {
      changedSourceSet.add(txSourceAddress);
    }
  }

  if (pendingUpserts.length > 0) {
    await upsertScoreInputs(pendingUpserts);
  }

  const staleSources = await resolveStaleSourceAddresses();
  for (const sourceAddress of staleSources) {
    changedSourceSet.add(sourceAddress);
  }
  const sourcesToRefresh = Array.from(changedSourceSet);
  const txFetchResult = await fetchTxCountsBySourceAddress(sourcesToRefresh);
  await persistFetchedTxCounts(txFetchResult.txCountBySourceAddressLower);

  return {
    totalAgents: agents.length,
    changedInputs: pendingUpserts.length,
    refreshedSources: txFetchResult.total,
    txFetchFailures: txFetchResult.failures,
    budgetReached: txFetchResult.budgetReached,
  };
};

const runSnapshotRanking = async (): Promise<{
  snapshotId: string;
  totalRows: number;
  maxTxCount: number;
  maxClaimedYield: number;
}> => {
  const inputs = await withPrismaRetry("score-v2 load score inputs for ranking", () =>
    prisma.agentScoreInput.findMany({
      select: {
        agentAddress: true,
        agentId: true,
        name: true,
        creator: true,
        owner: true,
        image: true,
        description: true,
        telegram: true,
        twitter: true,
        website: true,
        status: true,
        txSourceAddress: true,
        txCount: true,
        yield: true,
        uptime: true,
        isClaimed: true,
        txCountUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  if (inputs.length === 0) {
    throw new Error("No score inputs found for v2 snapshot ranking.");
  }

  const { rows, maxTxCount, maxClaimedYield } = buildSnapshotRows(inputs);
  const snapshotId = await writeSnapshot(rows, maxTxCount, maxClaimedYield);

  if (!SCORE_V2_SHADOW_ONLY) {
    await applySnapshotScoresToAgentTable(rows);
  }

  return {
    snapshotId,
    totalRows: rows.length,
    maxTxCount,
    maxClaimedYield,
  };
};

const writeRunState = async (entries: Record<string, string>): Promise<void> => {
  await withPrismaRetry("score-v2 persist run state", () =>
    prisma.$transaction(
      Object.entries(entries).map(([key, value]) =>
        prisma.scorePipelineState.upsert({
          where: { key: stateKey(key) },
          create: { key: stateKey(key), value },
          update: { value },
        }),
      ),
    ),
  );
};
async function main(): Promise<void> {
  if (!SCORE_V2_ENABLED && !SCORE_V2_FORCE_RUN) {
    console.log("score-v2 skipped: SCORE_V2_ENABLED is false. Use --force to run manually.");
    return;
  }

  console.log(
    `score-v2 config: mode=${AGENT_INDEX_MODE}, tx_source=${SCORE_TX_SOURCE}, shadow_only=${SCORE_V2_SHADOW_ONLY}, rpc_env=${INDEXER_RPC_ENV}, tx_concurrency=${SCORE_V2_TX_CONCURRENCY}, tx_call_timeout_ms=${SCORE_V2_TX_CALL_TIMEOUT_MS}, tx_rpc_timeout_ms=${SCORE_V2_TX_RPC_TIMEOUT_MS}, tx_budget_ms=${SCORE_V2_TX_BUDGET_MS}, ingest_batch_size=${SCORE_V2_INGEST_BATCH_SIZE}, snapshot_batch_size=${SCORE_V2_SNAPSHOT_BATCH_SIZE}, stale_tx_batch=${SCORE_V2_STALE_TX_BATCH}, stale_tx_minutes=${SCORE_V2_STALE_TX_MINUTES}`,
  );

  const startedAt = Date.now();
  const ingest = await ingestScoreInputs();
  if (ingest.totalAgents === 0) {
    console.log("score-v2: no agents found. Skipping snapshot generation.");
    return;
  }

  const ranking = await runSnapshotRanking();
  const elapsedMs = Date.now() - startedAt;

  await writeRunState({
    last_run_at: new Date().toISOString(),
    last_run_elapsed_ms: String(elapsedMs),
    last_ingest_agents: String(ingest.totalAgents),
    last_ingest_changed_inputs: String(ingest.changedInputs),
    last_tx_sources_refreshed: String(ingest.refreshedSources),
    last_tx_fetch_failures: String(ingest.txFetchFailures),
    last_tx_budget_reached: ingest.budgetReached ? "true" : "false",
    last_snapshot_id: ranking.snapshotId,
    last_snapshot_rows: String(ranking.totalRows),
    last_snapshot_max_tx_count: String(ranking.maxTxCount),
    last_snapshot_max_claimed_yield: String(ranking.maxClaimedYield),
  });

  console.log(
    `score-v2 complete: snapshot=${ranking.snapshotId}, rows=${ranking.totalRows}, changed_inputs=${ingest.changedInputs}, tx_sources_refreshed=${ingest.refreshedSources}, tx_failures=${ingest.txFetchFailures}${ingest.budgetReached ? ", budget_reached=true" : ""}, elapsed_ms=${elapsedMs}.`,
  );
}

main()
  .catch((error) => {
    console.error("score-v2 failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await withTimeout("score-v2 prisma.$disconnect (final)", SCORE_V2_PRISMA_CONNECTION_TIMEOUT_MS, () =>
        prisma.$disconnect(),
      );
    } catch (disconnectError) {
      console.error("score-v2 failed to disconnect Prisma cleanly:", disconnectError);
    }
    if (SCORE_V2_FORCE_EXIT_ON_FINISH) {
      process.exit(process.exitCode ?? 0);
    }
  });
