import { type WireContractState } from "@prisma/client";
import { getAddress } from "viem";
import { prisma } from "@/lib/db";

const OPEN_WIRE_STATES: WireContractState[] = ["OPEN", "FUNDED", "SUBMITTED"];

const parseBoolEnv = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw == null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes" || value === "on") return true;
  if (value === "false" || value === "0" || value === "no" || value === "off") return false;
  return fallback;
};

const parsePositiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveBigIntEnv = (raw: string | undefined, fallback: bigint): bigint => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : fallback;
};

const parseBpsEnv = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) return fallback;
  return parsed;
};

const parseOptionalCapWei = (raw: string | undefined): bigint | null => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
};

const normalizeAddress = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return getAddress(trimmed).toLowerCase();
  } catch {
    return null;
  }
};

const parseAddressSetEnv = (raw: string | undefined): Set<string> => {
  const normalized = (raw || "")
    .split(",")
    .map((entry) => normalizeAddress(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
};

const isAddressInSet = (address: string, entries: Set<string>): boolean => {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  return entries.has(normalized);
};

const toBigInt = (value: bigint | null | undefined): bigint => value ?? 0n;

type GhostWireExecPolicyConfig = {
  execEnabled: boolean;
  killSwitchEnabled: boolean;
  allowlistEnforced: boolean;
  maxPrincipalAmount: bigint;
  maxOpenJobsPerClient: number;
  clientDailyPrincipalCap: bigint;
  globalDailyPrincipalCap: bigint;
  clientCreateWindowSeconds: number;
  clientCreateWindowMaxCreates: number;
  operatorDailyNativeSpendCapWei: bigint | null;
  manualReviewOpenThreshold: number;
  circuitLookbackMinutes: number;
  circuitFailureCountThreshold: number;
  circuitFailureRatioBps: number;
  allowlistedClients: Set<string>;
  allowlistedProviders: Set<string>;
  allowlistedEvaluators: Set<string>;
};

const resolveGhostWireExecPolicyConfig = (): GhostWireExecPolicyConfig => ({
  execEnabled: parseBoolEnv(process.env.GHOSTWIRE_EXEC_ENABLED, false),
  killSwitchEnabled: parseBoolEnv(process.env.GHOSTWIRE_EXEC_KILL_SWITCH, false),
  allowlistEnforced: parseBoolEnv(process.env.GHOSTWIRE_EXEC_ALLOWLIST_ENFORCED, false),
  maxPrincipalAmount: parsePositiveBigIntEnv(process.env.GHOSTWIRE_EXEC_MAX_PRINCIPAL_ATOMIC, 25_000_000_000n),
  maxOpenJobsPerClient: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_MAX_OPEN_JOBS_PER_CLIENT, 10),
  clientDailyPrincipalCap: parsePositiveBigIntEnv(
    process.env.GHOSTWIRE_EXEC_CLIENT_DAILY_PRINCIPAL_CAP_ATOMIC,
    100_000_000_000n,
  ),
  globalDailyPrincipalCap: parsePositiveBigIntEnv(
    process.env.GHOSTWIRE_EXEC_GLOBAL_DAILY_PRINCIPAL_CAP_ATOMIC,
    1_000_000_000_000n,
  ),
  clientCreateWindowSeconds: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_CLIENT_CREATE_WINDOW_SECONDS, 300),
  clientCreateWindowMaxCreates: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_CLIENT_CREATE_WINDOW_MAX, 10),
  operatorDailyNativeSpendCapWei: parseOptionalCapWei(process.env.GHOSTWIRE_EXEC_OPERATOR_DAILY_NATIVE_CAP_WEI),
  manualReviewOpenThreshold: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_MANUAL_REVIEW_OPEN_THRESHOLD, 10),
  circuitLookbackMinutes: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_CIRCUIT_LOOKBACK_MINUTES, 60),
  circuitFailureCountThreshold: parsePositiveIntEnv(process.env.GHOSTWIRE_EXEC_CIRCUIT_FAILURE_COUNT_THRESHOLD, 8),
  circuitFailureRatioBps: parseBpsEnv(process.env.GHOSTWIRE_EXEC_CIRCUIT_FAILURE_RATIO_BPS, 7000),
  allowlistedClients: parseAddressSetEnv(process.env.GHOSTWIRE_EXEC_CLIENT_ALLOWLIST),
  allowlistedProviders: parseAddressSetEnv(process.env.GHOSTWIRE_EXEC_PROVIDER_ALLOWLIST),
  allowlistedEvaluators: parseAddressSetEnv(process.env.GHOSTWIRE_EXEC_EVALUATOR_ALLOWLIST),
});

