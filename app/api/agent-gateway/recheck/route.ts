import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  isMissingAgentGatewayPhaseBTableError,
  persistAgentGatewayCanaryOutcome,
  runAgentGatewayCanaryCheck,
} from "@/lib/agent-gateway-canary";

export const runtime = "nodejs";

const DEFAULT_RECHECK_LIMIT = 25;
const MAX_RECHECK_LIMIT = 200;

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

  try {
    const configs = await prisma.agentGatewayConfig.findMany({
      where: onlyAgentId
        ? { agentId: onlyAgentId }
        : { readinessStatus: { in: ["LIVE", "DEGRADED"] } },
      orderBy: [{ updatedAt: "asc" }],
      take: limit,
      select: {
        id: true,
        agentId: true,
        serviceSlug: true,
        endpointUrl: true,
        canaryPath: true,
        readinessStatus: true,
      },
    });

    if (dryRun) {
      return json(
        {
          ok: true,
          dryRun: true,
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
            "Phase B agent gateway recheck tables are not available. Apply the Prisma schema update before using this endpoint.",
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
