import { createHash } from "node:crypto";
import { Prisma, type AgentGatewayReadinessStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  AGENT_GATEWAY_VERIFY_TIMEOUT_MS,
  buildCanaryUrl,
  matchesCanaryContract,
} from "@/lib/agent-gateway";

export type AgentGatewayCanaryConfigLike = {
  id: string;
  agentId: string;
  serviceSlug: string;
  endpointUrl: string;
  canaryPath: string;
  readinessStatus: AgentGatewayReadinessStatus;
};

export type AgentGatewayCanaryRunResult = {
  canaryUrl: string;
  checkedAt: Date;
  statusCode: number | null;
  latencyMs: number | null;
  responsePayload: unknown;
  error: string | null;
  success: boolean;
  responseDigest: string | null;
};

const DEFAULT_GATEWAY_LIVE_STALE_AFTER_MS = 60 * 60 * 1000;
const MIN_GATEWAY_LIVE_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_GATEWAY_LIVE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AGENT_GATEWAY_RECHECK_INTERVAL_MS = 30 * 60 * 1000;
const MIN_AGENT_GATEWAY_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_AGENT_GATEWAY_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS = 2;
const MIN_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS = 0;
const MAX_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS = 12;
const DEFAULT_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO = 0.2;
const MIN_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO = 0;
const MAX_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO = 0.5;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const parsePositiveMsEnv = (
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const trimmed = rawValue?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parsePositiveIntEnv = (
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const trimmed = rawValue?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseRatioEnv = (rawValue: string | undefined, fallback: number, min: number, max: number): number => {
  const trimmed = rawValue?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const digestResponsePayload = (payload: unknown): string | null => {
  if (payload == null) return null;
  try {
    const normalized = JSON.stringify(payload);
    if (!normalized) return null;
    return createHash("sha256").update(normalized).digest("hex");
  } catch {
    return null;
  }
};

export const getAgentGatewayLiveStaleAfterMs = (): number =>
  parsePositiveMsEnv(
    process.env.GHOST_AGENT_GATEWAY_LIVE_STALE_AFTER_MS,
    DEFAULT_GATEWAY_LIVE_STALE_AFTER_MS,
    MIN_GATEWAY_LIVE_STALE_AFTER_MS,
    MAX_GATEWAY_LIVE_STALE_AFTER_MS,
  );

export const getAgentGatewayRecheckIntervalMs = (): number =>
  parsePositiveMsEnv(
    process.env.GHOST_AGENT_GATEWAY_RECHECK_INTERVAL_MS,
    DEFAULT_AGENT_GATEWAY_RECHECK_INTERVAL_MS,
    MIN_AGENT_GATEWAY_RECHECK_INTERVAL_MS,
    MAX_AGENT_GATEWAY_RECHECK_INTERVAL_MS,
  );

export const getAgentGatewayRecheckStaleBufferRuns = (): number =>
  parsePositiveIntEnv(
    process.env.GHOST_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
    DEFAULT_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
    MIN_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
    MAX_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
  );

export const getAgentGatewayRecheckDegradedReserveRatio = (): number =>
  parseRatioEnv(
    process.env.GHOST_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
    DEFAULT_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
    MIN_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
    MAX_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
  );

export const computeAgentGatewaySchedulerStaleAfterMs = (input: {
  configuredStaleAfterMs: number;
  liveConfigCount: number;
  liveRecheckLimit: number;
  recheckIntervalMs?: number;
  staleBufferRuns?: number;
}): number => {
  const configuredStaleAfterMs = Math.min(
    MAX_GATEWAY_LIVE_STALE_AFTER_MS,
    Math.max(MIN_GATEWAY_LIVE_STALE_AFTER_MS, input.configuredStaleAfterMs),
  );

  const liveConfigCount = Math.max(0, Math.floor(input.liveConfigCount));
  const liveRecheckLimit = Math.max(0, Math.floor(input.liveRecheckLimit));
  if (liveConfigCount === 0 || liveRecheckLimit === 0) {
    return configuredStaleAfterMs;
  }

  const recheckIntervalMs = Math.min(
    MAX_AGENT_GATEWAY_RECHECK_INTERVAL_MS,
    Math.max(MIN_AGENT_GATEWAY_RECHECK_INTERVAL_MS, input.recheckIntervalMs ?? getAgentGatewayRecheckIntervalMs()),
  );
  const staleBufferRuns = Math.min(
    MAX_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
    Math.max(
      MIN_AGENT_GATEWAY_RECHECK_STALE_BUFFER_RUNS,
      Math.floor(input.staleBufferRuns ?? getAgentGatewayRecheckStaleBufferRuns()),
    ),
  );
  const cyclesNeeded = Math.max(1, Math.ceil(liveConfigCount / liveRecheckLimit));
  const schedulerFloor = (cyclesNeeded + staleBufferRuns) * recheckIntervalMs;

  return Math.min(MAX_GATEWAY_LIVE_STALE_AFTER_MS, Math.max(configuredStaleAfterMs, schedulerFloor));
};

export const splitAgentGatewayRecheckLimit = (input: {
  limit: number;
  liveCount: number;
  degradedCount: number;
  degradedReserveRatio?: number;
}): {
  liveLimit: number;
  degradedLimit: number;
} => {
  const limit = Math.max(1, Math.floor(input.limit));
  const liveCount = Math.max(0, Math.floor(input.liveCount));
  const degradedCount = Math.max(0, Math.floor(input.degradedCount));
  const degradedReserveRatio = Math.min(
    MAX_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
    Math.max(
      MIN_AGENT_GATEWAY_RECHECK_DEGRADED_RESERVE_RATIO,
      input.degradedReserveRatio ?? getAgentGatewayRecheckDegradedReserveRatio(),
    ),
  );

  const reservedDegraded = liveCount >= limit ? 0 : Math.min(degradedCount, Math.floor(limit * degradedReserveRatio));
  const liveLimit = Math.min(liveCount, limit - reservedDegraded);
  const degradedLimit = Math.min(degradedCount, limit - liveLimit);

  return { liveLimit, degradedLimit };
};

export const buildGatewayReadinessStaleReason = (staleAfterMs: number): string => {
  const staleMinutes = Math.round(staleAfterMs / 60000);
  return `Gateway readiness is stale. No successful canary verification within ${staleMinutes} minute(s).`;
};

export const getGatewayReadinessStaleCutoff = (
  now: Date = new Date(),
  staleAfterMs: number = getAgentGatewayLiveStaleAfterMs(),
): Date => new Date(now.getTime() - staleAfterMs);

export const degradeStaleAgentGatewayConfigs = async (options?: {
  now?: Date;
  staleAfterMs?: number;
  onlyAgentId?: string | null;
  excludeAgentIds?: string[];
  dryRun?: boolean;
}): Promise<{
  staleAfterMs: number;
  staleCutoffAt: Date;
  matched: number;
  degraded: number;
}> => {
  const staleAfterMs = options?.staleAfterMs ?? getAgentGatewayLiveStaleAfterMs();
  const staleCutoffAt = getGatewayReadinessStaleCutoff(options?.now ?? new Date(), staleAfterMs);

  const andClauses: Prisma.AgentGatewayConfigWhereInput[] = [];
  if (options?.onlyAgentId) {
    andClauses.push({ agentId: options.onlyAgentId });
  }
  if (options?.excludeAgentIds && options.excludeAgentIds.length > 0) {
    andClauses.push({ agentId: { notIn: options.excludeAgentIds } });
  }

  const where: Prisma.AgentGatewayConfigWhereInput = {
    readinessStatus: "LIVE",
    OR: [{ lastCanaryPassedAt: null }, { lastCanaryPassedAt: { lt: staleCutoffAt } }],
    ...(andClauses.length > 0 ? { AND: andClauses } : {}),
  };

  const matched = await prisma.agentGatewayConfig.count({ where });
  if (options?.dryRun || matched === 0) {
    return {
      staleAfterMs,
      staleCutoffAt,
      matched,
      degraded: 0,
    };
  }

  const updated = await prisma.agentGatewayConfig.updateMany({
    where,
    data: {
      readinessStatus: "DEGRADED",
      lastCanaryError: buildGatewayReadinessStaleReason(staleAfterMs),
    },
  });

  return {
    staleAfterMs,
    staleCutoffAt,
    matched,
    degraded: updated.count,
  };
};

export const runAgentGatewayCanaryCheck = async (
  config: AgentGatewayCanaryConfigLike,
  options?: {
    timeoutMs?: number;
    userAgent?: string;
  },
): Promise<AgentGatewayCanaryRunResult> => {
  const timeoutMs = options?.timeoutMs ?? AGENT_GATEWAY_VERIFY_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? "ghostprotocol-canary/phase-b";
  const canaryUrl = buildCanaryUrl(config.endpointUrl, config.canaryPath);
  const checkedAt = new Date();
  const startedAtMs = Date.now();

  let statusCode: number | null = null;
  let latencyMs: number | null = null;
  let responsePayload: unknown = null;
  let verificationError: string | null = null;

  try {
    const response = await fetch(canaryUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    latencyMs = Math.max(0, Date.now() - startedAtMs);
    statusCode = response.status;

    if (response.status !== 200) {
      verificationError = `Canary endpoint must return HTTP 200. Received ${response.status}.`;
    } else {
      try {
        responsePayload = await response.json();
      } catch {
        verificationError = "Canary endpoint must return valid JSON.";
      }
    }
  } catch (error) {
    latencyMs = Math.max(0, Date.now() - startedAtMs);
    verificationError = getErrorMessage(error);
  }

  if (!verificationError && statusCode === 200) {
    const contractResult = matchesCanaryContract(responsePayload, config.serviceSlug);
    if (!contractResult.ok) {
      verificationError = contractResult.reason;
    }
  }

  return {
    canaryUrl,
    checkedAt,
    statusCode,
    latencyMs,
    responsePayload,
    error: verificationError,
    success: verificationError == null,
    responseDigest: digestResponsePayload(responsePayload),
  };
};

export const resolveGatewayReadinessAfterCanary = (
  currentStatus: AgentGatewayReadinessStatus,
  success: boolean,
): AgentGatewayReadinessStatus => {
  if (success) return "LIVE";
  if (currentStatus === "LIVE" || currentStatus === "DEGRADED") return "DEGRADED";
  return "CONFIGURED";
};

type PersistAgentGatewayCanaryOutcomeInput = {
  config: AgentGatewayCanaryConfigLike;
  result: AgentGatewayCanaryRunResult;
  requestId?: string | null;
};

export const persistAgentGatewayCanaryOutcome = async (
  input: PersistAgentGatewayCanaryOutcomeInput,
): Promise<{
  readinessStatus: AgentGatewayReadinessStatus;
  historyRecorded: boolean;
}> => {
  const nextReadinessStatus = resolveGatewayReadinessAfterCanary(input.config.readinessStatus, input.result.success);
  let historyRecorded = true;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.agentGatewayConfig.update({
        where: { agentId: input.config.agentId },
        data: input.result.success
          ? {
              readinessStatus: nextReadinessStatus,
              lastCanaryCheckedAt: input.result.checkedAt,
              lastCanaryPassedAt: input.result.checkedAt,
              lastCanaryStatusCode: input.result.statusCode,
              lastCanaryLatencyMs: input.result.latencyMs,
              lastCanaryError: null,
            }
          : {
              readinessStatus: nextReadinessStatus,
              lastCanaryCheckedAt: input.result.checkedAt,
              lastCanaryStatusCode: input.result.statusCode,
              lastCanaryLatencyMs: input.result.latencyMs,
              lastCanaryError: input.result.error,
            },
      });

      await tx.agentGatewayCanaryCheck.create({
        data: {
          gatewayConfigId: input.config.id,
          checkedAt: input.result.checkedAt,
          success: input.result.success,
          statusCode: input.result.statusCode,
          latencyMs: input.result.latencyMs,
          error: input.result.error,
          responseDigest: input.result.responseDigest,
          requestId: input.requestId ?? null,
        },
      });
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code?: string }).code === "P2021" || (error as { code?: string }).code === "P2022")
    ) {
      historyRecorded = false;

      await prisma.agentGatewayConfig.update({
        where: { agentId: input.config.agentId },
        data: input.result.success
          ? {
              readinessStatus: nextReadinessStatus,
              lastCanaryCheckedAt: input.result.checkedAt,
              lastCanaryPassedAt: input.result.checkedAt,
              lastCanaryStatusCode: input.result.statusCode,
              lastCanaryLatencyMs: input.result.latencyMs,
              lastCanaryError: null,
            }
          : {
              readinessStatus: nextReadinessStatus,
              lastCanaryCheckedAt: input.result.checkedAt,
              lastCanaryStatusCode: input.result.statusCode,
              lastCanaryLatencyMs: input.result.latencyMs,
              lastCanaryError: input.result.error,
            },
      });
    } else {
      throw error;
    }
  }

  return { readinessStatus: nextReadinessStatus, historyRecorded };
};

export const isMissingAgentGatewayPhaseBTableError = (error: unknown): boolean => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "P2021" || (error as { code?: string }).code === "P2022")
  ) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2021" || error.code === "P2022";
  }

  return false;
};
