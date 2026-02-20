import { createPublicClient, fallback, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { prisma } from "../lib/db";

type AgentIndexMode = "erc8004" | "olas";
type ScoreTxSource = "owner" | "creator";

const AGENT_INDEX_MODE: AgentIndexMode =
  process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";
const SCORE_TX_SOURCE: ScoreTxSource = (() => {
  const raw = process.env.SCORE_TX_SOURCE?.trim().toLowerCase();
  if (raw === "owner" || raw === "creator") return raw;
  return AGENT_INDEX_MODE === "olas" ? "creator" : "owner";
})();

const INDEXER_RPC_URL =
  process.env.BASE_RPC_URL_INDEXER?.trim() || process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const INDEXER_RPC_ENV = process.env.BASE_RPC_URL_INDEXER?.trim()
  ? "BASE_RPC_URL_INDEXER"
  : process.env.BASE_RPC_URL?.trim()
    ? "BASE_RPC_URL"
    : "default";
const parseBoundedInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(parsed, max));
};

const SCORE_TX_CONCURRENCY = parseBoundedInt(process.env.SCORE_TX_CONCURRENCY, 15, 1, 60);
const SCORE_TX_BATCH_DELAY_MS = parseBoundedInt(process.env.SCORE_TX_BATCH_DELAY_MS, 25, 0, 2_000);
const SCORE_DB_UPDATE_BATCH_SIZE = parseBoundedInt(process.env.SCORE_DB_UPDATE_BATCH_SIZE, 100, 25, 500);
const SCORE_HEARTBEAT_INTERVAL = parseBoundedInt(process.env.SCORE_HEARTBEAT_INTERVAL, 10, 1, 500);
const SCORE_DB_RECONNECT_THRESHOLD_MS = parseBoundedInt(
  process.env.SCORE_DB_RECONNECT_THRESHOLD_MS,
  5 * 60_000,
  60_000,
  30 * 60_000,
);
const SCORE_RPC_TIMEOUT_MS = parseBoundedInt(process.env.SCORE_RPC_TIMEOUT_MS, 15_000, 3_000, 30_000);
const SCORE_RPC_RETRY_COUNT = parseBoundedInt(process.env.SCORE_RPC_RETRY_COUNT, 2, 0, 5);
const SCORE_TX_CALL_TIMEOUT_MS = parseBoundedInt(process.env.SCORE_TX_CALL_TIMEOUT_MS, 12_000, 2_000, 60_000);
const SCORE_TX_RPC_TIMEOUT_MS = Math.min(SCORE_TX_CALL_TIMEOUT_MS, SCORE_RPC_TIMEOUT_MS);
const SCORE_TX_BUDGET_MS = parseBoundedInt(process.env.SCORE_TX_BUDGET_MS, 10 * 60_000, 60_000, 60 * 60_000);
const SCORE_PRISMA_RETRY_ATTEMPTS = parseBoundedInt(process.env.SCORE_PRISMA_RETRY_ATTEMPTS, 4, 1, 8);
const SCORE_PRISMA_RETRY_DELAY_MS = parseBoundedInt(process.env.SCORE_PRISMA_RETRY_DELAY_MS, 1_000, 100, 10_000);
const SCORE_PRISMA_CONNECTION_TIMEOUT_MS = parseBoundedInt(
  process.env.SCORE_PRISMA_CONNECTION_TIMEOUT_MS,
  12_000,
  2_000,
  60_000,
);
const SCORE_FORCE_EXIT_ON_FINISH =
  process.env.SCORE_FORCE_EXIT_ON_FINISH?.trim().toLowerCase() === "true" ||
  process.env.CI?.trim().toLowerCase() === "true";

const UNCLAIMED_REPUTATION_CAP = 80;
const REPUTATION_TX_WEIGHT = 0.3;
const REPUTATION_UPTIME_WEIGHT = 0.5;
const REPUTATION_YIELD_WEIGHT = 0.2;
const RANK_REPUTATION_WEIGHT = 0.7;
const RANK_VELOCITY_WEIGHT = 0.3;
const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000";

