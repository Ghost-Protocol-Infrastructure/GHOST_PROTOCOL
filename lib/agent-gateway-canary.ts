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

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
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
