import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeCommerceQuality, computeWireConfidence, normalizeLog100 } from "@/lib/ghostrank-rail-score";

export const GHOSTWIRE_SCORE_WINDOW_DAYS = 30;

type GhostWireRollupRow = {
  providerAgentId: string;
  completed_count: bigint;
  rejected_count: bigint;
  expired_count: bigint;
  settled_principal_amount: bigint;
  settled_provider_earnings: bigint;
};

export type GhostWireProviderRollup = {
  providerAgentId: string;
  completedCount: number;
  rejectedCount: number;
  expiredCount: number;
  terminalJobs: number;
  settledPrincipalAmount: bigint;
  settledProviderEarnings: bigint;
  volumeConfidence: number;
  depthConfidence: number;
  commerceQuality: number;
  wireYield: number;
  wireConfidence: number;
};

const toSafeInt = (value: bigint): number => {
  if (value <= 0n) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return value > max ? Number.MAX_SAFE_INTEGER : Number(value);
};

const usdcAtomicToFloat = (value: bigint): number => Number(value) / 1_000_000;

export const deriveWireDepthConfidence = (terminalJobs: number): number => {
  if (terminalJobs <= 0) return 0;
  return Math.min(1, terminalJobs / 10);
};

export const deriveWireVolumeConfidence = (
  settledPrincipalAtomic: bigint,
  maxSettledPrincipalAtomic: bigint,
): number => {
  if (settledPrincipalAtomic <= 0n || maxSettledPrincipalAtomic <= 0n) return 0;
  return normalizeLog100(toSafeInt(settledPrincipalAtomic), toSafeInt(maxSettledPrincipalAtomic)) / 100;
};

export const buildGhostWireProviderRollup = (input: {
  providerAgentId: string;
  completedCount: number;
  rejectedCount: number;
  expiredCount: number;
  settledPrincipalAtomic: bigint;
  settledProviderEarningsAtomic: bigint;
  maxSettledPrincipalAtomic: bigint;
}): GhostWireProviderRollup => {
  const terminalJobs = input.completedCount + input.rejectedCount + input.expiredCount;
  const volumeConfidence = deriveWireVolumeConfidence(input.settledPrincipalAtomic, input.maxSettledPrincipalAtomic);
  const depthConfidence = deriveWireDepthConfidence(terminalJobs);
  const commerceQuality = computeCommerceQuality({
    completedCount: input.completedCount,
    rejectedCount: input.rejectedCount,
    expiredCount: input.expiredCount,
    volumeConfidence,
    depthConfidence,
  });
  const wireYield = usdcAtomicToFloat(input.settledProviderEarningsAtomic);
  const wireConfidence = computeWireConfidence({
    terminalJobs,
    settledPrincipal: toSafeInt(input.settledPrincipalAtomic),
    settledProviderEarnings: wireYield,
  });

  return {
    providerAgentId: input.providerAgentId,
    completedCount: input.completedCount,
    rejectedCount: input.rejectedCount,
    expiredCount: input.expiredCount,
    terminalJobs,
    settledPrincipalAmount: input.settledPrincipalAtomic,
    settledProviderEarnings: input.settledProviderEarningsAtomic,
    volumeConfidence,
    depthConfidence,
    commerceQuality,
    wireYield,
    wireConfidence,
  };
};

export const fetchGhostWireProviderRollups = async (
  since: Date,
): Promise<Map<string, GhostWireProviderRollup>> => {
  const rows = await prisma.$queryRaw<GhostWireRollupRow[]>(Prisma.sql`
    SELECT
      j."providerAgentId" AS "providerAgentId",
      COUNT(*) FILTER (WHERE t."toState" = 'COMPLETED')::bigint AS completed_count,
      COUNT(*) FILTER (WHERE t."toState" = 'REJECTED')::bigint AS rejected_count,
      COUNT(*) FILTER (WHERE t."toState" = 'EXPIRED')::bigint AS expired_count,
      COALESCE(SUM(j."principalAmount"), 0)::bigint AS settled_principal_amount,
      COALESCE(
        SUM(
          CASE
            WHEN t."toState" = 'COMPLETED' THEN GREATEST(j."principalAmount" - j."protocolFeeAmount", 0)
            ELSE 0
          END
        ),
        0
      )::bigint AS settled_provider_earnings
    FROM "WireJob" j
    INNER JOIN "WireJobWorkflow" wf
      ON wf."wireJobId" = j."id"
     AND wf."reconcileStatus" = 'SUCCEEDED'
    INNER JOIN "WireJobTransition" t
      ON t."wireJobId" = j."id"
     AND t."toState" IN ('COMPLETED', 'REJECTED', 'EXPIRED')
     AND t."confirmedAt" IS NOT NULL
     AND t."confirmedAt" >= ${since}
    WHERE j."providerAgentId" IS NOT NULL
    GROUP BY j."providerAgentId"
  `);

  const maxSettledPrincipalAtomic = rows.reduce(
    (maxValue, row) => (row.settled_principal_amount > maxValue ? row.settled_principal_amount : maxValue),
    0n,
  );
  const byAgentId = new Map<string, GhostWireProviderRollup>();
  for (const row of rows) {
    byAgentId.set(
      row.providerAgentId,
      buildGhostWireProviderRollup({
        providerAgentId: row.providerAgentId,
        completedCount: toSafeInt(row.completed_count),
        rejectedCount: toSafeInt(row.rejected_count),
        expiredCount: toSafeInt(row.expired_count),
        settledPrincipalAtomic: row.settled_principal_amount,
        settledProviderEarningsAtomic: row.settled_provider_earnings,
        maxSettledPrincipalAtomic,
      }),
    );
  }

  return byAgentId;
};
