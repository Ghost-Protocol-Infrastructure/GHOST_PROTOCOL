import { createPublicClient, fallback, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import {
  Prisma,
  type AgentRailMode,
  type AgentTier,
  type AgentTxSourceKind,
  type CanonicalAddressSource,
  SnapshotStatus,
  type TxMetricSource,
} from "@prisma/client";
import { statusIndicatesClaimed } from "../lib/agent-claim";
import { prisma } from "../lib/db";
import {
  computeCommerceQuality,
  computeDepthConfidence,
  computeExpressConfidence,
  computeWireConfidence,
  normalizeLog100,
  scoreAgentRailAware,
} from "../lib/ghostrank-rail-score";
import {
  computeFallbackProxyTxSignal,
  isFallbackTxMetricSource,
  resolveScoreV2Tier,
} from "../lib/score-v2-fallback-signal";
import {
  buildScoreV2RailMetricFields,
  scoreV2RailMetricFieldsChanged,
} from "../lib/score-v2-rail-sync";
import { fetchGhostWireProviderRollups, GHOSTWIRE_SCORE_WINDOW_DAYS } from "../lib/ghostwire-score-rollup";
import { resolveScoreV2RunMode, shouldWriteScoreV2AgentTable } from "../lib/score-v2-run-mode";

type AgentIndexMode = "erc8004" | "olas";
type ScoreTxSource = "agent" | "owner" | "creator";
type ResolvedTxSourceKind = "agent" | "owner" | "creator";

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
  txSourceKind: AgentTxSourceKind;
  canonicalOnchainAddress: string | null;
  canonicalAddressSource: CanonicalAddressSource;
  txCount: number;
  onchainTxCountAgent: number | null;
  onchainTxCountOwner: number;
  usageAuthorizedCount7d: number;
  metricSource: TxMetricSource;
  yield: number;
  expressYield: number;
  wireYield: number;
  uptime: number;
  commerceQuality: number;
  expressConfidence: number;
  wireConfidence: number;
  wireCompletedCount30d: number;
  wireRejectedCount30d: number;
  wireExpiredCount30d: number;
  wireSettledPrincipal30d: bigint;
  wireSettledProviderEarnings30d: bigint;
  expressReputation: number | null;
  wireReputation: number | null;
  railMode: AgentRailMode;
  isClaimed: boolean;
  txCountUpdatedAt: Date | null;
};

type ExistingScoreInputSeedRow = Pick<
  ScoreInputRow,
  | "agentAddress"
  | "agentId"
  | "name"
  | "creator"
  | "owner"
  | "image"
  | "description"
  | "telegram"
  | "twitter"
  | "website"
  | "status"
  | "txSourceAddress"
  | "txSourceKind"
  | "canonicalOnchainAddress"
  | "canonicalAddressSource"
  | "txCount"
  | "onchainTxCountAgent"
  | "onchainTxCountOwner"
  | "usageAuthorizedCount7d"
  | "metricSource"
  | "yield"
  | "expressYield"
  | "uptime"
  | "isClaimed"
  | "txCountUpdatedAt"
>;

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
  txSourceKind: AgentTxSourceKind;
  canonicalOnchainAddress: string | null;
  canonicalAddressSource: CanonicalAddressSource;
  txCount: number;
  onchainTxCountAgent: number | null;
  onchainTxCountOwner: number;
  usageAuthorizedCount7d: number;
  metricSource: TxMetricSource;
  yieldValue: number;
  expressYield: number;
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

type GateSybilSignal = {
  authorizedCount: number;
  uniqueSignerCount: number;
  replayCount: number;
  invalidSignatureCount: number;
  topSignerAuthorizedCount: number;
};

type GateSybilSignalSnapshot = {
  byAgentId: Map<string, GateSybilSignal>;
  hasCoverage: boolean;
  servicesTracked: number;
  totalAuthorizedEvents: number;
  since: Date;
  windowMinutes: number;
};

type GateSybilSignalAggregateRow = {
  service: string;
  authorized_count: bigint;
  replay_count: bigint;
  invalid_signature_count: bigint;
  unique_signer_count: bigint;
  top_signer_authorized_count: bigint;
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
  onchainTxCountAgent: number | null;
  onchainTxCountOwner: number;
  usageAuthorizedCount7d: number;
  metricSource: TxMetricSource;
  canonicalOnchainAddress: string | null;
  canonicalAddressSource: CanonicalAddressSource;
  reputation: number;
  rankScore: number;
  yieldValue: number;
  expressYield: number;
  wireYield: number;
  uptime: number;
  commerceQuality: number;
  expressConfidence: number;
  wireConfidence: number;
  expressReputation: number | null;
  wireReputation: number | null;
  railMode: AgentRailMode;
  volume: bigint;
  score: number;
  agentCreatedAt: Date;
  agentUpdatedAt: Date;
};

const AGENT_INDEX_MODE: AgentIndexMode =
  process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";
const SCORE_TX_SOURCE: ScoreTxSource = (() => {
  const raw = process.env.SCORE_TX_SOURCE?.trim().toLowerCase();
  if (raw === "agent" || raw === "owner" || raw === "creator") return raw;
  return AGENT_INDEX_MODE === "olas" ? "creator" : "agent";
})();

