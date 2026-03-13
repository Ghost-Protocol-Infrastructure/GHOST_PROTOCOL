const clamp = (value: number, min = 0, max = 100): number => Math.min(max, Math.max(min, value));
const clampUnit = (value: number): number => clamp(value, 0, 1);
const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

export type RailReputationBlendInput = {
  expressReputation: number | null;
  expressConfidence: number;
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
  wire:
    | {
        commerceQuality: number;
        wireYieldNorm: number;
        confidence: number;
      }
    | null;
};

export type AgentRailModeValue = "EXPRESS" | "WIRE" | "HYBRID" | "UNPROVEN";

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

export const computeExpressReputation = (uptime: number, expressYieldNorm: number): number =>
  roundToTwo(clamp(clamp(uptime) * 0.65 + clamp(expressYieldNorm) * 0.35));

export const computeWireReputation = (commerceQuality: number, wireYieldNorm: number): number =>
  roundToTwo(clamp(clamp(commerceQuality) * 0.7 + clamp(wireYieldNorm) * 0.3));

export const blendRailReputation = (input: RailReputationBlendInput): number => {
  const expressWeight = input.expressReputation == null ? 0 : clampUnit(input.expressConfidence);
  const wireWeight = input.wireReputation == null ? 0 : clampUnit(input.wireConfidence);
  const totalWeight = expressWeight + wireWeight;
  if (totalWeight <= 0) return 0;

  return roundToTwo(
    ((input.expressReputation ?? 0) * expressWeight + (input.wireReputation ?? 0) * wireWeight) / totalWeight,
  );
};

export const computeRankScore = (input: {
  reputation: number;
  velocity: number;
  antiWashPenalty: number;
}): number => roundToTwo(clamp(clamp(input.reputation) * 0.7 + clamp(input.velocity) * 0.3 - input.antiWashPenalty));

export const resolveAgentRailMode = (input: {
  expressConfidence: number;
  wireConfidence: number;
}): AgentRailModeValue => {
  const hasExpress = input.expressConfidence > 0;
  const hasWire = input.wireConfidence > 0;
  if (hasExpress && hasWire) return "HYBRID";
  if (hasExpress) return "EXPRESS";
  if (hasWire) return "WIRE";
  return "UNPROVEN";
};

export const scoreAgentRailAware = (input: RailAwareScoreInput): {
  expressReputation: number | null;
  wireReputation: number | null;
  reputation: number;
  rankScore: number;
  railMode: AgentRailModeValue;
} => {
  const expressReputation = input.express
    ? computeExpressReputation(input.express.uptime, input.express.expressYieldNorm)
    : null;
  const wireReputation = input.wire
    ? computeWireReputation(input.wire.commerceQuality, input.wire.wireYieldNorm)
    : null;
  const reputation = blendRailReputation({
    expressReputation,
    expressConfidence: input.express?.confidence ?? 0,
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
    wireConfidence: input.wire?.confidence ?? 0,
  });

  return {
    expressReputation,
    wireReputation,
    reputation,
    rankScore,
    railMode,
  };
};
