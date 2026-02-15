import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

const INPUT_PATH = join(process.cwd(), "data", "base-agents.json");
const OUTPUT_PATH = join(process.cwd(), "data", "leads-scored.json");
const MONITORED_AGENTS_PATH = join(process.cwd(), "data", "monitored-agents.json");
const TELEMETRY_PATH = join(process.cwd(), "data", "agent-telemetry.json");
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const CONCURRENCY_LIMIT = 5;
const BATCH_DELAY_MS = 100;
const UNCLAIMED_REPUTATION_CAP = 80;
const REPUTATION_TX_WEIGHT = 0.3;
const REPUTATION_UPTIME_WEIGHT = 0.5;
const REPUTATION_YIELD_WEIGHT = 0.2;
const RANK_REPUTATION_WEIGHT = 0.7;
const RANK_VELOCITY_WEIGHT = 0.3;

type Tier = "WHALE" | "ACTIVE" | "NEW";

type BaseAgent = {
  agentId: string;
  owner: Address;
  monetized?: boolean;
};

type ScoredLead = {
  agentId: string;
  owner: Address;
  isClaimed: boolean;
  transactionCount: number;
  txCount: number;
  txVolumeNorm: number;
  velocity: number;
  velocityNorm: number;
  reputation: number;
  rankScore: number;
  yield: number | null;
  uptime: number | null;
  dualVerify: {
    merchantPulseLastSeen: string | null;
    consumerSuccessRatePct: number | null;
    source: "stub";
  };
  tier: Tier;
};

type AgentTelemetry = {
  agentId: string;
  yield24hEth: number | null;
  uptimePct: number | null;
  dualVerify: {
    merchantPulseLastSeen: string | null;
    consumerSuccessRatePct: number | null;
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getTier = (txCount: number): Tier => {
  if (txCount > 500) return "WHALE";
  if (txCount > 50) return "ACTIVE";
  return "NEW";
};

const normalizeReputation = (txCount: number, maxTxCount: number): number => {
  if (maxTxCount <= 0) return 0;

  const numerator = Math.log10(txCount + 1);
  const denominator = Math.log10(maxTxCount + 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  const normalized = (numerator / denominator) * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

const normalizeAgentId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return null;
};

const loadMonitoredAgentIds = async (): Promise<Set<string>> => {
  try {
    const raw = await readFile(MONITORED_AGENTS_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(`Expected array in ${MONITORED_AGENTS_PATH}. Using empty monitored list.`);
      return new Set<string>();
    }

    const monitored = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry === "object" && entry !== null) {
        const maybeId = normalizeAgentId((entry as { agentId?: unknown }).agentId);
        if (maybeId) {
          monitored.add(maybeId);
        }
        continue;
      }

      const normalized = normalizeAgentId(entry);
      if (normalized) {
        monitored.add(normalized);
      }
    }

    return monitored;
  } catch (error) {
    console.warn(`Failed to load ${MONITORED_AGENTS_PATH}. Using empty monitored list.`);
    console.error(error);
    return new Set<string>();
  }
};

const parseNullableNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const loadTelemetryByAgentId = async (): Promise<Map<string, AgentTelemetry>> => {
  try {
    const raw = await readFile(TELEMETRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(`Expected array in ${TELEMETRY_PATH}. Using empty telemetry map.`);
      return new Map<string, AgentTelemetry>();
    }

    const telemetryByAgentId = new Map<string, AgentTelemetry>();
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as {
        agentId?: unknown;
        yield24hEth?: unknown;
        uptimePct?: unknown;
        dualVerify?: {
          merchantPulseLastSeen?: unknown;
          consumerSuccessRatePct?: unknown;
        };
      };

      const agentId = normalizeAgentId(row.agentId);
      if (!agentId) continue;

      const merchantPulseLastSeen =
        typeof row.dualVerify?.merchantPulseLastSeen === "string"
          ? row.dualVerify.merchantPulseLastSeen
          : null;
      const consumerSuccessRatePctRaw = parseNullableNumber(row.dualVerify?.consumerSuccessRatePct);
      const consumerSuccessRatePct =
        consumerSuccessRatePctRaw == null ? null : clamp(consumerSuccessRatePctRaw, 0, 100);

      telemetryByAgentId.set(agentId, {
        agentId,
        yield24hEth: parseNullableNumber(row.yield24hEth),
        uptimePct: parseNullableNumber(row.uptimePct),
        dualVerify: {
          merchantPulseLastSeen,
          consumerSuccessRatePct,
        },
      });
    }

    return telemetryByAgentId;
  } catch {
    return new Map<string, AgentTelemetry>();
  }
};

