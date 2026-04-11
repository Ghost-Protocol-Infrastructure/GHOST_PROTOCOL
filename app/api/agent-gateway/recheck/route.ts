import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  computeAgentGatewaySchedulerStaleAfterMs,
  degradeStaleAgentGatewayConfigs,
  getAgentGatewayLiveStaleAfterMs,
  isMissingAgentGatewayPhaseBTableError,
  persistAgentGatewayCanaryOutcome,
  runAgentGatewayCanaryCheck,
  splitAgentGatewayRecheckLimit,
} from "@/lib/agent-gateway-canary";

export const runtime = "nodejs";

const DEFAULT_RECHECK_LIMIT = 100;
const MAX_RECHECK_LIMIT = 200;
const DEFAULT_RECHECK_STATUSES = ["LIVE", "DEGRADED"] as const;
type RecheckReadinessStatus = (typeof DEFAULT_RECHECK_STATUSES)[number];
const liveRecheckOrderBy = [
  { lastCanaryPassedAt: { sort: "asc" as const, nulls: "first" as const } },
  { lastCanaryCheckedAt: { sort: "asc" as const, nulls: "first" as const } },
  { updatedAt: "asc" as const },
];
const degradedRecheckOrderBy = [
  { lastCanaryCheckedAt: { sort: "asc" as const, nulls: "first" as const } },
  { updatedAt: "asc" as const },
];
const gatewayConfigSelect = {
  id: true,
  agentId: true,
  serviceSlug: true,
  endpointUrl: true,
  canaryPath: true,
  readinessStatus: true,
};

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseBoolean = (value: string | null): boolean =>
  value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const parseLimit = (value: string | null): number => {
  if (!value) return DEFAULT_RECHECK_LIMIT;
  if (!/^\d+$/.test(value.trim())) return DEFAULT_RECHECK_LIMIT;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECHECK_LIMIT;
  return Math.min(parsed, MAX_RECHECK_LIMIT);
};

const parseRecheckStatuses = (value: string | null): RecheckReadinessStatus[] => {
  if (!value) return [...DEFAULT_RECHECK_STATUSES];

  const parsed = value
    .split(",")
    .map((status) => status.trim().toUpperCase())
    .filter((status): status is RecheckReadinessStatus =>
      (DEFAULT_RECHECK_STATUSES as readonly string[]).includes(status),
    );

  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_RECHECK_STATUSES];
};

export const shouldRunAgentGatewayStaleSweep = (
  statuses: readonly RecheckReadinessStatus[],
): boolean => statuses.includes("LIVE");

export const buildTargetedAgentGatewayRecheckWhere = (
  agentId: string,
  statuses: readonly RecheckReadinessStatus[],
) => ({
  agentId,
  readinessStatus: {
    in: [...statuses],
  },
});

const normalizeCronSecret = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const getProvidedCronSecret = (request: NextRequest): string | null => {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const headerSecret = request.headers.get("x-agent-gateway-recheck-secret")?.trim();
  if (headerSecret) return headerSecret;

  const querySecret = request.nextUrl.searchParams.get("secret")?.trim();
  if (querySecret) return querySecret;

  return null;
};

