import { prisma } from "@/lib/db";
import {
  computeDepthConfidence,
  computeX402Confidence,
  normalizeLog100,
} from "@/lib/ghostrank-rail-score";
import {
  getX402PerPayerAmountMultiplier,
  getX402PerPayerCountCap,
} from "@/lib/x402-reporting";
import { isRankEligibleX402Asset, isSupportedX402Scheme } from "@/lib/x402-interop";

type X402SettlementRow = {
  agentId: string | null;
  serviceSlug: string;
  payerIdentity: string;
  amountAtomic: bigint;
  success: boolean;
  relatedParty: boolean;
  countedForRank: boolean;
  scheme: string;
  asset: string;
  occurredAt: Date;
};

type AgentAccumulator = {
  relatedPartyFilteredCount30d: number;
  supportedObservedCount30d: number;
  supportedSuccessCount30d: number;
  qualifiedCount30d: number;
  uniqueCounterparties: Set<string>;
  repeatCounterpartyCounts: Map<string, number>;
  activeDays: Set<string>;
  grossVolume30d: bigint;
  netVolume30d: bigint;
  payerNetVolume: Map<string, bigint>;
};

export type X402AgentRollup = {
  agentId: string;
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
};

const DEFAULT_X402_FULL_CONFIDENCE_VOLUME_ATOMIC = 10_000_000n;
const MAX_PENALTY = 20;
const PENALTY_FREE_SHARE = 0.55;
const MAX_PENALTY_SHARE = 0.9;

const parsePositiveBigIntEnv = (raw: string | undefined, fallback: bigint): bigint => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : fallback;
};

const getX402FullConfidenceVolumeAtomic = (): bigint =>
  parsePositiveBigIntEnv(
    process.env.GHOST_X402_FULL_CONFIDENCE_VOLUME_ATOMIC,
    DEFAULT_X402_FULL_CONFIDENCE_VOLUME_ATOMIC,
  );

const usdcAtomicToFloat = (value: bigint): number => Number(value) / 1_000_000;

const toUtcDayKey = (value: Date): string => value.toISOString().slice(0, 10);

const getOrCreateAccumulator = (map: Map<string, AgentAccumulator>, agentId: string): AgentAccumulator => {
  const existing = map.get(agentId);
  if (existing) return existing;
  const created: AgentAccumulator = {
    relatedPartyFilteredCount30d: 0,
    supportedObservedCount30d: 0,
    supportedSuccessCount30d: 0,
    qualifiedCount30d: 0,
    uniqueCounterparties: new Set<string>(),
    repeatCounterpartyCounts: new Map<string, number>(),
    activeDays: new Set<string>(),
    grossVolume30d: 0n,
    netVolume30d: 0n,
    payerNetVolume: new Map<string, bigint>(),
  };
  map.set(agentId, created);
  return created;
};

const deriveConcentrationPenalty = (input: {
  uniqueCounterparties: number;
  totalNetVolume: bigint;
  payerNetVolume: Map<string, bigint>;
}): number => {
  if (input.uniqueCounterparties <= 1 || input.totalNetVolume <= 0n) {
    return input.uniqueCounterparties > 0 ? MAX_PENALTY : 0;
  }

  const maxPayerVolume = Array.from(input.payerNetVolume.values()).reduce(
    (maxValue, currentValue) => (currentValue > maxValue ? currentValue : maxValue),
    0n,
  );
  if (maxPayerVolume <= 0n) return 0;

  const share = Number(maxPayerVolume) / Number(input.totalNetVolume);
  if (!Number.isFinite(share) || share <= PENALTY_FREE_SHARE) return 0;
  if (share >= MAX_PENALTY_SHARE) return MAX_PENALTY;

  const ratio = (share - PENALTY_FREE_SHARE) / (MAX_PENALTY_SHARE - PENALTY_FREE_SHARE);
  return Math.round(Math.max(0, Math.min(MAX_PENALTY, ratio * MAX_PENALTY)) * 100) / 100;
};

const buildRollup = (input: {
  agentId: string;
  accumulator: AgentAccumulator;
  maxNetVolume30d: bigint;
}): X402AgentRollup => {
  const uniqueCounterparties = input.accumulator.uniqueCounterparties.size;
  const repeatCounterparties = Array.from(input.accumulator.repeatCounterpartyCounts.values()).filter(
    (count) => count > 1,
  ).length;
  const activeDays = input.accumulator.activeDays.size;
  const successRate =
    input.accumulator.supportedObservedCount30d > 0
      ? (input.accumulator.supportedSuccessCount30d / input.accumulator.supportedObservedCount30d) * 100
      : 0;
  const concentrationPenalty = deriveConcentrationPenalty({
    uniqueCounterparties,
    totalNetVolume: input.accumulator.netVolume30d,
    payerNetVolume: input.accumulator.payerNetVolume,
  });
  const x402Yield = usdcAtomicToFloat(input.accumulator.netVolume30d);
  const x402Confidence = computeX402Confidence({
    qualifiedCount30d: input.accumulator.qualifiedCount30d,
    uniqueCounterparties30d: uniqueCounterparties,
    repeatCounterparties30d: repeatCounterparties,
    activeDays30d: activeDays,
    netVolume30d: input.accumulator.netVolume30d,
    fullConfidenceVolumeAtomic: getX402FullConfidenceVolumeAtomic(),
  });

  return {
    agentId: input.agentId,
    x402Yield,
    x402Confidence,
    x402QualifiedCount30d: input.accumulator.qualifiedCount30d,
    x402UniqueCounterparties30d: uniqueCounterparties,
    x402RepeatCounterparties30d: repeatCounterparties,
    x402ActiveDays30d: activeDays,
    x402GrossVolume30d: input.accumulator.grossVolume30d,
    x402NetVolume30d: input.accumulator.netVolume30d,
    x402SuccessRate30d: Math.round(successRate * 100) / 100,
    x402ConcentrationPenalty: concentrationPenalty,
    x402RelatedPartyFilteredCount30d: input.accumulator.relatedPartyFilteredCount30d,
  };
};

