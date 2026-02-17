const CLAIMED_STATUS_TOKENS = ["claimed", "verified", "monetized"] as const;

const hasPositiveMetric = (value: number | null | undefined): boolean =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export const statusIndicatesClaimed = (status: string | null | undefined): boolean => {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return CLAIMED_STATUS_TOKENS.some((token) => normalized.includes(token));
};

export const tierIndicatesClaimed = (tier: string | null | undefined): boolean =>
  tier === "WHALE" || tier === "ACTIVE";

export const isClaimedAgent = ({
  status,
  tier,
  yieldValue,
  uptimeValue,
}: {
  status: string | null | undefined;
  tier?: string | null;
  yieldValue?: number | null;
  uptimeValue?: number | null;
}): boolean =>
  statusIndicatesClaimed(status) ||
  tierIndicatesClaimed(tier) ||
  hasPositiveMetric(yieldValue) ||
  hasPositiveMetric(uptimeValue);
