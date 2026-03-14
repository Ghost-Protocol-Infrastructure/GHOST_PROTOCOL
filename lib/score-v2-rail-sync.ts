import type { GhostWireProviderRollup } from "@/lib/ghostwire-score-rollup";

export type ScoreV2RailMetricFields = {
  wireYield: number;
  commerceQuality: number;
  wireConfidence: number;
  wireCompletedCount30d: number;
  wireRejectedCount30d: number;
  wireExpiredCount30d: number;
  wireSettledPrincipal30d: bigint;
  wireSettledProviderEarnings30d: bigint;
};

export const buildScoreV2RailMetricFields = (
  rollup?: Pick<
    GhostWireProviderRollup,
    | "wireYield"
    | "commerceQuality"
    | "wireConfidence"
    | "completedCount"
    | "rejectedCount"
    | "expiredCount"
    | "settledPrincipalAmount"
    | "settledProviderEarnings"
  > | null,
): ScoreV2RailMetricFields => ({
  wireYield: rollup?.wireYield ?? 0,
  commerceQuality: rollup?.commerceQuality ?? 0,
  wireConfidence: rollup?.wireConfidence ?? 0,
  wireCompletedCount30d: rollup?.completedCount ?? 0,
  wireRejectedCount30d: rollup?.rejectedCount ?? 0,
  wireExpiredCount30d: rollup?.expiredCount ?? 0,
  wireSettledPrincipal30d: rollup?.settledPrincipalAmount ?? 0n,
  wireSettledProviderEarnings30d: rollup?.settledProviderEarnings ?? 0n,
});

export const scoreV2RailMetricFieldsChanged = (
  current: Partial<ScoreV2RailMetricFields> | null | undefined,
  next: ScoreV2RailMetricFields,
): boolean =>
  (current?.wireYield ?? 0) !== next.wireYield ||
  (current?.commerceQuality ?? 0) !== next.commerceQuality ||
  (current?.wireConfidence ?? 0) !== next.wireConfidence ||
  (current?.wireCompletedCount30d ?? 0) !== next.wireCompletedCount30d ||
  (current?.wireRejectedCount30d ?? 0) !== next.wireRejectedCount30d ||
  (current?.wireExpiredCount30d ?? 0) !== next.wireExpiredCount30d ||
  (current?.wireSettledPrincipal30d ?? 0n) !== next.wireSettledPrincipal30d ||
  (current?.wireSettledProviderEarnings30d ?? 0n) !== next.wireSettledProviderEarnings30d;