export const fetchX402AgentRollups = async (since: Date): Promise<Map<string, X402AgentRollup>> => {
  const rows = await prisma.x402SettlementEvent.findMany({
    where: {
      occurredAt: { gte: since },
      agentId: { not: null },
    },
    select: {
      agentId: true,
      serviceSlug: true,
      payerIdentity: true,
      amountAtomic: true,
      success: true,
      relatedParty: true,
      countedForRank: true,
      scheme: true,
      asset: true,
      occurredAt: true,
    },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
  });

  const perPayerCountCap = getX402PerPayerCountCap();
  const perPayerAmountMultiplier = getX402PerPayerAmountMultiplier();
  const minAmountByService = new Map<string, bigint>();
  const accumulatorByAgent = new Map<string, AgentAccumulator>();

  for (const row of rows) {
    const agentId = row.agentId?.trim();
    if (!agentId) continue;
    const accumulator = getOrCreateAccumulator(accumulatorByAgent, agentId);

    if (row.relatedParty) {
      accumulator.relatedPartyFilteredCount30d += 1;
      continue;
    }

    if (!isSupportedX402Scheme(row.scheme) || !isRankEligibleX402Asset(row.asset)) {
      continue;
    }

    accumulator.supportedObservedCount30d += 1;
    if (!row.success) {
      continue;
    }

    accumulator.supportedSuccessCount30d += 1;
    if (!row.countedForRank) {
      continue;
    }

    const currentMinAmount = minAmountByService.get(row.serviceSlug);
    if (currentMinAmount == null || row.amountAtomic < currentMinAmount) {
      minAmountByService.set(row.serviceSlug, row.amountAtomic);
    }
  }

  const perPayerDayUsage = new Map<string, { countedRequests: number; countedAmount: bigint }>();

  for (const row of rows) {
    const agentId = row.agentId?.trim();
    if (!agentId || row.relatedParty || !row.success || !row.countedForRank) continue;
    if (!isSupportedX402Scheme(row.scheme) || !isRankEligibleX402Asset(row.asset)) continue;

    const unitAmount = minAmountByService.get(row.serviceSlug);
    if (!unitAmount || unitAmount <= 0n) continue;

    const accumulator = getOrCreateAccumulator(accumulatorByAgent, agentId);
    const dayKey = toUtcDayKey(row.occurredAt);
    const payerDayKey = `${row.serviceSlug}:${row.payerIdentity}:${dayKey}`;
    const existingUsage = perPayerDayUsage.get(payerDayKey) ?? { countedRequests: 0, countedAmount: 0n };
    if (existingUsage.countedRequests >= perPayerCountCap) continue;

    const amountCap = unitAmount * perPayerAmountMultiplier;
    const remainingAmount = amountCap - existingUsage.countedAmount;
    if (remainingAmount <= 0n) continue;

    const countedAmount = row.amountAtomic > remainingAmount ? remainingAmount : row.amountAtomic;
    if (countedAmount <= 0n) continue;

    existingUsage.countedRequests += 1;
    existingUsage.countedAmount += countedAmount;
    perPayerDayUsage.set(payerDayKey, existingUsage);

    accumulator.qualifiedCount30d += 1;
    accumulator.uniqueCounterparties.add(row.payerIdentity);
    accumulator.repeatCounterpartyCounts.set(
      row.payerIdentity,
      (accumulator.repeatCounterpartyCounts.get(row.payerIdentity) ?? 0) + 1,
    );
    accumulator.activeDays.add(dayKey);
    accumulator.grossVolume30d += row.amountAtomic;
    accumulator.netVolume30d += countedAmount;
    accumulator.payerNetVolume.set(
      row.payerIdentity,
      (accumulator.payerNetVolume.get(row.payerIdentity) ?? 0n) + countedAmount,
    );
  }

  const maxNetVolume30d = Array.from(accumulatorByAgent.values()).reduce(
    (maxValue, accumulator) => (accumulator.netVolume30d > maxValue ? accumulator.netVolume30d : maxValue),
    0n,
  );

  const rollups = new Map<string, X402AgentRollup>();
  for (const [agentId, accumulator] of accumulatorByAgent.entries()) {
    rollups.set(
      agentId,
      buildRollup({
        agentId,
        accumulator,
        maxNetVolume30d,
      }),
    );
  }

  return rollups;
};

export const deriveX402BreadthScore = (input: {
  uniqueCounterparties30d: number;
  activeDays30d: number;
}): number => {
  const uniqueScore = computeDepthConfidence(input.uniqueCounterparties30d, 8) * 100;
  const activeDayScore = computeDepthConfidence(input.activeDays30d, 7) * 100;
  return Math.round((uniqueScore * 0.6 + activeDayScore * 0.4) * 100) / 100;
};

export const deriveX402RepeatScore = (repeatCounterparties30d: number): number =>
  Math.round(computeDepthConfidence(repeatCounterparties30d, 6) * 100 * 100) / 100;

export const deriveX402YieldNorm = (input: {
  netVolume30d: bigint;
  maxNetVolume30d: bigint;
}): number => {
  if (input.netVolume30d <= 0n || input.maxNetVolume30d <= 0n) return 0;
  return normalizeLog100(Number(input.netVolume30d), Number(input.maxNetVolume30d));
};
