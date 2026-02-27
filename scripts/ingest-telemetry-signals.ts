import { config as loadEnv } from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const prisma = new PrismaClient({ log: ["error"] });

const DEFAULT_WINDOW_MINUTES = 24 * 60;
const DEFAULT_CREDIT_PRICE_WEI = 10_000_000_000_000n; // 0.00001 ETH
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const DEFAULT_UPDATE_BATCH_SIZE = 200;
const CHANGE_EPSILON = 0.000001;

type MetricSample = {
  uptime: number;
  samples: number;
};

type AgentRow = {
  address: string;
  agentId: string;
  yield: number;
  uptime: number;
};

type AgentUpdate = {
  address: string;
  agentId: string;
  previousYield: number;
  nextYield: number;
  previousUptime: number;
  nextUptime: number;
  uptimeSource: "canary" | "outcome" | "none";
  uptimeSamples: number;
};

const parsePositiveInt = (value: string | undefined, fallback: number, max = 10_000): number => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > max ? max : parsed;
};

const getArgValue = (flag: string): string | null => {
  const arg = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (!arg) return null;
  return arg.slice(flag.length + 1).trim() || null;
};

const hasArgFlag = (flag: string): boolean => process.argv.some((entry) => entry === flag);

const clamp = (value: number, min = 0, max = 100): number => {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const roundTo = (value: number, decimals: number): number =>
  Number.parseFloat(value.toFixed(decimals));

const getCreditPriceWei = (): bigint => {
  const rawWei = process.env.GHOST_CREDIT_PRICE_WEI?.trim();
  if (rawWei && /^\d+$/.test(rawWei)) return BigInt(rawWei);

  const rawEth = process.env.GHOST_CREDIT_PRICE_ETH?.trim();
  if (rawEth) {
    const [wholePart, fractionalPart = ""] = rawEth.split(".");
    if (wholePart && /^\d+$/.test(wholePart) && /^\d*$/.test(fractionalPart)) {
      const whole = BigInt(wholePart) * WEI_PER_ETH;
      const fractionalNormalized = `${fractionalPart}000000000000000000`.slice(0, 18);
      const fractional = fractionalNormalized ? BigInt(fractionalNormalized) : 0n;
      return whole + fractional;
    }
  }

  return DEFAULT_CREDIT_PRICE_WEI;
};

const weiToEthNumber = (wei: bigint): number => {
  const whole = wei / WEI_PER_ETH;
  const fractional = wei % WEI_PER_ETH;
  const wholeNum = Number(whole);
  const fractionalNum = Number(fractional) / Number(WEI_PER_ETH);
  if (!Number.isFinite(wholeNum) || !Number.isFinite(fractionalNum)) {
    return 0;
  }
  return wholeNum + fractionalNum;
};

const hasMeaningfulDelta = (a: number, b: number): boolean => Math.abs(a - b) > CHANGE_EPSILON;

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const tableExists = async (name: string): Promise<boolean> => {
  const result = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass(${`public."${name}"`})::text AS relation
  `);
  return Boolean(result[0]?.relation);
};

const computeYieldByAgentId = async (since: Date, creditPriceWei: bigint): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  if (!(await tableExists("FulfillmentHold"))) {
    return out;
  }

  const rows = await prisma.fulfillmentHold.groupBy({
    by: ["agentId"],
    where: {
      state: "CAPTURED",
      capturedAt: { gte: since },
      agentId: { not: null },
    },
    _sum: { cost: true },
  });

  for (const row of rows) {
    if (!row.agentId) continue;
    const capturedCredits = BigInt(row._sum.cost ?? 0);
    if (capturedCredits <= 0n) {
      out.set(row.agentId, 0);
      continue;
    }
    const yieldWei = capturedCredits * creditPriceWei;
    const yieldEth = roundTo(Math.max(0, weiToEthNumber(yieldWei)), 8);
    out.set(row.agentId, yieldEth);
  }

  return out;
};

const computeCanaryUptimeByAgentId = async (since: Date): Promise<Map<string, MetricSample>> => {
  const out = new Map<string, MetricSample>();
  if (!(await tableExists("AgentGatewayConfig")) || !(await tableExists("AgentGatewayCanaryCheck"))) {
    return out;
  }

  const countsByConfig = new Map<string, { total: number; success: number }>();
  const groupedChecks = await prisma.agentGatewayCanaryCheck.groupBy({
    by: ["gatewayConfigId", "success"],
    where: { checkedAt: { gte: since } },
    _count: { _all: true },
  });

  for (const row of groupedChecks) {
    const current = countsByConfig.get(row.gatewayConfigId) ?? { total: 0, success: 0 };
    const count = row._count._all;
    current.total += count;
    if (row.success) current.success += count;
    countsByConfig.set(row.gatewayConfigId, current);
  }

  const configs = await prisma.agentGatewayConfig.findMany({
    select: {
      id: true,
      agentId: true,
    },
  });

  for (const config of configs) {
    const counts = countsByConfig.get(config.id);
    if (!counts || counts.total <= 0) {
      out.set(config.agentId, {
        uptime: 0,
        samples: 0,
      });
      continue;
    }

    out.set(config.agentId, {
      uptime: roundTo(clamp((counts.success / counts.total) * 100, 0, 100), 4),
      samples: counts.total,
    });
  }

  return out;
};

const computeOutcomeFallbackUptimeByAgentId = async (since: Date): Promise<Map<string, MetricSample>> => {
  const out = new Map<string, MetricSample>();
  if (!(await tableExists("TelemetryOutcomeEvent"))) {
    return out;
  }

  const grouped = await prisma.telemetryOutcomeEvent.groupBy({
    by: ["agentId", "success"],
    where: {
      createdAt: { gte: since },
      agentId: { not: null },
    },
    _count: { _all: true },
  });

  const counters = new Map<string, { total: number; success: number }>();
  for (const row of grouped) {
    if (!row.agentId) continue;
    const current = counters.get(row.agentId) ?? { total: 0, success: 0 };
    const count = row._count._all;
    current.total += count;
    if (row.success) current.success += count;
    counters.set(row.agentId, current);
  }

  for (const [agentId, counter] of counters) {
    if (counter.total <= 0) continue;
    out.set(agentId, {
      uptime: roundTo(clamp((counter.success / counter.total) * 100, 0, 100), 4),
      samples: counter.total,
    });
  }

  return out;
};

const run = async (): Promise<void> => {
  const argWindowMinutes = getArgValue("--window-minutes");
  const windowMinutes = parsePositiveInt(
    argWindowMinutes ?? process.env.GHOST_TELEMETRY_WINDOW_MINUTES,
    DEFAULT_WINDOW_MINUTES,
    7 * 24 * 60,
  );
  const dryRun = hasArgFlag("--dry-run") || process.env.GHOST_TELEMETRY_INGEST_DRY_RUN?.trim() === "true";
  const updateBatchSize = parsePositiveInt(process.env.GHOST_TELEMETRY_INGEST_BATCH_SIZE, DEFAULT_UPDATE_BATCH_SIZE, 2_000);
  const creditPriceWei = getCreditPriceWei();
  const now = new Date();
  const since = new Date(now.getTime() - windowMinutes * 60_000);

  if (!(await tableExists("Agent"))) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: "Agent table not present in current environment.",
        },
        null,
        2,
      ),
    );
    return;
  }

  const [agents, yieldByAgentId, canaryUptimeByAgentId, outcomeFallbackUptimeByAgentId] = await Promise.all([
    prisma.agent.findMany({
      select: {
        address: true,
        agentId: true,
        yield: true,
        uptime: true,
      },
    }),
    computeYieldByAgentId(since, creditPriceWei),
    computeCanaryUptimeByAgentId(since),
    computeOutcomeFallbackUptimeByAgentId(since),
  ]);

  const agentRows: AgentRow[] = agents.map((row) => ({
    address: row.address,
    agentId: row.agentId,
    yield: typeof row.yield === "number" && Number.isFinite(row.yield) ? row.yield : 0,
    uptime: typeof row.uptime === "number" && Number.isFinite(row.uptime) ? row.uptime : 0,
  }));

  const updates: AgentUpdate[] = [];
  for (const agent of agentRows) {
    const nextYield = roundTo(Math.max(0, yieldByAgentId.get(agent.agentId) ?? 0), 8);

    const canary = canaryUptimeByAgentId.get(agent.agentId);
    const fallback = outcomeFallbackUptimeByAgentId.get(agent.agentId);

    let nextUptime = 0;
    let uptimeSource: "canary" | "outcome" | "none" = "none";
    let uptimeSamples = 0;

    if (canary) {
      nextUptime = roundTo(clamp(canary.uptime, 0, 100), 4);
      uptimeSource = "canary";
      uptimeSamples = canary.samples;
    } else if (fallback) {
      nextUptime = roundTo(clamp(fallback.uptime, 0, 100), 4);
      uptimeSource = "outcome";
      uptimeSamples = fallback.samples;
    }

    const previousYield = roundTo(Math.max(0, agent.yield), 8);
    const previousUptime = roundTo(clamp(agent.uptime, 0, 100), 4);

    if (!hasMeaningfulDelta(previousYield, nextYield) && !hasMeaningfulDelta(previousUptime, nextUptime)) {
      continue;
    }

    updates.push({
      address: agent.address,
      agentId: agent.agentId,
      previousYield,
      nextYield,
      previousUptime,
      nextUptime,
      uptimeSource,
      uptimeSamples,
    });
  }

  let updatedCount = 0;
  if (!dryRun && updates.length > 0) {
    for (const chunk of chunkArray(updates, updateBatchSize)) {
      await prisma.$transaction(
        chunk.map((update) =>
          prisma.agent.update({
            where: { address: update.address },
            data: {
              yield: update.nextYield,
              uptime: update.nextUptime,
            },
          }),
        ),
      );
      updatedCount += chunk.length;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        window: {
          minutes: windowMinutes,
          since: since.toISOString(),
          now: now.toISOString(),
        },
        sources: {
          yieldCapturedAgents: yieldByAgentId.size,
          canaryUptimeAgents: canaryUptimeByAgentId.size,
          outcomeFallbackAgents: outcomeFallbackUptimeByAgentId.size,
        },
        totals: {
          agentsScanned: agentRows.length,
          updatesPlanned: updates.length,
          updatesApplied: dryRun ? 0 : updatedCount,
        },
        sample: updates.slice(0, 10),
      },
      null,
      2,
    ),
  );
};

run()
  .catch((error) => {
    console.error("Telemetry signal ingestion failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