type GhostWireExecPolicyFailure = {
  status: number;
  errorCode: string;
  error: string;
  details?: Record<string, unknown>;
};

type GhostWireExecPolicyResult =
  | {
      ok: true;
      policy: {
        allowlistEnforced: boolean;
      };
    }
  | {
      ok: false;
      failure: GhostWireExecPolicyFailure;
    };

const policyFailure = (
  status: number,
  errorCode: string,
  error: string,
  details?: Record<string, unknown>,
): GhostWireExecPolicyResult => ({
  ok: false,
  failure: {
    status,
    errorCode,
    error,
    details,
  },
});

export const evaluateGhostWireExecutionPolicy = async (input: {
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  principalAmountAtomic: bigint;
}): Promise<GhostWireExecPolicyResult> => {
  const config = resolveGhostWireExecPolicyConfig();

  if (!config.execEnabled) {
    return policyFailure(403, "GHOSTWIRE_EXEC_DISABLED", "GhostWire execution is currently disabled.");
  }

  if (config.killSwitchEnabled) {
    return policyFailure(503, "GHOSTWIRE_EXEC_KILL_SWITCH", "GhostWire execution is paused by operator policy.");
  }

  if (config.allowlistEnforced) {
    if (
      config.allowlistedClients.size === 0 &&
      config.allowlistedProviders.size === 0 &&
      config.allowlistedEvaluators.size === 0
    ) {
      return policyFailure(
        503,
        "GHOSTWIRE_EXEC_ALLOWLIST_EMPTY",
        "GhostWire allowlist enforcement is enabled but no allowlist entries are configured.",
      );
    }

    if (config.allowlistedClients.size > 0 && !isAddressInSet(input.clientAddress, config.allowlistedClients)) {
      return policyFailure(403, "GHOSTWIRE_EXEC_CLIENT_NOT_ALLOWLISTED", "Client address is not allowlisted.");
    }
    if (config.allowlistedProviders.size > 0 && !isAddressInSet(input.providerAddress, config.allowlistedProviders)) {
      return policyFailure(403, "GHOSTWIRE_EXEC_PROVIDER_NOT_ALLOWLISTED", "Provider address is not allowlisted.");
    }
    if (
      config.allowlistedEvaluators.size > 0 &&
      !isAddressInSet(input.evaluatorAddress, config.allowlistedEvaluators)
    ) {
      return policyFailure(403, "GHOSTWIRE_EXEC_EVALUATOR_NOT_ALLOWLISTED", "Evaluator address is not allowlisted.");
    }
  }

  if (input.principalAmountAtomic > config.maxPrincipalAmount) {
    return policyFailure(422, "GHOSTWIRE_EXEC_PRINCIPAL_LIMIT", "Wire principal exceeds policy maximum.", {
      principalAmountAtomic: input.principalAmountAtomic.toString(),
      maxPrincipalAmountAtomic: config.maxPrincipalAmount.toString(),
    });
  }

  const now = new Date();
  const clientWindowStart = new Date(now.getTime() - config.clientCreateWindowSeconds * 1000);
  const dailyWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const circuitWindowStart = new Date(now.getTime() - config.circuitLookbackMinutes * 60 * 1000);

  const [
    openJobsForClient,
    recentCreatesForClient,
    clientDailyPrincipalAggregate,
    globalDailyPrincipalAggregate,
    operatorDailySpendAggregate,
    openManualReviewCount,
    circuitSampleCount,
    circuitFailedCount,
  ] = await Promise.all([
    prisma.wireJob.count({
      where: {
        clientAddress: input.clientAddress,
        contractState: { in: OPEN_WIRE_STATES },
      },
    }),
    prisma.wireJob.count({
      where: {
        clientAddress: input.clientAddress,
        createdAt: { gte: clientWindowStart },
      },
    }),
    prisma.wireJob.aggregate({
      _sum: { principalAmount: true },
      where: {
        clientAddress: input.clientAddress,
        createdAt: { gte: dailyWindowStart },
      },
    }),
    prisma.wireJob.aggregate({
      _sum: { principalAmount: true },
      where: {
        createdAt: { gte: dailyWindowStart },
      },
    }),
    config.operatorDailyNativeSpendCapWei
      ? prisma.wireOperatorSpend.aggregate({
          _sum: { nativeAmountSpent: true },
          where: {
            recordedAt: { gte: dailyWindowStart },
          },
        })
      : Promise.resolve({ _sum: { nativeAmountSpent: null } }),
    prisma.wireJobWorkflow.count({
      where: {
        manualReviewRequired: true,
      },
    }),
    prisma.wireJobWorkflow.count({
      where: {
        updatedAt: { gte: circuitWindowStart },
      },
    }),
    prisma.wireJobWorkflow.count({
      where: {
        updatedAt: { gte: circuitWindowStart },
        OR: [
          { createStatus: "FAILED" },
          { fundStatus: "FAILED" },
          { confirmationStatus: "FAILED" },
          { reconcileStatus: "FAILED" },
          { manualReviewRequired: true },
        ],
      },
    }),
  ]);

  if (openJobsForClient >= config.maxOpenJobsPerClient) {
    return policyFailure(429, "GHOSTWIRE_EXEC_OPEN_JOBS_LIMIT", "Client has reached open GhostWire job limit.", {
      clientAddress: input.clientAddress,
      openJobsForClient,
      maxOpenJobsPerClient: config.maxOpenJobsPerClient,
    });
  }

  if (recentCreatesForClient >= config.clientCreateWindowMaxCreates) {
    return policyFailure(
      429,
      "GHOSTWIRE_EXEC_CLIENT_RATE_LIMIT",
      "Client exceeded GhostWire create rate limit window.",
      {
        clientAddress: input.clientAddress,
        recentCreatesForClient,
        clientCreateWindowSeconds: config.clientCreateWindowSeconds,
        clientCreateWindowMaxCreates: config.clientCreateWindowMaxCreates,
      },
    );
  }

  const clientDailyPrincipal = toBigInt(clientDailyPrincipalAggregate._sum.principalAmount);
  const clientProjectedPrincipal = clientDailyPrincipal + input.principalAmountAtomic;
  if (clientProjectedPrincipal > config.clientDailyPrincipalCap) {
    return policyFailure(429, "GHOSTWIRE_EXEC_CLIENT_DAILY_CAP", "Client daily GhostWire principal cap exceeded.", {
      clientAddress: input.clientAddress,
      currentDailyPrincipalAtomic: clientDailyPrincipal.toString(),
      projectedDailyPrincipalAtomic: clientProjectedPrincipal.toString(),
      clientDailyPrincipalCapAtomic: config.clientDailyPrincipalCap.toString(),
    });
  }

  const globalDailyPrincipal = toBigInt(globalDailyPrincipalAggregate._sum.principalAmount);
  const globalProjectedPrincipal = globalDailyPrincipal + input.principalAmountAtomic;
  if (globalProjectedPrincipal > config.globalDailyPrincipalCap) {
    return policyFailure(503, "GHOSTWIRE_EXEC_GLOBAL_DAILY_CAP", "Global GhostWire daily principal cap exceeded.", {
      currentGlobalDailyPrincipalAtomic: globalDailyPrincipal.toString(),
      projectedGlobalDailyPrincipalAtomic: globalProjectedPrincipal.toString(),
      globalDailyPrincipalCapAtomic: config.globalDailyPrincipalCap.toString(),
    });
  }

  if (config.operatorDailyNativeSpendCapWei) {
    const operatorDailySpendWei = toBigInt(operatorDailySpendAggregate._sum.nativeAmountSpent);
    if (operatorDailySpendWei >= config.operatorDailyNativeSpendCapWei) {
      return policyFailure(503, "GHOSTWIRE_EXEC_OPERATOR_SPEND_CAP", "Operator daily native spend cap reached.", {
        operatorDailySpendWei: operatorDailySpendWei.toString(),
        operatorDailyNativeSpendCapWei: config.operatorDailyNativeSpendCapWei.toString(),
      });
    }
  }

  if (openManualReviewCount >= config.manualReviewOpenThreshold) {
    return policyFailure(503, "GHOSTWIRE_EXEC_MANUAL_REVIEW_BACKLOG", "GhostWire manual review backlog threshold reached.", {
      openManualReviewCount,
      manualReviewOpenThreshold: config.manualReviewOpenThreshold,
    });
  }

  if (circuitSampleCount >= config.circuitFailureCountThreshold && config.circuitFailureRatioBps > 0) {
    const circuitFailureRatioBps = Math.floor((circuitFailedCount * 10_000) / Math.max(circuitSampleCount, 1));
    if (circuitFailureRatioBps >= config.circuitFailureRatioBps) {
      return policyFailure(503, "GHOSTWIRE_EXEC_CIRCUIT_OPEN", "GhostWire execution circuit breaker is open.", {
        circuitLookbackMinutes: config.circuitLookbackMinutes,
        circuitSampleCount,
        circuitFailedCount,
        observedFailureRatioBps: circuitFailureRatioBps,
        failureRatioThresholdBps: config.circuitFailureRatioBps,
      });
    }
  }

  return {
    ok: true,
    policy: {
      allowlistEnforced: config.allowlistEnforced,
    },
  };
};