type AgentTier = "WHALE" | "ACTIVE" | "NEW" | "GHOST";

type ScoreUpdate = {
  address: string;
  txCount: number;
  tier: AgentTier;
  reputation: number;
  rankScore: number;
  yieldEth: number;
  uptimePct: number;
  volume: bigint;
  score: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
    if (timeout) {
      clearTimeout(timeout);
    }
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
    await withTimeout("score prisma.$disconnect", SCORE_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$disconnect());
  } catch (error) {
    console.warn(
      `score prisma.$disconnect failed during retry reset (attempt ${attempt}/${SCORE_PRISMA_RETRY_ATTEMPTS}). Continuing.`,
    );
    console.error(error);
  }

  await sleep(SCORE_PRISMA_RETRY_DELAY_MS * attempt);

  try {
    await withTimeout("score prisma.$connect", SCORE_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$connect());
  } catch (error) {
    console.warn(
      `score prisma.$connect failed during retry reset (attempt ${attempt}/${SCORE_PRISMA_RETRY_ATTEMPTS}).`,
    );
    console.error(error);
  }
};

const withPrismaRetry = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= SCORE_PRISMA_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRecoverablePrismaError(error) || attempt >= SCORE_PRISMA_RETRY_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `${label} failed with recoverable Prisma error (attempt ${attempt}/${SCORE_PRISMA_RETRY_ATTEMPTS}). Retrying...`,
      );
      console.error(error);
      await resetPrismaConnection(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed after retries`);
};

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

const resolveTxSourceAddressLower = (agent: { owner: string; creator: string }): string | null => {
  const primary = SCORE_TX_SOURCE === "owner" ? agent.owner : agent.creator;
  const secondary = SCORE_TX_SOURCE === "owner" ? agent.creator : agent.owner;

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

const buildClient = (rpcTimeoutMs: number = SCORE_RPC_TIMEOUT_MS) =>
  createPublicClient({
    chain: base,
    transport: fallback([
      http(INDEXER_RPC_URL, { retryCount: SCORE_RPC_RETRY_COUNT, retryDelay: 250, timeout: rpcTimeoutMs }),
      http("https://base.llamarpc.com", {
        retryCount: SCORE_RPC_RETRY_COUNT,
        retryDelay: 250,
        timeout: rpcTimeoutMs,
      }),
      http("https://1rpc.io/base", {
        retryCount: SCORE_RPC_RETRY_COUNT,
        retryDelay: 250,
        timeout: rpcTimeoutMs,
      }),
    ]),
  });

const fetchTxCountsBySourceAddress = async (
  sourceAddresses: Array<string | null>,
): Promise<{
  txCountBySourceAddressLower: Map<string, number>;
  failures: number;
  fetched: number;
  total: number;
  budgetReached: boolean;
}> => {
  const txCountBySourceAddressLower = new Map<string, number>();
  const normalizedAddressByLower = new Map<string, Address>();
  let invalidOrZeroCount = 0;

  for (const sourceAddress of sourceAddresses) {
    if (!sourceAddress) {
      invalidOrZeroCount += 1;
      continue;
    }
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
      `Heartbeat: txCount source normalization => requested=${sourceAddresses.length}, unique=${normalizedAddresses.length}, duplicate=${duplicateCount}, invalid_or_zero=${invalidOrZeroCount}`,
    );
  }

  const publicClient = buildClient(SCORE_TX_RPC_TIMEOUT_MS);
  let failures = 0;
  const total = normalizedAddresses.length;
  const startedAt = Date.now();
  let fetched = 0;
  let budgetReached = false;

  for (let index = 0; index < normalizedAddresses.length; index += SCORE_TX_CONCURRENCY) {
    if (Date.now() - startedAt >= SCORE_TX_BUDGET_MS) {
      budgetReached = true;
      console.warn(
        `txCount fetch budget reached (${SCORE_TX_BUDGET_MS}ms). Reusing stored txCount values for remaining addresses.`,
      );
      break;
    }
    const batch = normalizedAddresses.slice(index, index + SCORE_TX_CONCURRENCY);

    await Promise.all(
      batch.map(async ({ sourceAddressLower, sourceAddress }) => {
        try {
          const txCountRaw = await withTimeout(`txCount ${sourceAddress}`, SCORE_TX_CALL_TIMEOUT_MS, () =>
            publicClient.getTransactionCount({ address: sourceAddress }),
          );
          txCountBySourceAddressLower.set(sourceAddressLower, toSafeInt(txCountRaw));
          fetched += 1;
        } catch (error) {
          failures += 1;
          txCountBySourceAddressLower.set(sourceAddressLower, 0);
          console.warn(`Failed txCount fetch for ${sourceAddress}. Defaulting to 0.`);
          console.error(error);
          fetched += 1;
        }
      }),
    );
    const processed = Math.min(index + batch.length, total);
    if (processed % SCORE_HEARTBEAT_INTERVAL === 0 || processed === total) {
      console.log(`Heartbeat: fetched txCounts ${processed}/${total} ${SCORE_TX_SOURCE} addresses`);
    }

    if (index + SCORE_TX_CONCURRENCY < normalizedAddresses.length && SCORE_TX_BATCH_DELAY_MS > 0) {
      await sleep(SCORE_TX_BATCH_DELAY_MS);
    }
  }

  return { txCountBySourceAddressLower, failures, fetched, total, budgetReached };
};

const applyScoreUpdates = async (updates: ScoreUpdate[]): Promise<void> => {
  const total = updates.length;
  for (let index = 0; index < updates.length; index += SCORE_DB_UPDATE_BATCH_SIZE) {
    const chunk = updates.slice(index, index + SCORE_DB_UPDATE_BATCH_SIZE);

    await withPrismaRetry(`persist score batch ${index + 1}-${Math.min(index + chunk.length, total)}`, () =>
      prisma.$transaction(
        chunk.map((update) =>
          prisma.agent.update({
            where: { address: update.address },
            data: {
              txCount: update.txCount,
              tier: update.tier,
              reputation: update.reputation,
              rankScore: update.rankScore,
              yield: update.yieldEth,
              uptime: update.uptimePct,
              volume: update.volume,
              score: update.score,
            },
          }),
        ),
      ),
    );

    const persisted = Math.min(index + chunk.length, total);
    console.log(`Heartbeat: persisted ${persisted}/${total} score updates`);
  }
};

async function main(): Promise<void> {
  console.log(
    `Scoring config: mode=${AGENT_INDEX_MODE}, tx_source=${SCORE_TX_SOURCE}, rpc_env=${INDEXER_RPC_ENV}, tx_concurrency=${SCORE_TX_CONCURRENCY}, tx_call_timeout_ms=${SCORE_TX_CALL_TIMEOUT_MS}, tx_rpc_timeout_ms=${SCORE_TX_RPC_TIMEOUT_MS}, tx_budget_ms=${SCORE_TX_BUDGET_MS}, db_batch_size=${SCORE_DB_UPDATE_BATCH_SIZE}`,
  );
  const startedAt = Date.now();
  const agents = await withPrismaRetry("load agents for scoring", () =>
    prisma.agent.findMany({
      select: {
        address: true,
        creator: true,
        owner: true,
        status: true,
        yield: true,
        uptime: true,
        txCount: true,
      },
    }),
  );

  if (agents.length === 0) {
    console.log("No agents found. Skipping scoring run.");
    return;
  }

  const txSourceAddressByAgent = agents.map((agent) => resolveTxSourceAddressLower(agent));
  const { txCountBySourceAddressLower, failures, fetched, total, budgetReached } = await fetchTxCountsBySourceAddress(
    txSourceAddressByAgent,
  );

  const txCounts = agents.map((agent, index) => {
    const sourceAddressLower = txSourceAddressByAgent[index];
    if (!sourceAddressLower) return 0;
    return txCountBySourceAddressLower.get(sourceAddressLower) ?? agent.txCount ?? 0;
  });
  const maxTxCount = Math.max(0, ...txCounts);

  const claimedYields = agents
    .map((agent) => {
      const isClaimed = statusIndicatesClaimed(agent.status);
      return isClaimed ? Math.max(0, agent.yield ?? 0) : 0;
    })
    .filter((value) => value > 0);
  const maxClaimedYield = claimedYields.length > 0 ? Math.max(...claimedYields) : 0;

  const updates: ScoreUpdate[] = [];
  const totalAgents = agents.length;

  for (let index = 0; index < totalAgents; index += 1) {
    const agent = agents[index];
    const sourceAddressLower = txSourceAddressByAgent[index];
    const txCount = sourceAddressLower ? (txCountBySourceAddressLower.get(sourceAddressLower) ?? agent.txCount ?? 0) : 0;
    const txVolumeNorm = normalizeLog100(txCount, maxTxCount);
    const velocityNorm = normalizeLog100(txCount, maxTxCount);
    const isClaimed = statusIndicatesClaimed(agent.status);
    const yieldEth = isClaimed ? Math.max(0, agent.yield ?? 0) : 0;
    const uptimePct = isClaimed ? clamp(agent.uptime ?? 0, 0, 100) : 0;
    const yieldNorm = maxClaimedYield > 0 ? clamp((yieldEth / maxClaimedYield) * 100, 0, 100) : 0;

    const reputation = isClaimed
      ? roundToTwo(
          txVolumeNorm * REPUTATION_TX_WEIGHT +
            uptimePct * REPUTATION_UPTIME_WEIGHT +
            yieldNorm * REPUTATION_YIELD_WEIGHT,
        )
      : roundToTwo(Math.min(txVolumeNorm, UNCLAIMED_REPUTATION_CAP));

    // Critical fix: use normalized velocity in final rank math (0-100 scale).
    const rankScore = roundToTwo(reputation * RANK_REPUTATION_WEIGHT + velocityNorm * RANK_VELOCITY_WEIGHT);
    const tier = getTier(txCount, isClaimed);

    updates.push({
      address: agent.address,
      txCount,
      tier,
      reputation,
      rankScore,
      yieldEth,
      uptimePct,
      volume: BigInt(txCount),
      score: Math.round(rankScore),
    });

    const processed = index + 1;
    if (processed % SCORE_HEARTBEAT_INTERVAL === 0 || processed === totalAgents) {
      console.log(`Heartbeat: scored ${processed}/${totalAgents} agents`);
    }
  }

  if (Date.now() - startedAt > SCORE_DB_RECONNECT_THRESHOLD_MS) {
    console.log("Heartbeat: refreshing Prisma connection before final batch write");
    await withPrismaRetry("refresh prisma connection", async () => {
      await withTimeout("score prisma.$disconnect (refresh)", SCORE_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$disconnect());
      await withTimeout("score prisma.$connect (refresh)", SCORE_PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$connect());
    });
  }

  await applyScoreUpdates(updates);

  const tierCounts = updates.reduce<Record<AgentTier, number>>(
    (acc, update) => {
      acc[update.tier] += 1;
      return acc;
    },
    { WHALE: 0, ACTIVE: 0, NEW: 0, GHOST: 0 },
  );

  console.log(`Scored ${updates.length} agents and updated Postgres.`);
  console.log(`RPC txCount failures: ${failures}.`);
  console.log(`Fetched txCounts for ${fetched}/${total} source addresses.${budgetReached ? " (Budget reached; fallback values used for the remainder.)" : ""}`);
  console.log(`Max txCount observed: ${maxTxCount}.`);
  console.log(
    `Tier distribution => WHALE: ${tierCounts.WHALE}, ACTIVE: ${tierCounts.ACTIVE}, NEW: ${tierCounts.NEW}, GHOST: ${tierCounts.GHOST}.`,
  );
}

main()
  .catch((error) => {
    console.error("Failed to score agents:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await withTimeout("score prisma.$disconnect (final)", SCORE_PRISMA_CONNECTION_TIMEOUT_MS, () =>
        prisma.$disconnect(),
      );
    } catch (disconnectError) {
      console.error("Failed to disconnect Prisma cleanly:", disconnectError);
    }
    if (SCORE_FORCE_EXIT_ON_FINISH) {
      process.exit(process.exitCode ?? 0);
    }
  });
