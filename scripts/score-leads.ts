import { createPublicClient, fallback, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { prisma } from "../lib/db";

const BASE_RPC_URL = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const CONCURRENCY_LIMIT = 5;
const BATCH_DELAY_MS = 100;
const UPDATE_BATCH_SIZE = 100;
const HEARTBEAT_INTERVAL = 10;
const DB_RECONNECT_THRESHOLD_MS = 5 * 60_000;

const UNCLAIMED_REPUTATION_CAP = 80;
const REPUTATION_TX_WEIGHT = 0.3;
const REPUTATION_UPTIME_WEIGHT = 0.5;
const REPUTATION_YIELD_WEIGHT = 0.2;
const RANK_REPUTATION_WEIGHT = 0.7;
const RANK_VELOCITY_WEIGHT = 0.3;

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

const buildClient = () =>
  createPublicClient({
    chain: base,
    transport: fallback([
      http(BASE_RPC_URL, { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
      http("https://base.llamarpc.com", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
      http("https://1rpc.io/base", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
    ]),
  });

const fetchTxCountsByCreator = async (
  creators: string[],
): Promise<{
  txCountByCreatorLower: Map<string, number>;
  failures: number;
}> => {
  const txCountByCreatorLower = new Map<string, number>();
  const normalizedCreators = Array.from(
    new Set(
      creators
        .map((creator) => creator.toLowerCase())
        .map((creatorLower) => {
          const parsed = parseAddress(creatorLower);
          return parsed ? { creatorLower, creatorAddress: parsed } : null;
        })
        .filter((value): value is { creatorLower: string; creatorAddress: Address } => value !== null),
    ),
  );

  const publicClient = buildClient();
  let failures = 0;
  const total = normalizedCreators.length;

  for (let index = 0; index < normalizedCreators.length; index += CONCURRENCY_LIMIT) {
    const batch = normalizedCreators.slice(index, index + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map(async ({ creatorLower, creatorAddress }) => {
        try {
          const txCountRaw = await publicClient.getTransactionCount({ address: creatorAddress });
          txCountByCreatorLower.set(creatorLower, toSafeInt(txCountRaw));
        } catch (error) {
          failures += 1;
          txCountByCreatorLower.set(creatorLower, 0);
          console.warn(`Failed txCount fetch for ${creatorAddress}. Defaulting to 0.`);
          console.error(error);
        }
      }),
    );
    const processed = Math.min(index + batch.length, total);
    if (processed % HEARTBEAT_INTERVAL === 0 || processed === total) {
      console.log(`Heartbeat: fetched txCounts ${processed}/${total} creators`);
    }

    if (index + CONCURRENCY_LIMIT < normalizedCreators.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { txCountByCreatorLower, failures };
};

const applyScoreUpdates = async (updates: ScoreUpdate[]): Promise<void> => {
  const total = updates.length;
  for (let index = 0; index < updates.length; index += UPDATE_BATCH_SIZE) {
    const chunk = updates.slice(index, index + UPDATE_BATCH_SIZE);

    await prisma.$transaction(
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
    );

    const persisted = Math.min(index + chunk.length, total);
    console.log(`Heartbeat: persisted ${persisted}/${total} score updates`);
  }
};

async function main(): Promise<void> {
  const startedAt = Date.now();
  const agents = await prisma.agent.findMany({
    select: {
      address: true,
      creator: true,
      status: true,
      yield: true,
      uptime: true,
      txCount: true,
    },
  });

  if (agents.length === 0) {
    console.log("No agents found. Skipping scoring run.");
    return;
  }

  const { txCountByCreatorLower, failures } = await fetchTxCountsByCreator(agents.map((agent) => agent.creator));

  const txCounts = agents.map((agent) => txCountByCreatorLower.get(agent.creator.toLowerCase()) ?? agent.txCount ?? 0);
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
    const txCount = txCountByCreatorLower.get(agent.creator.toLowerCase()) ?? agent.txCount ?? 0;
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
    if (processed % HEARTBEAT_INTERVAL === 0 || processed === totalAgents) {
      console.log(`Heartbeat: scored ${processed}/${totalAgents} agents`);
    }
  }

  if (Date.now() - startedAt > DB_RECONNECT_THRESHOLD_MS) {
    console.log("Heartbeat: refreshing Prisma connection before final batch write");
    await prisma.$disconnect();
    await prisma.$connect();
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
      await prisma.$disconnect();
    } catch (disconnectError) {
      console.error("Failed to disconnect Prisma cleanly:", disconnectError);
    }
  });