async function main(): Promise<void> {
  const raw = await readFile(INPUT_PATH, "utf8");
  const agents = JSON.parse(raw) as BaseAgent[];
  const monitoredAgentIds = await loadMonitoredAgentIds();
  const telemetryByAgentId = await loadTelemetryByAgentId();

  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL, {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });

  const ownerByLowercase = new Map<string, Address>();
  for (const agent of agents) {
    ownerByLowercase.set(agent.owner.toLowerCase(), agent.owner);
  }

  const uniqueOwners = Array.from(ownerByLowercase.entries());
  const txCountByOwnerLower = new Map<string, number>();

  for (let index = 0; index < uniqueOwners.length; index += CONCURRENCY_LIMIT) {
    const batch = uniqueOwners.slice(index, index + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map(async ([ownerLower, owner]) => {
        try {
          const txCount = await publicClient.getTransactionCount({ address: owner });
          txCountByOwnerLower.set(ownerLower, Number(txCount));
        } catch (error) {
          txCountByOwnerLower.set(ownerLower, 0);
          console.warn(`Failed to fetch txCount for ${owner}. Defaulting to 0.`);
          console.error(error);
        }
      }),
    );

    if (index + CONCURRENCY_LIMIT < uniqueOwners.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const maxTxCount = Math.max(0, ...Array.from(txCountByOwnerLower.values()));
  const maxVelocity = maxTxCount;
  const maxYield = Math.max(
    0,
    ...Array.from(telemetryByAgentId.values())
      .map((telemetry) => telemetry.yield24hEth ?? 0)
      .filter((yield24hEth) => yield24hEth >= 0),
  );

  const scored: ScoredLead[] = agents.map((agent) => {
    const txCount = txCountByOwnerLower.get(agent.owner.toLowerCase()) ?? 0;
    const isClaimed = monitoredAgentIds.has(agent.agentId);
    const telemetry = telemetryByAgentId.get(agent.agentId);
    const txVolumeNorm = normalizeReputation(txCount, maxTxCount);
    const velocity = txCount;
    const velocityNorm = normalizeReputation(velocity, maxVelocity);
    const yield24hEth = isClaimed ? Math.max(0, telemetry?.yield24hEth ?? 0) : null;
    const uptimePct = isClaimed ? clamp(telemetry?.uptimePct ?? 0, 0, 100) : null;
    const yieldNorm = yield24hEth == null || maxYield <= 0 ? 0 : clamp((yield24hEth / maxYield) * 100, 0, 100);
    const reputation = isClaimed
      ? roundToTwo(
          txVolumeNorm * REPUTATION_TX_WEIGHT +
            (uptimePct ?? 0) * REPUTATION_UPTIME_WEIGHT +
            yieldNorm * REPUTATION_YIELD_WEIGHT,
        )
      : Math.min(txVolumeNorm, UNCLAIMED_REPUTATION_CAP);
    // Section 2B: Rank = (Reputation * 0.7) + (Velocity * 0.3), with MVP velocity proxied by raw tx count.
    const rankScore = roundToTwo(reputation * RANK_REPUTATION_WEIGHT + velocity * RANK_VELOCITY_WEIGHT);

    return {
      agentId: agent.agentId,
      owner: agent.owner,
      isClaimed,
      transactionCount: txCount,
      txCount,
      txVolumeNorm,
      velocity,
      velocityNorm,
      reputation,
      rankScore,
      yield: yield24hEth,
      uptime: uptimePct,
      dualVerify: {
        merchantPulseLastSeen: telemetry?.dualVerify.merchantPulseLastSeen ?? null,
        consumerSuccessRatePct: telemetry?.dualVerify.consumerSuccessRatePct ?? null,
        source: "stub",
      },
      tier: getTier(txCount),
    };
  });

  const whaleOwners = new Set(
    uniqueOwners
      .filter(([ownerLower]) => (txCountByOwnerLower.get(ownerLower) ?? 0) > 500)
      .map(([ownerLower]) => ownerLower),
  );

  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(scored, null, 2), "utf8");

  console.log(`Scored ${uniqueOwners.length} unique owners. Found ${whaleOwners.size} Whales.`);
  console.log(`Detected ${monitoredAgentIds.size} monitored agent IDs.`);
  console.log(`Max transaction count observed: ${maxTxCount}.`);
  console.log(`Loaded telemetry for ${telemetryByAgentId.size} agents (Dual-Verify stub).`);
  console.log(`Saved scored leads to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Failed to score leads:", error);
  process.exitCode = 1;
});
