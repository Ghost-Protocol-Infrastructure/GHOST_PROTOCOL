import type { X402AgentRollup } from "@/lib/x402-score-rollup";
import type { GhostWireProviderRollup } from "@/lib/ghostwire-score-rollup";

export type ScoreV2RailMetricFields = {
  x402Yield: number;
  x402Confidence: number;
  x402QualifiedCount30d: number;
  x402UniqueCounterparties30d: number;
  x402RepeatCounterparties30d: number;
  x402ActiveDays30d: number;
  x402GrossVolume30d: bigint;
  x402NetVolume30d: bigint;
  x402SuccessRate30d: number;
  x402ConcentrationPenalty: number;
  x402RelatedPartyFilteredCount30d: number;
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
  wireRollup?: Pick<
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
  x402Rollup?: Pick<
    X402AgentRollup,
    | "x402Yield"
    | "x402Confidence"
    | "x402QualifiedCount30d"
    | "x402UniqueCounterparties30d"
    | "x402RepeatCounterparties30d"
    | "x402ActiveDays30d"
    | "x402GrossVolume30d"
    | "x402NetVolume30d"
    | "x402SuccessRate30d"
    | "x402ConcentrationPenalty"
    | "x402RelatedPartyFilteredCount30d"
  > | null,
): ScoreV2RailMetricFields => ({
  x402Yield: x402Rollup?.x402Yield ?? 0,
  x402Confidence: x402Rollup?.x402Confidence ?? 0,
  x402QualifiedCount30d: x402Rollup?.x402QualifiedCount30d ?? 0,
  x402UniqueCounterparties30d: x402Rollup?.x402UniqueCounterparties30d ?? 0,
  x402RepeatCounterparties30d: x402Rollup?.x402RepeatCounterparties30d ?? 0,
  x402ActiveDays30d: x402Rollup?.x402ActiveDays30d ?? 0,
  x402GrossVolume30d: x402Rollup?.x402GrossVolume30d ?? 0n,
  x402NetVolume30d: x402Rollup?.x402NetVolume30d ?? 0n,
  x402SuccessRate30d: x402Rollup?.x402SuccessRate30d ?? 0,
  x402ConcentrationPenalty: x402Rollup?.x402ConcentrationPenalty ?? 0,
  x402RelatedPartyFilteredCount30d: x402Rollup?.x402RelatedPartyFilteredCount30d ?? 0,
  wireYield: wireRollup?.wireYield ?? 0,
  commerceQuality: wireRollup?.commerceQuality ?? 0,
  wireConfidence: wireRollup?.wireConfidence ?? 0,
  wireCompletedCount30d: wireRollup?.completedCount ?? 0,
  wireRejectedCount30d: wireRollup?.rejectedCount ?? 0,
  wireExpiredCount30d: wireRollup?.expiredCount ?? 0,
  wireSettledPrincipal30d: wireRollup?.settledPrincipalAmount ?? 0n,
  wireSettledProviderEarnings30d: wireRollup?.settledProviderEarnings ?? 0n,
});

export const scoreV2RailMetricFieldsChanged = (
  current: Partial<ScoreV2RailMetricFields> | null | undefined,
  next: ScoreV2RailMetricFields,
): boolean =>
  (current?.x402Yield ?? 0) !== next.x402Yield ||
  (current?.x402Confidence ?? 0) !== next.x402Confidence ||
  (current?.x402QualifiedCount30d ?? 0) !== next.x402QualifiedCount30d ||
  (current?.x402UniqueCounterparties30d ?? 0) !== next.x402UniqueCounterparties30d ||
  (current?.x402RepeatCounterparties30d ?? 0) !== next.x402RepeatCounterparties30d ||
  (current?.x402ActiveDays30d ?? 0) !== next.x402ActiveDays30d ||
  (current?.x402GrossVolume30d ?? 0n) !== next.x402GrossVolume30d ||
  (current?.x402NetVolume30d ?? 0n) !== next.x402NetVolume30d ||
  (current?.x402SuccessRate30d ?? 0) !== next.x402SuccessRate30d ||
  (current?.x402ConcentrationPenalty ?? 0) !== next.x402ConcentrationPenalty ||
  (current?.x402RelatedPartyFilteredCount30d ?? 0) !== next.x402RelatedPartyFilteredCount30d ||
  (current?.wireYield ?? 0) !== next.wireYield ||
  (current?.commerceQuality ?? 0) !== next.commerceQuality ||
  (current?.wireConfidence ?? 0) !== next.wireConfidence ||
  (current?.wireCompletedCount30d ?? 0) !== next.wireCompletedCount30d ||
  (current?.wireRejectedCount30d ?? 0) !== next.wireRejectedCount30d ||
  (current?.wireExpiredCount30d ?? 0) !== next.wireExpiredCount30d ||
  (current?.wireSettledPrincipal30d ?? 0n) !== next.wireSettledPrincipal30d ||
  (current?.wireSettledProviderEarnings30d ?? 0n) !== next.wireSettledProviderEarnings30d;
