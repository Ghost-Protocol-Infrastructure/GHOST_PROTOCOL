import type { AgentTier, TxMetricSource } from "@prisma/client";

const clamp = (value: number, min = 0, max = 100): number => Math.min(max, Math.max(min, value));
const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

export const FALLBACK_PROXY_TX_SIGNAL_CAP = 30;

export const isFallbackTxMetricSource = (metricSource: TxMetricSource): boolean =>
  metricSource === "OWNER_FALLBACK" || metricSource === "CREATOR_FALLBACK";

const getTier = (txCount: number, isClaimed: boolean): AgentTier => {
  if (!isClaimed && txCount <= 0) return "GHOST";
  if (txCount > 500) return "WHALE";
  if (txCount > 50) return "ACTIVE";
  return "NEW";
};

export const computeFallbackProxyTxSignal = (rawNormalizedTxSignal: number, clusterSize: number): number => {
  const safeClusterSize = Math.max(1, Math.trunc(clusterSize));
  const boundedSignal = Math.min(clamp(rawNormalizedTxSignal), FALLBACK_PROXY_TX_SIGNAL_CAP);
  return roundToTwo(clamp(boundedSignal / Math.sqrt(safeClusterSize), 0, FALLBACK_PROXY_TX_SIGNAL_CAP));
};

export const resolveScoreV2Tier = (
  txCount: number,
  isClaimed: boolean,
  metricSource: TxMetricSource,
): AgentTier => {
  if (!isFallbackTxMetricSource(metricSource)) {
    return getTier(txCount, isClaimed);
  }

  if (!isClaimed && txCount <= 0) return "GHOST";
  return txCount > 0 ? "NEW" : isClaimed ? "NEW" : "GHOST";
};