const isAuthorized = (request: NextRequest): boolean => {
  const expected = normalizeCronSecret(process.env.GHOST_AGENT_GATEWAY_RECHECK_SECRET);
  if (!expected) return false;
  const provided = getProvidedCronSecret(request);
  return provided === expected;
};

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return json({ code: 401, error: "Unauthorized recheck request." }, 401);
  }

  const params = request.nextUrl.searchParams;
  const limit = parseLimit(params.get("limit"));
  const dryRun = parseBoolean(params.get("dryRun"));
  const onlyAgentId = params.get("agentId")?.trim() || null;
  const statuses = parseRecheckStatuses(params.get("statuses"));
  const canRecheckLive = statuses.includes("LIVE");
  const shouldRunStaleSweep = shouldRunAgentGatewayStaleSweep(statuses);

  try {
    let liveCount = 0;
    let degradedCount = 0;
    let liveLimit = 0;
    let degradedLimit = 0;
    let staleAfterMs = getAgentGatewayLiveStaleAfterMs();

    if (onlyAgentId) {
      liveLimit = canRecheckLive ? 1 : 0;
      staleAfterMs = computeAgentGatewaySchedulerStaleAfterMs({
        configuredStaleAfterMs: staleAfterMs,
        liveConfigCount: canRecheckLive ? 1 : 0,
        liveRecheckLimit: liveLimit,
      });
    } else if (canRecheckLive) {
      const counts = await prisma.agentGatewayConfig.groupBy({
        by: ["readinessStatus"],
        where: {
          readinessStatus: { in: statuses },
        },
        _count: { _all: true },
      });

      for (const row of counts) {
        if (row.readinessStatus === "LIVE") liveCount = row._count._all;
        if (row.readinessStatus === "DEGRADED") degradedCount = row._count._all;
      }

      if (statuses.length === 1 && statuses[0] === "LIVE") {
        liveLimit = Math.min(limit, liveCount);
      } else {
        const split = splitAgentGatewayRecheckLimit({
          limit,
          liveCount,
          degradedCount,
        });
        liveLimit = split.liveLimit;
        degradedLimit = split.degradedLimit;
      }

      staleAfterMs = computeAgentGatewaySchedulerStaleAfterMs({
        configuredStaleAfterMs: staleAfterMs,
        liveConfigCount: liveCount,
        liveRecheckLimit: liveLimit,
      });
    } else if (!onlyAgentId) {
      degradedCount = await prisma.agentGatewayConfig.count({
        where: { readinessStatus: "DEGRADED" },
      });
      degradedLimit = Math.min(limit, degradedCount);
    }

    const staleSweep = shouldRunStaleSweep
      ? await degradeStaleAgentGatewayConfigs({
          onlyAgentId,
          staleAfterMs,
          dryRun,
        })
      : {
          staleAfterMs,
          staleCutoffAt: new Date(Date.now() - staleAfterMs),
          matched: 0,
          degraded: 0,
        };

    let configs: Array<{
      id: string;
      agentId: string;
      serviceSlug: string;
      endpointUrl: string;
      canaryPath: string;
      readinessStatus: "LIVE" | "DEGRADED" | "CONFIGURED" | "UNCONFIGURED";
    }> = [];

    if (onlyAgentId) {
      configs = await prisma.agentGatewayConfig.findMany({
        where: buildTargetedAgentGatewayRecheckWhere(onlyAgentId, statuses),
        orderBy: canRecheckLive ? liveRecheckOrderBy : degradedRecheckOrderBy,
        take: 1,
        select: gatewayConfigSelect,
      });
      liveCount = configs.filter((config) => config.readinessStatus === "LIVE").length;
      degradedCount = configs.filter((config) => config.readinessStatus === "DEGRADED").length;
      liveLimit = liveCount;
      degradedLimit = degradedCount;
    } else if (statuses.length === 1 && statuses[0] === "LIVE") {
      configs = await prisma.agentGatewayConfig.findMany({
        where: { readinessStatus: "LIVE" },
        orderBy: liveRecheckOrderBy,
        take: limit,
        select: gatewayConfigSelect,
      });
      liveLimit = configs.length;
    } else if (statuses.length === 1 && statuses[0] === "DEGRADED") {
      configs = await prisma.agentGatewayConfig.findMany({
        where: { readinessStatus: "DEGRADED" },
        orderBy: degradedRecheckOrderBy,
        take: limit,
        select: gatewayConfigSelect,
      });
      degradedLimit = configs.length;
    } else {
      const [liveConfigs, degradedConfigs] = await Promise.all([
        liveLimit > 0
          ? prisma.agentGatewayConfig.findMany({
              where: { readinessStatus: "LIVE" },
              orderBy: liveRecheckOrderBy,
              take: liveLimit,
              select: gatewayConfigSelect,
            })
          : Promise.resolve([]),
        degradedLimit > 0
          ? prisma.agentGatewayConfig.findMany({
              where: { readinessStatus: "DEGRADED" },
              orderBy: degradedRecheckOrderBy,
              take: degradedLimit,
              select: gatewayConfigSelect,
            })
          : Promise.resolve([]),
      ]);

      configs = [...liveConfigs, ...degradedConfigs];
      liveLimit = liveConfigs.length;
      degradedLimit = degradedConfigs.length;
    }

    if (dryRun) {
      return json(
        {
          ok: true,
          dryRun: true,
          statuses,
          staleSweep: {
            staleAfterMs: staleSweep.staleAfterMs,
            staleCutoffAt: staleSweep.staleCutoffAt.toISOString(),
            matched: staleSweep.matched,
            degraded: staleSweep.degraded,
          },
          selection: {
            liveCount,
            degradedCount,
            liveLimit,
            degradedLimit,
          },
          selected: configs.length,
          limit,
          agentIds: configs.map((config) => config.agentId),
        },
        200,
      );
    }

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let degraded = 0;
    let live = 0;
    let historySkipped = 0;

    const results: Array<{
      agentId: string;
      serviceSlug: string;
      success: boolean;
      readinessStatus: string;
      statusCode: number | null;
      latencyMs: number | null;
      error: string | null;
      historyRecorded: boolean;
    }> = [];

    for (const config of configs) {
      const canaryResult = await runAgentGatewayCanaryCheck(config, {
        userAgent: "ghostprotocol-canary/recheck",
      });

      const persisted = await persistAgentGatewayCanaryOutcome({
        config,
        result: canaryResult,
      });

      processed += 1;
      if (canaryResult.success) succeeded += 1;
      else failed += 1;

      if (persisted.readinessStatus === "LIVE") live += 1;
      if (persisted.readinessStatus === "DEGRADED") degraded += 1;
      if (!persisted.historyRecorded) historySkipped += 1;

      results.push({
        agentId: config.agentId,
        serviceSlug: config.serviceSlug,
        success: canaryResult.success,
        readinessStatus: persisted.readinessStatus,
        statusCode: canaryResult.statusCode,
        latencyMs: canaryResult.latencyMs,
        error: canaryResult.error,
        historyRecorded: persisted.historyRecorded,
      });
    }

    return json(
      {
        ok: true,
        dryRun: false,
        statuses,
        staleSweep: {
          staleAfterMs: staleSweep.staleAfterMs,
          staleCutoffAt: staleSweep.staleCutoffAt.toISOString(),
          matched: staleSweep.matched,
          degraded: staleSweep.degraded,
        },
        selection: {
          liveCount,
          degradedCount,
          liveLimit,
          degradedLimit,
        },
        limit,
        selected: configs.length,
        processed,
        succeeded,
        failed,
        live,
        degraded,
        historySkipped,
        results,
      },
      200,
    );
  } catch (error) {
    if (isMissingAgentGatewayPhaseBTableError(error)) {
      return json(
        {
          code: 503,
          error:
            "Agent gateway recheck tables are not available. Apply the Prisma schema update before using this endpoint.",
        },
        503,
      );
    }

    return json({ code: 500, error: "Failed to run agent gateway rechecks." }, 500);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
