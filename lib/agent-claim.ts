const CLAIMED_STATUS_TOKENS = ["claimed", "verified", "monetized"] as const;

const hasPositiveMetric = (value: number | null | undefined): boolean =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const hasPositiveCount = (value: number | null | undefined): boolean =>
  typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;

const hasPositiveAtomicMetric = (value: bigint | number | null | undefined): boolean => {
  if (typeof value === "bigint") return value > 0n;
  return hasPositiveMetric(value);
};

export const statusIndicatesClaimed = (status: string | null | undefined): boolean => {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return CLAIMED_STATUS_TOKENS.some((token) => normalized.includes(token));
};

const tierIndicatesClaimed = (tier: string | null | undefined): boolean =>
  tier === "WHALE" || tier === "ACTIVE";

export const hasAttributedWireEvidence = ({
  wireYieldValue,
  wireCompletedCount,
  wireRejectedCount,
  wireExpiredCount,
  wireSettledPrincipalValue,
  wireSettledProviderEarningsValue,
}: {
  wireYieldValue?: number | null;
  wireCompletedCount?: number | null;
  wireRejectedCount?: number | null;
  wireExpiredCount?: number | null;
  wireSettledPrincipalValue?: bigint | number | null;
  wireSettledProviderEarningsValue?: bigint | number | null;
}): boolean =>
  hasPositiveMetric(wireYieldValue) ||
  hasPositiveCount(wireCompletedCount) ||
  hasPositiveCount(wireRejectedCount) ||
  hasPositiveCount(wireExpiredCount) ||
  hasPositiveAtomicMetric(wireSettledPrincipalValue) ||
  hasPositiveAtomicMetric(wireSettledProviderEarningsValue);

export const isClaimedAgent = ({
  status,
  tier,
  yieldValue,
  uptimeValue,
  wireYieldValue,
  wireCompletedCount,
  wireRejectedCount,
  wireExpiredCount,
  wireSettledPrincipalValue,
  wireSettledProviderEarningsValue,
}: {
  status: string | null | undefined;
  tier?: string | null;
  yieldValue?: number | null;
  uptimeValue?: number | null;
  wireYieldValue?: number | null;
  wireCompletedCount?: number | null;
  wireRejectedCount?: number | null;
  wireExpiredCount?: number | null;
  wireSettledPrincipalValue?: bigint | number | null;
  wireSettledProviderEarningsValue?: bigint | number | null;
}): boolean =>
  statusIndicatesClaimed(status) ||
  tierIndicatesClaimed(tier) ||
  hasPositiveMetric(yieldValue) ||
  hasPositiveMetric(uptimeValue) ||
  hasAttributedWireEvidence({
    wireYieldValue,
    wireCompletedCount,
    wireRejectedCount,
    wireExpiredCount,
    wireSettledPrincipalValue,
    wireSettledProviderEarningsValue,
  });