const SCORE_V2_ENABLED = process.env.SCORE_V2_ENABLED?.trim().toLowerCase() === "true";
const SCORE_V2_SHADOW_ONLY = process.env.SCORE_V2_SHADOW_ONLY?.trim().toLowerCase() !== "false";
const SCORE_V2_FORCE_RUN = process.argv.includes("--force");
const SCORE_V2_RUN_MODE = resolveScoreV2RunMode(process.argv.slice(2));
const SCORE_V2_WRITE_AGENT_TABLE = shouldWriteScoreV2AgentTable(process.env.SCORE_V2_WRITE_AGENT_TABLE);

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
const SCORE_V2_SYBIL_GUARD_ENABLED =
  (process.env.SCORE_V2_SYBIL_GUARD_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
const SCORE_V2_SYNTHETIC_USAGE_PRIMARY = (() => {
  const raw = process.env.SCORE_V2_SYNTHETIC_USAGE_PRIMARY?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return AGENT_INDEX_MODE === "erc8004";
})();
const SCORE_V2_SYBIL_WINDOW_MINUTES = parseBoundedInt(
  process.env.SCORE_V2_SYBIL_WINDOW_MINUTES,
  7 * 24 * 60,
  60,
  30 * 24 * 60,
);

const UNCLAIMED_REPUTATION_CAP = 80;
const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000";
const FAILURE_REASON_MAX_LENGTH = 1_000;
const SYBIL_MIN_SAMPLE_SIZE = 8;
const SYBIL_UNIQUE_SIGNAL_WEIGHT = 0.6;
const SYBIL_TX_SIGNAL_WEIGHT = 0.4;
const SYBIL_CONCENTRATION_THRESHOLD = 0.75;
const SYBIL_REPLAY_RATE_THRESHOLD = 0.2;
const SYBIL_INVALID_RATE_THRESHOLD = 0.25;
const SYBIL_LOW_DIVERSITY_AUTHORIZED_THRESHOLD = 12;
const SYBIL_LOW_DIVERSITY_SIGNER_THRESHOLD = 2;
const SYBIL_MAX_PENALTY = 30;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

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

const resolveTxSourceAddress = (
  row: Pick<AgentSourceRow, "address" | "owner" | "creator">,
): { sourceAddressLower: string; sourceKind: ResolvedTxSourceKind } | null => {
  const candidates: Array<{ kind: ResolvedTxSourceKind; value: string }> =
    SCORE_TX_SOURCE === "agent"
      ? [
          { kind: "agent", value: row.address },
          { kind: "owner", value: row.owner },
          { kind: "creator", value: row.creator },
        ]
      : SCORE_TX_SOURCE === "owner"
        ? [
            { kind: "owner", value: row.owner },
            { kind: "creator", value: row.creator },
            { kind: "agent", value: row.address },
          ]
        : [
            { kind: "creator", value: row.creator },
            { kind: "owner", value: row.owner },
            { kind: "agent", value: row.address },
          ];

  for (const candidate of candidates) {
    const normalized = normalizeSourceAddress(candidate.value ?? "");
    if (normalized) {
      return {
        sourceAddressLower: normalized.sourceAddressLower,
        sourceKind: candidate.kind,
      };
    }
  }
  return null;
};

const resolveCanonicalOnchainAddress = (
  row: Pick<AgentSourceRow, "address">,
): { canonicalOnchainAddress: string | null; canonicalAddressSource: CanonicalAddressSource } => {
  const normalized = normalizeSourceAddress(row.address ?? "");
  if (!normalized) {
    return {
      canonicalOnchainAddress: null,
      canonicalAddressSource: "NONE",
    };
  }
  return {
    canonicalOnchainAddress: normalized.sourceAddressLower,
    canonicalAddressSource: "AGENT_ADDRESS",
  };
};

const toAgentTxSourceKind = (sourceKind: ResolvedTxSourceKind | null): AgentTxSourceKind => {
  if (sourceKind === "agent") return "AGENT";
  if (sourceKind === "owner") return "OWNER";
  if (sourceKind === "creator") return "CREATOR";
  return "UNRESOLVED";
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

const parseAgentIdFromServiceSlug = (service: string): string | null => {
  const match = /^agent-(\d+)$/i.exec(service.trim());
  return match ? match[1] : null;
};

const calculateSybilPenalty = (signal: GateSybilSignal): number => {
  if (signal.authorizedCount < SYBIL_MIN_SAMPLE_SIZE) return 0;

  let penalty = 0;

  const topSignerShare =
    signal.authorizedCount > 0 ? signal.topSignerAuthorizedCount / signal.authorizedCount : 0;
  if (topSignerShare > SYBIL_CONCENTRATION_THRESHOLD) {
    penalty += ((topSignerShare - SYBIL_CONCENTRATION_THRESHOLD) / (1 - SYBIL_CONCENTRATION_THRESHOLD)) * 16;
  }

  if (
    signal.uniqueSignerCount <= SYBIL_LOW_DIVERSITY_SIGNER_THRESHOLD &&
    signal.authorizedCount >= SYBIL_LOW_DIVERSITY_AUTHORIZED_THRESHOLD
  ) {
    penalty += 8;
  }

  const replayDenominator = signal.authorizedCount + signal.replayCount;
  const replayRate = replayDenominator > 0 ? signal.replayCount / replayDenominator : 0;
  if (replayRate > SYBIL_REPLAY_RATE_THRESHOLD) {
    penalty += ((replayRate - SYBIL_REPLAY_RATE_THRESHOLD) / (1 - SYBIL_REPLAY_RATE_THRESHOLD)) * 8;
  }

  const invalidDenominator = signal.authorizedCount + signal.invalidSignatureCount + signal.replayCount;
  const invalidRate = invalidDenominator > 0 ? signal.invalidSignatureCount / invalidDenominator : 0;
  if (invalidRate > SYBIL_INVALID_RATE_THRESHOLD) {
    penalty += ((invalidRate - SYBIL_INVALID_RATE_THRESHOLD) / (1 - SYBIL_INVALID_RATE_THRESHOLD)) * 6;
  }

  return clamp(roundToTwo(penalty), 0, SYBIL_MAX_PENALTY);
};

const emptyGateSybilSignalSnapshot = (windowMinutes: number): GateSybilSignalSnapshot => ({
  byAgentId: new Map(),
  hasCoverage: false,
  servicesTracked: 0,
  totalAuthorizedEvents: 0,
  since: new Date(Date.now() - windowMinutes * 60_000),
  windowMinutes,
});

const fetchGateSybilSignals = async (): Promise<GateSybilSignalSnapshot> => {
  const empty = emptyGateSybilSignalSnapshot(SCORE_V2_SYBIL_WINDOW_MINUTES);
  if (!SCORE_V2_SYBIL_GUARD_ENABLED) return empty;

  try {
    const tableCheck = await withPrismaRetry("score-v2 check GateAccessEvent table", () =>
      prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
        SELECT to_regclass('public."GateAccessEvent"')::text AS relation
      `),
    );

    if (!tableCheck[0]?.relation) {
      return empty;
    }
  } catch (error) {
    console.warn("score-v2 sybil telemetry check failed. Continuing without sybil guard.");
    console.error(error);
    return empty;
  }

  const since = new Date(Date.now() - SCORE_V2_SYBIL_WINDOW_MINUTES * 60_000);

  try {
    const rows = await withPrismaRetry("score-v2 aggregate gate sybil signals", () =>
      prisma.$queryRaw<GateSybilSignalAggregateRow[]>(Prisma.sql`
        WITH recent AS (
          SELECT "service", "signer", "outcome"
          FROM "GateAccessEvent"
          WHERE "createdAt" >= ${since}
            AND "service" LIKE 'agent-%'
        ),
        authorized_signer_counts AS (
          SELECT
            "service",
            "signer",
            COUNT(*)::bigint AS signer_count
          FROM recent
          WHERE "outcome" = 'AUTHORIZED'
            AND "signer" IS NOT NULL
          GROUP BY "service", "signer"
        ),
        top_signers AS (
          SELECT
            "service",
            MAX(signer_count)::bigint AS top_signer_authorized_count
          FROM authorized_signer_counts
          GROUP BY "service"
        )
        SELECT
          recent."service" AS service,
          COUNT(*) FILTER (WHERE recent."outcome" = 'AUTHORIZED')::bigint AS authorized_count,
          COUNT(*) FILTER (WHERE recent."outcome" = 'REPLAY')::bigint AS replay_count,
          COUNT(*) FILTER (WHERE recent."outcome" = 'INVALID_SIGNATURE')::bigint AS invalid_signature_count,
          COUNT(DISTINCT recent."signer") FILTER (
            WHERE recent."outcome" = 'AUTHORIZED'
              AND recent."signer" IS NOT NULL
          )::bigint AS unique_signer_count,
          COALESCE(top_signers.top_signer_authorized_count, 0)::bigint AS top_signer_authorized_count
        FROM recent
        LEFT JOIN top_signers
          ON top_signers."service" = recent."service"
        GROUP BY recent."service", top_signers.top_signer_authorized_count
      `),
    );

    const byAgentId = new Map<string, GateSybilSignal>();
    let totalAuthorizedEvents = 0;

    for (const row of rows) {
      const agentId = parseAgentIdFromServiceSlug(row.service);
      if (!agentId) continue;

      const signal: GateSybilSignal = {
        authorizedCount: toSafeInt(row.authorized_count),
        replayCount: toSafeInt(row.replay_count),
        invalidSignatureCount: toSafeInt(row.invalid_signature_count),
        uniqueSignerCount: toSafeInt(row.unique_signer_count),
        topSignerAuthorizedCount: toSafeInt(row.top_signer_authorized_count),
      };

      byAgentId.set(agentId, signal);
      totalAuthorizedEvents += signal.authorizedCount;
    }

    return {
      byAgentId,
      hasCoverage: totalAuthorizedEvents > 0,
      servicesTracked: byAgentId.size,
      totalAuthorizedEvents,
      since,
      windowMinutes: SCORE_V2_SYBIL_WINDOW_MINUTES,
    };
  } catch (error) {
    console.warn("score-v2 sybil telemetry aggregation failed. Continuing without sybil guard.");
    console.error(error);
    return {
      ...empty,
      since,
    };
  }
};

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
  existing: ExistingScoreInputSeedRow | undefined,
  txSourceAddress: string | null,
  txSourceKind: AgentTxSourceKind,
  canonicalOnchainAddress: string | null,
  canonicalAddressSource: CanonicalAddressSource,
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
    existing.txSourceKind !== txSourceKind ||
    existing.canonicalOnchainAddress !== canonicalOnchainAddress ||
    existing.canonicalAddressSource !== canonicalAddressSource ||
    existing.yield !== nextYield ||
    existing.expressYield !== nextYield ||
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
                txSourceKind: row.txSourceKind,
                canonicalOnchainAddress: row.canonicalOnchainAddress,
                canonicalAddressSource: row.canonicalAddressSource,
                txCount: row.txCount,
                onchainTxCountAgent: row.onchainTxCountAgent,
                onchainTxCountOwner: row.onchainTxCountOwner,
                usageAuthorizedCount7d: row.usageAuthorizedCount7d,
                metricSource: row.metricSource,
                yield: row.yieldValue,
                expressYield: row.expressYield,
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
                txSourceKind: row.txSourceKind,
                canonicalOnchainAddress: row.canonicalOnchainAddress,
                canonicalAddressSource: row.canonicalAddressSource,
                txCount: row.txCount,
                onchainTxCountAgent: row.onchainTxCountAgent,
                onchainTxCountOwner: row.onchainTxCountOwner,
                usageAuthorizedCount7d: row.usageAuthorizedCount7d,
                metricSource: row.metricSource,
                yield: row.yieldValue,
                expressYield: row.expressYield,
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
          console.warn(`score-v2 failed txCount fetch for ${sourceAddress}. Preserving previous txCount value.`);
          console.error(error);
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

const syncRailMetricsToScoreInputs = async (
  agents: AgentSourceRow[],
  existingRailMetricsByAddress: Map<
    string,
    {
      wireYield: number;
      commerceQuality: number;
      wireConfidence: number;
      wireCompletedCount30d: number;
      wireRejectedCount30d: number;
      wireExpiredCount30d: number;
      wireSettledPrincipal30d: bigint;
      wireSettledProviderEarnings30d: bigint;
    }
  >,
): Promise<number> => {
  if (agents.length === 0) return 0;

  const since = new Date(Date.now() - GHOSTWIRE_SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const wireRollupsByAgentId = await fetchGhostWireProviderRollups(since);
  let processed = 0;
  let updatedRows = 0;
  const now = new Date();

  for (const chunk of chunkArray(agents, SCORE_V2_AGENT_WRITE_BATCH_SIZE)) {
    const pendingRailUpdates = chunk.flatMap((agent) => {
      const currentRailMetrics = existingRailMetricsByAddress.get(agent.address);
      const nextRailMetrics = buildScoreV2RailMetricFields(wireRollupsByAgentId.get(agent.agentId));
      if (!scoreV2RailMetricFieldsChanged(currentRailMetrics, nextRailMetrics)) return [];
      return [{ agentAddress: agent.address, nextRailMetrics }];
    });

    if (pendingRailUpdates.length > 0) {
      await withPrismaRetry(
        `score-v2 sync rail metrics ${processed + 1}-${Math.min(processed + chunk.length, agents.length)}`,
        () =>
          prisma.$transaction(
            pendingRailUpdates.map(({ agentAddress, nextRailMetrics }) =>
              prisma.agentScoreInput.update({
                where: { agentAddress },
                data: {
                  wireYield: nextRailMetrics.wireYield,
                  commerceQuality: nextRailMetrics.commerceQuality,
                  wireConfidence: nextRailMetrics.wireConfidence,
                  wireCompletedCount30d: nextRailMetrics.wireCompletedCount30d,
                  wireRejectedCount30d: nextRailMetrics.wireRejectedCount30d,
                  wireExpiredCount30d: nextRailMetrics.wireExpiredCount30d,
                  wireSettledPrincipal30d: nextRailMetrics.wireSettledPrincipal30d,
                  wireSettledProviderEarnings30d: nextRailMetrics.wireSettledProviderEarnings30d,
                  lastIngestedAt: now,
                },
              }),
            ),
          ),
      );
      updatedRows += pendingRailUpdates.length;
    }

    processed += chunk.length;
    if (processed % SCORE_V2_HEARTBEAT_INTERVAL === 0 || processed === agents.length) {
      console.log(`Heartbeat: score-v2 synced rail metrics ${processed}/${agents.length} (updated=${updatedRows})`);
    }
  }

  console.log(`score-v2 rail sync complete: scanned=${agents.length}, updated=${updatedRows}.`);
  return updatedRows;
};

const buildSnapshotRows = (
  inputs: Array<
    ScoreInputRow & {
      createdAt: Date;
      updatedAt: Date;
    }
  >,
  gateSybilSignals: GateSybilSignalSnapshot,
): {
  rows: SnapshotScoreRow[];
  maxTxCount: number;
  maxClaimedYield: number;
  sybilPenalizedAgents: number;
  sybilMaxPenalty: number;
  txMetricPathCounts: Record<"agent_onchain" | "synthetic_usage" | "fallback_tx", number>;
} => {
  const preparedInputs = inputs.map((input) => {
    const gateSignal = gateSybilSignals.byAgentId.get(input.agentId) ?? {
      authorizedCount: 0,
      uniqueSignerCount: 0,
      replayCount: 0,
      invalidSignatureCount: 0,
      topSignerAuthorizedCount: 0,
    };
    const onchainTxCount = Math.max(0, input.txCount);
    const usageAuthorizedCount = Math.max(0, gateSignal.authorizedCount);
    const normalizedAgentAddress = input.canonicalOnchainAddress ?? parseAddress(input.agentAddress)?.toLowerCase() ?? null;
    const txSourceAddressLower = input.txSourceAddress?.toLowerCase() ?? null;
    const isAgentOnchainSource =
      normalizedAgentAddress !== null && txSourceAddressLower !== null && txSourceAddressLower === normalizedAgentAddress;
    const onchainTxCountAgent = isAgentOnchainSource ? onchainTxCount : null;
    const onchainTxCountOwner = input.txSourceKind === "OWNER" ? onchainTxCount : Math.max(0, input.onchainTxCountOwner ?? 0);
    const metricSource: TxMetricSource =
      onchainTxCountAgent !== null
        ? "AGENT_ONCHAIN"
        : SCORE_V2_SYNTHETIC_USAGE_PRIMARY && usageAuthorizedCount > 0
          ? "USAGE_ACTIVITY_7D"
          : input.txSourceKind === "OWNER"
            ? "OWNER_FALLBACK"
            : input.txSourceKind === "CREATOR"
              ? "CREATOR_FALLBACK"
              : "UNRESOLVED";
    const effectiveTxCount =
      metricSource === "AGENT_ONCHAIN"
        ? onchainTxCount
        : metricSource === "USAGE_ACTIVITY_7D"
          ? usageAuthorizedCount
          : onchainTxCount;
    const txMetricPath =
      metricSource === "AGENT_ONCHAIN"
        ? "agent_onchain"
        : metricSource === "USAGE_ACTIVITY_7D"
          ? "synthetic_usage"
          : "fallback_tx";

    return {
      input,
      gateSignal,
      metricSource,
      txSourceAddressLower,
      onchainTxCountAgent,
      onchainTxCountOwner,
      usageAuthorizedCount7d: usageAuthorizedCount,
      effectiveTxCount: Math.max(0, effectiveTxCount),
      canonicalOnchainAddress: normalizedAgentAddress,
      canonicalAddressSource: normalizedAgentAddress
        ? input.canonicalAddressSource === "NONE"
          ? "AGENT_ADDRESS"
          : input.canonicalAddressSource
        : "NONE",
      txMetricPath,
    } as const;
  });
  const txCounts = preparedInputs.map((item) => item.effectiveTxCount);
  const maxTxCount = txCounts.length > 0 ? Math.max(...txCounts) : 0;
  const fallbackClusterSizeBySourceAddressLower = new Map<string, number>();
  for (const item of preparedInputs) {
    if (!isFallbackTxMetricSource(item.metricSource) || !item.txSourceAddressLower) continue;
    fallbackClusterSizeBySourceAddressLower.set(
      item.txSourceAddressLower,
      (fallbackClusterSizeBySourceAddressLower.get(item.txSourceAddressLower) ?? 0) + 1,
    );
  }
  const uniqueSignerCounts = preparedInputs.map((item) => Math.max(0, item.gateSignal.uniqueSignerCount));
  const maxUniqueSignerCount = uniqueSignerCounts.length > 0 ? Math.max(...uniqueSignerCounts) : 0;
  const claimedExpressYields = inputs
    .map((input) => (input.isClaimed ? Math.max(0, input.expressYield) : 0))
    .filter((value) => value > 0);
  const maxClaimedYield = claimedExpressYields.length > 0 ? Math.max(...claimedExpressYields) : 0;
  const claimedWireYields = inputs
    .map((input) => (input.isClaimed ? Math.max(0, input.wireYield) : 0))
    .filter((value) => value > 0);
  const maxClaimedWireYield = claimedWireYields.length > 0 ? Math.max(...claimedWireYields) : 0;
  const maxWireSettledPrincipal = preparedInputs.reduce(
    (maxValue, item) => Math.max(maxValue, item.input.isClaimed ? toSafeInt(item.input.wireSettledPrincipal30d) : 0),
    0,
  );
  const totalSignalWeight = SYBIL_UNIQUE_SIGNAL_WEIGHT + SYBIL_TX_SIGNAL_WEIGHT;
  const normalizedUniqueSignalWeight = totalSignalWeight > 0 ? SYBIL_UNIQUE_SIGNAL_WEIGHT / totalSignalWeight : 0.5;
  const normalizedTxSignalWeight = totalSignalWeight > 0 ? SYBIL_TX_SIGNAL_WEIGHT / totalSignalWeight : 0.5;
  let sybilPenalizedAgents = 0;
  let sybilMaxPenalty = 0;
  const txMetricPathCounts: Record<"agent_onchain" | "synthetic_usage" | "fallback_tx", number> = {
    agent_onchain: 0,
    synthetic_usage: 0,
    fallback_tx: 0,
  };

  const scored = preparedInputs.map((prepared) => {
    const { input, gateSignal } = prepared;
    const txCount = prepared.effectiveTxCount;
    txMetricPathCounts[prepared.txMetricPath] += 1;
    const rawTxVolumeNorm = normalizeLog100(txCount, maxTxCount);
    const fallbackClusterSize =
      isFallbackTxMetricSource(prepared.metricSource) && prepared.txSourceAddressLower
        ? Math.max(1, fallbackClusterSizeBySourceAddressLower.get(prepared.txSourceAddressLower) ?? 1)
        : 1;
    const txVolumeNorm = isFallbackTxMetricSource(prepared.metricSource)
      ? computeFallbackProxyTxSignal(rawTxVolumeNorm, fallbackClusterSize)
      : rawTxVolumeNorm;
    const uniqueSignerCount = Math.max(0, gateSignal.uniqueSignerCount);
    const uniqueSignerNorm =
      gateSybilSignals.hasCoverage && maxUniqueSignerCount > 0
        ? normalizeLog100(uniqueSignerCount, maxUniqueSignerCount)
        : txVolumeNorm;
    const velocityNorm = roundToTwo(
      txVolumeNorm * normalizedTxSignalWeight + uniqueSignerNorm * normalizedUniqueSignalWeight,
    );
    const expressYieldValue = input.isClaimed ? Math.max(0, input.expressYield) : 0;
    const wireYieldValue = input.isClaimed ? Math.max(0, input.wireYield) : 0;
    const uptime = input.isClaimed ? clamp(input.uptime, 0, 100) : 0;
    const wireCompletedCount = input.isClaimed ? Math.max(0, input.wireCompletedCount30d) : 0;
    const wireRejectedCount = input.isClaimed ? Math.max(0, input.wireRejectedCount30d) : 0;
    const wireExpiredCount = input.isClaimed ? Math.max(0, input.wireExpiredCount30d) : 0;
    const wireTerminalJobs = wireCompletedCount + wireRejectedCount + wireExpiredCount;
    const wireSettledPrincipal = input.isClaimed ? toSafeInt(input.wireSettledPrincipal30d) : 0;
    const expressYieldNorm = maxClaimedYield > 0 ? normalizeLog100(expressYieldValue, maxClaimedYield) : 0;
    const wireYieldNorm = maxClaimedWireYield > 0 ? normalizeLog100(wireYieldValue, maxClaimedWireYield) : 0;
    const volumeConfidence =
      maxWireSettledPrincipal > 0 ? normalizeLog100(wireSettledPrincipal, maxWireSettledPrincipal) / 100 : 0;
    const depthConfidence = computeDepthConfidence(wireTerminalJobs, 10);
    const commerceQuality = input.isClaimed
      ? computeCommerceQuality({
          completedCount: wireCompletedCount,
          rejectedCount: wireRejectedCount,
          expiredCount: wireExpiredCount,
          volumeConfidence,
          depthConfidence,
        })
      : 0;
    const expressConfidence = input.isClaimed
      ? computeExpressConfidence({
          usageAuthorizedCount7d: prepared.usageAuthorizedCount7d,
          uptime,
          expressYield: expressYieldValue,
        })
      : 0;
    const wireConfidence = input.isClaimed
      ? computeWireConfidence({
          terminalJobs: wireTerminalJobs,
          settledPrincipal: wireSettledPrincipal,
          settledProviderEarnings: wireYieldValue,
        })
      : 0;
    const antiWashPenalty = gateSybilSignals.hasCoverage ? calculateSybilPenalty(gateSignal) : 0;

    if (antiWashPenalty > 0) {
      sybilPenalizedAgents += 1;
      sybilMaxPenalty = Math.max(sybilMaxPenalty, antiWashPenalty);
    }

    const railScore = input.isClaimed
      ? scoreAgentRailAware({
          velocity: velocityNorm,
          antiWashPenalty,
          express:
            prepared.usageAuthorizedCount7d > 0 || uptime > 0 || expressYieldValue > 0
              ? {
                  uptime,
                  expressYieldNorm,
                  confidence: expressConfidence,
                }
              : null,
          wire:
            wireTerminalJobs > 0 || wireYieldValue > 0
              ? {
                  commerceQuality,
                  wireYieldNorm,
                  confidence: wireConfidence,
                }
              : null,
        })
      : null;
    const reputation = input.isClaimed
      ? railScore?.reputation ?? 0
      : roundToTwo(Math.min(velocityNorm, UNCLAIMED_REPUTATION_CAP));
    const rankScore = input.isClaimed
      ? railScore?.rankScore ?? 0
      : roundToTwo(clamp(reputation * 0.7 + velocityNorm * 0.3 - antiWashPenalty, 0, 100));
    const tier = resolveScoreV2Tier(txCount, input.isClaimed, prepared.metricSource);

    return {
      input,
      txCount,
      txSignalStrength: txVolumeNorm,
      onchainTxCountAgent: prepared.onchainTxCountAgent,
      onchainTxCountOwner: prepared.onchainTxCountOwner,
      usageAuthorizedCount7d: prepared.usageAuthorizedCount7d,
      metricSource: prepared.metricSource,
      canonicalOnchainAddress: prepared.canonicalOnchainAddress,
      canonicalAddressSource: prepared.canonicalAddressSource,
      reputation,
      rankScore,
      tier,
      yieldValue: expressYieldValue,
      expressYield: expressYieldValue,
      wireYield: wireYieldValue,
      uptime,
      commerceQuality,
      expressConfidence,
      wireConfidence,
      expressReputation: railScore?.expressReputation ?? null,
      wireReputation: railScore?.wireReputation ?? null,
      railMode: railScore?.railMode ?? "UNPROVEN",
      volume: BigInt(txCount),
      score: Math.round(rankScore),
      antiWashPenalty,
    };
  });

  scored.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    if (a.antiWashPenalty !== b.antiWashPenalty) return a.antiWashPenalty - b.antiWashPenalty;
    if (b.txSignalStrength !== a.txSignalStrength) return b.txSignalStrength - a.txSignalStrength;
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
    onchainTxCountAgent: row.onchainTxCountAgent,
    onchainTxCountOwner: row.onchainTxCountOwner,
    usageAuthorizedCount7d: row.usageAuthorizedCount7d,
    metricSource: row.metricSource,
    canonicalOnchainAddress: row.canonicalOnchainAddress,
    canonicalAddressSource: row.canonicalAddressSource,
    reputation: row.reputation,
    rankScore: row.rankScore,
    yieldValue: row.yieldValue,
    expressYield: row.expressYield,
    wireYield: row.wireYield,
    uptime: row.uptime,
    commerceQuality: row.commerceQuality,
    expressConfidence: row.expressConfidence,
    wireConfidence: row.wireConfidence,
    expressReputation: row.expressReputation,
    wireReputation: row.wireReputation,
    railMode: row.railMode,
    volume: row.volume,
    score: row.score,
    agentCreatedAt: row.input.createdAt,
    agentUpdatedAt: row.input.updatedAt,
  }));

  return { rows, maxTxCount, maxClaimedYield, sybilPenalizedAgents, sybilMaxPenalty, txMetricPathCounts };
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
              onchainTxCountAgent: row.onchainTxCountAgent,
              onchainTxCountOwner: row.onchainTxCountOwner,
              usageAuthorizedCount7d: row.usageAuthorizedCount7d,
              metricSource: row.metricSource,
              canonicalOnchainAddress: row.canonicalOnchainAddress,
              canonicalAddressSource: row.canonicalAddressSource,
              reputation: row.reputation,
              rankScore: row.rankScore,
              yield: row.yieldValue,
              expressYield: row.expressYield,
              wireYield: row.wireYield,
              uptime: row.uptime,
              commerceQuality: row.commerceQuality,
              expressConfidence: row.expressConfidence,
              wireConfidence: row.wireConfidence,
              expressReputation: row.expressReputation,
              wireReputation: row.wireReputation,
              railMode: row.railMode,
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
  railMetricRowsUpdated: number;
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
      railMetricRowsUpdated: 0,
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
        txSourceKind: true,
        canonicalOnchainAddress: true,
        canonicalAddressSource: true,
        txCount: true,
        onchainTxCountAgent: true,
        onchainTxCountOwner: true,
        usageAuthorizedCount7d: true,
        metricSource: true,
        yield: true,
        expressYield: true,
        wireYield: true,
        uptime: true,
        commerceQuality: true,
        wireConfidence: true,
        wireCompletedCount30d: true,
        wireRejectedCount30d: true,
        wireExpiredCount30d: true,
        wireSettledPrincipal30d: true,
        wireSettledProviderEarnings30d: true,
        isClaimed: true,
        txCountUpdatedAt: true,
      },
    }),
  );
  const existingByAddress = new Map(existingInputs.map((row) => [row.agentAddress, row]));

  const pendingUpserts: PendingInputUpsert[] = [];
  const changedSourceSet = new Set<string>();
  const sourceResolutionCounts: Record<ResolvedTxSourceKind | "unresolved", number> = {
    agent: 0,
    owner: 0,
    creator: 0,
    unresolved: 0,
  };
  const unresolvedAgentIdSamples: string[] = [];

  for (const agent of agents) {
    const resolvedSource = resolveTxSourceAddress(agent);
    const txSourceAddress = resolvedSource?.sourceAddressLower ?? null;
    const txSourceKind = toAgentTxSourceKind(resolvedSource?.sourceKind ?? null);
    const { canonicalOnchainAddress, canonicalAddressSource } = resolveCanonicalOnchainAddress(agent);
    if (resolvedSource) {
      sourceResolutionCounts[resolvedSource.sourceKind] += 1;
    } else {
      sourceResolutionCounts.unresolved += 1;
      if (unresolvedAgentIdSamples.length < 10) {
        unresolvedAgentIdSamples.push(agent.agentId);
      }
    }
    const isClaimed = statusIndicatesClaimed(agent.status);
    const existing = existingByAddress.get(agent.address);
    const hasDelta = hasSourceDelta(
      agent,
      existing,
      txSourceAddress,
      txSourceKind,
      canonicalOnchainAddress,
      canonicalAddressSource,
      isClaimed,
    );
    if (!hasDelta) continue;

    const sourceChanged = existing?.txSourceAddress !== txSourceAddress;
    const sourceKindChanged = existing?.txSourceKind !== txSourceKind;
    const seedTxCount = existing ? Math.max(0, existing.txCount) : 0;
    // Preserve prior txCount during source migration, but force stale refresh on changed source.
    const seedTxCountUpdatedAt = sourceChanged ? null : existing?.txCountUpdatedAt ?? null;
    let seedOnchainTxCountAgent: number | null = existing?.onchainTxCountAgent ?? null;
    if (!canonicalOnchainAddress) {
      seedOnchainTxCountAgent = null;
    } else if (txSourceAddress === canonicalOnchainAddress) {
      seedOnchainTxCountAgent = seedTxCount;
    }
    let seedOnchainTxCountOwner = Math.max(0, existing?.onchainTxCountOwner ?? 0);
    if (resolvedSource?.sourceKind === "owner") {
      seedOnchainTxCountOwner = seedTxCount;
    } else if (sourceChanged || sourceKindChanged) {
      seedOnchainTxCountOwner = 0;
    }

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
      txSourceKind,
      canonicalOnchainAddress,
      canonicalAddressSource,
      txCount: seedTxCount,
      onchainTxCountAgent: seedOnchainTxCountAgent,
      onchainTxCountOwner: seedOnchainTxCountOwner,
      usageAuthorizedCount7d: Math.max(0, existing?.usageAuthorizedCount7d ?? 0),
      metricSource: existing?.metricSource ?? "UNRESOLVED",
      yieldValue: Math.max(0, agent.yield ?? 0),
      expressYield: Math.max(0, agent.yield ?? 0),
      uptime: clamp(agent.uptime ?? 0, 0, 100),
      isClaimed,
      txCountUpdatedAt: seedTxCountUpdatedAt,
    });

    if (txSourceAddress) {
      changedSourceSet.add(txSourceAddress);
    }
  }

  console.log(
    `Heartbeat: score-v2 tx source resolution => mode=${SCORE_TX_SOURCE}, agent=${sourceResolutionCounts.agent}, owner=${sourceResolutionCounts.owner}, creator=${sourceResolutionCounts.creator}, unresolved=${sourceResolutionCounts.unresolved}`,
  );
  if (SCORE_TX_SOURCE === "agent") {
    console.log(
      `Heartbeat: score-v2 agent-mode fallback usage => owner_fallback=${sourceResolutionCounts.owner}, creator_fallback=${sourceResolutionCounts.creator}`,
    );
  }
  if (unresolvedAgentIdSamples.length > 0) {
    console.warn(
      `Heartbeat: score-v2 unresolved tx source sample agentIds => ${unresolvedAgentIdSamples.join(", ")}`,
    );
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
  const railMetricRowsUpdated = await syncRailMetricsToScoreInputs(agents, existingByAddress);

  return {
    totalAgents: agents.length,
    changedInputs: pendingUpserts.length,
    refreshedSources: txFetchResult.total,
    txFetchFailures: txFetchResult.failures,
    budgetReached: txFetchResult.budgetReached,
    railMetricRowsUpdated,
  };
};

const runSnapshotRanking = async (): Promise<{
  snapshotId: string;
  totalRows: number;
  maxTxCount: number;
  maxClaimedYield: number;
  sybilPenalizedAgents: number;
  sybilMaxPenalty: number;
  sybilCoverage: boolean;
  sybilServicesTracked: number;
  sybilAuthorizedEvents: number;
  txMetricAgentOnchainCount: number;
  txMetricSyntheticUsageCount: number;
  txMetricFallbackCount: number;
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
        txSourceKind: true,
        canonicalOnchainAddress: true,
        canonicalAddressSource: true,
        txCount: true,
        onchainTxCountAgent: true,
        onchainTxCountOwner: true,
        usageAuthorizedCount7d: true,
        metricSource: true,
        yield: true,
        expressYield: true,
        wireYield: true,
        uptime: true,
        commerceQuality: true,
        expressConfidence: true,
        wireConfidence: true,
        wireCompletedCount30d: true,
        wireRejectedCount30d: true,
        wireExpiredCount30d: true,
        wireSettledPrincipal30d: true,
        wireSettledProviderEarnings30d: true,
        expressReputation: true,
        wireReputation: true,
        railMode: true,
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

  const gateSybilSignals = await fetchGateSybilSignals();
  const { rows, maxTxCount, maxClaimedYield, sybilPenalizedAgents, sybilMaxPenalty, txMetricPathCounts } =
    buildSnapshotRows(
      inputs,
      gateSybilSignals,
    );
  const snapshotId = await writeSnapshot(rows, maxTxCount, maxClaimedYield);

  if (!SCORE_V2_SHADOW_ONLY && SCORE_V2_WRITE_AGENT_TABLE) {
    await applySnapshotScoresToAgentTable(rows);
  }

  return {
    snapshotId,
    totalRows: rows.length,
    maxTxCount,
    maxClaimedYield,
    sybilPenalizedAgents,
    sybilMaxPenalty,
    sybilCoverage: gateSybilSignals.hasCoverage,
    sybilServicesTracked: gateSybilSignals.servicesTracked,
    sybilAuthorizedEvents: gateSybilSignals.totalAuthorizedEvents,
    txMetricAgentOnchainCount: txMetricPathCounts.agent_onchain,
    txMetricSyntheticUsageCount: txMetricPathCounts.synthetic_usage,
    txMetricFallbackCount: txMetricPathCounts.fallback_tx,
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
    `score-v2 config: run_mode=${SCORE_V2_RUN_MODE}, mode=${AGENT_INDEX_MODE}, tx_source=${SCORE_TX_SOURCE}, synthetic_usage_primary=${SCORE_V2_SYNTHETIC_USAGE_PRIMARY}, shadow_only=${SCORE_V2_SHADOW_ONLY}, write_agent_table=${SCORE_V2_WRITE_AGENT_TABLE}, rpc_env=${INDEXER_RPC_ENV}, tx_concurrency=${SCORE_V2_TX_CONCURRENCY}, tx_call_timeout_ms=${SCORE_V2_TX_CALL_TIMEOUT_MS}, tx_rpc_timeout_ms=${SCORE_V2_TX_RPC_TIMEOUT_MS}, tx_budget_ms=${SCORE_V2_TX_BUDGET_MS}, ingest_batch_size=${SCORE_V2_INGEST_BATCH_SIZE}, snapshot_batch_size=${SCORE_V2_SNAPSHOT_BATCH_SIZE}, stale_tx_batch=${SCORE_V2_STALE_TX_BATCH}, stale_tx_minutes=${SCORE_V2_STALE_TX_MINUTES}`,
  );

  const startedAt = Date.now();

  if (SCORE_V2_RUN_MODE === "refresh-only") {
    const ingest = await ingestScoreInputs();
    const elapsedMs = Date.now() - startedAt;
    const completedAtIso = new Date().toISOString();
    await writeRunState({
      last_refresh_run_at: completedAtIso,
      last_refresh_elapsed_ms: String(elapsedMs),
      last_ingest_agents: String(ingest.totalAgents),
      last_ingest_changed_inputs: String(ingest.changedInputs),
      last_rail_metric_rows_updated: String(ingest.railMetricRowsUpdated),
      last_tx_sources_refreshed: String(ingest.refreshedSources),
      last_tx_fetch_failures: String(ingest.txFetchFailures),
      last_tx_budget_reached: ingest.budgetReached ? "true" : "false",
    });
    console.log(
      `score-v2 refresh complete: agents=${ingest.totalAgents}, changed_inputs=${ingest.changedInputs}, rail_metric_rows_updated=${ingest.railMetricRowsUpdated}, tx_sources_refreshed=${ingest.refreshedSources}, tx_failures=${ingest.txFetchFailures}${ingest.budgetReached ? ", budget_reached=true" : ""}, elapsed_ms=${elapsedMs}.`,
    );
    return;
  }

  if (SCORE_V2_RUN_MODE === "snapshot-only") {
    const ranking = await runSnapshotRanking();
    const elapsedMs = Date.now() - startedAt;
    const completedAtIso = new Date().toISOString();
    await writeRunState({
      last_snapshot_build_at: completedAtIso,
      last_snapshot_build_elapsed_ms: String(elapsedMs),
      last_snapshot_id: ranking.snapshotId,
      last_snapshot_rows: String(ranking.totalRows),
      last_snapshot_max_tx_count: String(ranking.maxTxCount),
      last_snapshot_max_claimed_yield: String(ranking.maxClaimedYield),
      last_sybil_coverage: ranking.sybilCoverage ? "true" : "false",
      last_sybil_services_tracked: String(ranking.sybilServicesTracked),
      last_sybil_authorized_events: String(ranking.sybilAuthorizedEvents),
      last_sybil_penalized_agents: String(ranking.sybilPenalizedAgents),
      last_sybil_max_penalty: String(ranking.sybilMaxPenalty),
      last_tx_metric_agent_onchain_count: String(ranking.txMetricAgentOnchainCount),
      last_tx_metric_synthetic_usage_count: String(ranking.txMetricSyntheticUsageCount),
      last_tx_metric_fallback_count: String(ranking.txMetricFallbackCount),
    });
    console.log(
      `score-v2 snapshot complete: snapshot=${ranking.snapshotId}, rows=${ranking.totalRows}, tx_metric_agent_onchain=${ranking.txMetricAgentOnchainCount}, tx_metric_synthetic_usage=${ranking.txMetricSyntheticUsageCount}, tx_metric_fallback=${ranking.txMetricFallbackCount}, sybil_coverage=${ranking.sybilCoverage}, sybil_services=${ranking.sybilServicesTracked}, sybil_authorized_events=${ranking.sybilAuthorizedEvents}, sybil_penalized_agents=${ranking.sybilPenalizedAgents}, sybil_max_penalty=${ranking.sybilMaxPenalty}, elapsed_ms=${elapsedMs}.`,
    );
    return;
  }

  const ingest = await ingestScoreInputs();
  if (ingest.totalAgents === 0) {
    console.log("score-v2: no agents found. Skipping snapshot generation.");
    return;
  }

  const ranking = await runSnapshotRanking();
  const elapsedMs = Date.now() - startedAt;
  const completedAtIso = new Date().toISOString();

  await writeRunState({
    last_run_at: completedAtIso,
    last_run_elapsed_ms: String(elapsedMs),
    last_refresh_run_at: completedAtIso,
    last_refresh_elapsed_ms: String(elapsedMs),
    last_snapshot_build_at: completedAtIso,
    last_snapshot_build_elapsed_ms: String(elapsedMs),
    last_ingest_agents: String(ingest.totalAgents),
    last_ingest_changed_inputs: String(ingest.changedInputs),
    last_tx_sources_refreshed: String(ingest.refreshedSources),
    last_tx_fetch_failures: String(ingest.txFetchFailures),
    last_tx_budget_reached: ingest.budgetReached ? "true" : "false",
    last_snapshot_id: ranking.snapshotId,
    last_snapshot_rows: String(ranking.totalRows),
    last_snapshot_max_tx_count: String(ranking.maxTxCount),
    last_snapshot_max_claimed_yield: String(ranking.maxClaimedYield),
    last_sybil_coverage: ranking.sybilCoverage ? "true" : "false",
    last_sybil_services_tracked: String(ranking.sybilServicesTracked),
    last_sybil_authorized_events: String(ranking.sybilAuthorizedEvents),
    last_sybil_penalized_agents: String(ranking.sybilPenalizedAgents),
    last_sybil_max_penalty: String(ranking.sybilMaxPenalty),
    last_tx_metric_agent_onchain_count: String(ranking.txMetricAgentOnchainCount),
    last_tx_metric_synthetic_usage_count: String(ranking.txMetricSyntheticUsageCount),
    last_tx_metric_fallback_count: String(ranking.txMetricFallbackCount),
  });

  console.log(
    `score-v2 complete: snapshot=${ranking.snapshotId}, rows=${ranking.totalRows}, changed_inputs=${ingest.changedInputs}, tx_sources_refreshed=${ingest.refreshedSources}, tx_failures=${ingest.txFetchFailures}${ingest.budgetReached ? ", budget_reached=true" : ""}, tx_metric_agent_onchain=${ranking.txMetricAgentOnchainCount}, tx_metric_synthetic_usage=${ranking.txMetricSyntheticUsageCount}, tx_metric_fallback=${ranking.txMetricFallbackCount}, sybil_coverage=${ranking.sybilCoverage}, sybil_services=${ranking.sybilServicesTracked}, sybil_authorized_events=${ranking.sybilAuthorizedEvents}, sybil_penalized_agents=${ranking.sybilPenalizedAgents}, sybil_max_penalty=${ranking.sybilMaxPenalty}, elapsed_ms=${elapsedMs}.`,
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
