const clamp = (value: number, min = 0, max = 100): number => Math.min(max, Math.max(min, value));
const clampUnit = (value: number): number => clamp(value, 0, 1);
const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

export type RailReputationBlendInput = {
  expressReputation: number | null;
  expressConfidence: number;
  x402Reputation: number | null;
  x402Confidence: number;
  wireReputation: number | null;
  wireConfidence: number;
};

export type RailAwareScoreInput = {
  velocity: number;
  antiWashPenalty: number;
  express:
    | {
        uptime: number;
        expressYieldNorm: number;
        confidence: number;
      }
    | null;
  x402:
    | {
        breadthScore: number;
        repeatScore: number;
        x402YieldNorm: number;
        successRate: number;
        uptime: number;
        concentrationPenalty: number;
        confidence: number;
      }
    | null;
  wire:
    | {
        commerceQuality: number;
        wireYieldNorm: number;
        confidence: number;
      }
    | null;
};

export type AgentRailModeValue = "X402" | "EXPRESS" | "WIRE" | "HYBRID" | "UNPROVEN";

export const normalizeLog100 = (value: number, maxValue: number): number => {
  if (maxValue <= 0) return 0;
  const numerator = Math.log10(Math.max(0, value) + 1);
  const denominator = Math.log10(maxValue + 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return clamp(roundToTwo((numerator / denominator) * 100));
};

export const computeCommerceQuality = (input: {
  completedCount: number;
  rejectedCount: number;
  expiredCount: number;
  volumeConfidence: number;
  depthConfidence: number;
}): number => {
  const terminalJobs = input.completedCount + input.rejectedCount + input.expiredCount;
  if (terminalJobs <= 0) return 0;

  const outcomeScore =
    (input.completedCount * 1 + input.rejectedCount * 0.1 + input.expiredCount * 0) / terminalJobs;
  const valueFactor = 0.8 + 0.2 * clampUnit(input.volumeConfidence);
  const depthFactor = clampUnit(input.depthConfidence);

  return roundToTwo(clamp(outcomeScore * valueFactor * depthFactor * 100));
};

export const computeDepthConfidence = (sampleCount: number, fullConfidenceAt = 10): number => {
  if (fullConfidenceAt <= 0) return 1;
  return roundToTwo(clampUnit(sampleCount / fullConfidenceAt));
};

export const computeExpressConfidence = (input: {
  usageAuthorizedCount7d: number;
  uptime: number;
  expressYield: number;
}): number => {
  const usageConfidence = computeDepthConfidence(input.usageAuthorizedCount7d, 20);
  const coverageConfidence = clampUnit(
    (input.uptime > 0 ? 0.45 : 0) + (input.expressYield > 0 ? 0.35 : 0) + (input.usageAuthorizedCount7d > 0 ? 0.2 : 0),
  );
  return roundToTwo(Math.max(usageConfidence, coverageConfidence));
};

export const computeWireConfidence = (input: {
  terminalJobs: number;
  settledPrincipal: number;
  settledProviderEarnings: number;
}): number => {
  const depthConfidence = computeDepthConfidence(input.terminalJobs, 10);
  const coverageConfidence = clampUnit(
    (input.terminalJobs > 0 ? 0.45 : 0) +
      (input.settledPrincipal > 0 ? 0.2 : 0) +
      (input.settledProviderEarnings > 0 ? 0.35 : 0),
  );
  return roundToTwo(Math.max(depthConfidence, coverageConfidence));
};

const bigintRatio = (value: bigint, maxValue: bigint): number => {
  if (value <= 0n || maxValue <= 0n) return 0;
  if (value >= maxValue) return 1;
  return Number(value) / Number(maxValue);
};

export const computeX402Confidence = (input: {
  qualifiedCount30d: number;
  uniqueCounterparties30d: number;
  repeatCounterparties30d: number;
  activeDays30d: number;
  netVolume30d: bigint;
  fullConfidenceVolumeAtomic: bigint;
}): number => {
  const requestDepth = computeDepthConfidence(input.qualifiedCount30d, 20);
  const uniqueDepth = computeDepthConfidence(input.uniqueCounterparties30d, 8);
  const repeatDepth = computeDepthConfidence(input.repeatCounterparties30d, 6);
  const activeDayDepth = computeDepthConfidence(input.activeDays30d, 7);
  const volumeDepth = clampUnit(bigintRatio(input.netVolume30d, input.fullConfidenceVolumeAtomic));

  return roundToTwo(
    clampUnit(
      requestDepth * 0.2 +
        uniqueDepth * 0.3 +
        repeatDepth * 0.2 +
        activeDayDepth * 0.2 +
        volumeDepth * 0.1,
    ),
  );
};

export const computeExpressReputation = (uptime: number, expressYieldNorm: number): number =>
  roundToTwo(clamp(clamp(uptime) * 0.65 + clamp(expressYieldNorm) * 0.35));

export const computeX402Reputation = (input: {
  breadthScore: number;
  repeatScore: number;
  x402YieldNorm: number;
  successRate: number;
  uptime: number;
  concentrationPenalty: number;
}): number =>
  roundToTwo(
    clamp(
      clamp(input.breadthScore) * 0.3 +
        clamp(input.repeatScore) * 0.25 +
        clamp(input.x402YieldNorm) * 0.2 +
        clamp(input.successRate) * 0.15 +
        clamp(input.uptime) * 0.1 -
        Math.max(0, input.concentrationPenalty),
    ),
  );

export const computeWireReputation = (commerceQuality: number, wireYieldNorm: number): number =>
  roundToTwo(clamp(clamp(commerceQuality) * 0.7 + clamp(wireYieldNorm) * 0.3));

export const blendRailReputation = (input: RailReputationBlendInput): number => {
  const expressWeight = input.expressReputation == null ? 0 : clampUnit(input.expressConfidence);
  const x402Weight = input.x402Reputation == null ? 0 : clampUnit(input.x402Confidence);
  const wireWeight = input.wireReputation == null ? 0 : clampUnit(input.wireConfidence);
  const totalWeight = expressWeight + x402Weight + wireWeight;
  if (totalWeight <= 0) return 0;

  return roundToTwo(
    ((input.expressReputation ?? 0) * expressWeight +
      (input.x402Reputation ?? 0) * x402Weight +
      (input.wireReputation ?? 0) * wireWeight) /
      totalWeight,
  );
};

export const computeRankScore = (input: {
  reputation: number;
  velocity: number;
  antiWashPenalty: number;
}): number => roundToTwo(clamp(clamp(input.reputation) * 0.7 + clamp(input.velocity) * 0.3 - input.antiWashPenalty));

export const resolveAgentRailMode = (input: {
  expressConfidence: number;
  x402Confidence: number;
  wireConfidence: number;
}): AgentRailModeValue => {
  const hasExpress = input.expressConfidence > 0;
  const hasX402 = input.x402Confidence > 0;
  const hasWire = input.wireConfidence > 0;
  const activeRailCount = [hasExpress, hasX402, hasWire].filter(Boolean).length;
  if (activeRailCount >= 2) return "HYBRID";
  if (hasX402) return "X402";
  if (hasExpress) return "EXPRESS";
  if (hasWire) return "WIRE";
  return "UNPROVEN";
};

export const scoreAgentRailAware = (input: RailAwareScoreInput): {
  expressReputation: number | null;
  x402Reputation: number | null;
  wireReputation: number | null;
  reputation: number;
  rankScore: number;
  railMode: AgentRailModeValue;
} => {
  const expressReputation = input.express
    ? computeExpressReputation(input.express.uptime, input.express.expressYieldNorm)
    : null;
  const x402Reputation = input.x402
    ? computeX402Reputation({
        breadthScore: input.x402.breadthScore,
        repeatScore: input.x402.repeatScore,
        x402YieldNorm: input.x402.x402YieldNorm,
        successRate: input.x402.successRate,
        uptime: input.x402.uptime,
        concentrationPenalty: input.x402.concentrationPenalty,
      })
    : null;
  const wireReputation = input.wire
    ? computeWireReputation(input.wire.commerceQuality, input.wire.wireYieldNorm)
    : null;
  const reputation = blendRailReputation({
    expressReputation,
    expressConfidence: input.express?.confidence ?? 0,
    x402Reputation,
    x402Confidence: input.x402?.confidence ?? 0,
    wireReputation,
    wireConfidence: input.wire?.confidence ?? 0,
  });
  const rankScore = computeRankScore({
    reputation,
    velocity: input.velocity,
    antiWashPenalty: input.antiWashPenalty,
  });
  const railMode = resolveAgentRailMode({
    expressConfidence: input.express?.confidence ?? 0,
    x402Confidence: input.x402?.confidence ?? 0,
    wireConfidence: input.wire?.confidence ?? 0,
  });

  return {
    expressReputation,
    x402Reputation,
    wireReputation,
    reputation,
    rankScore,
    railMode,
  };
};
