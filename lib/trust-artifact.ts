import type {
  Agent,
  AgentRailMode,
  AgentTier,
  CanonicalAddressSource,
  LeaderboardSnapshot,
  LeaderboardSnapshotRow,
  TrustEvidenceClass,
  TxMetricSource,
} from "@prisma/client";
import {
  hasAttributedExpressEvidence,
  hasAttributedWireEvidence,
  hasAttributedX402Evidence,
  isClaimedAgent,
} from "@/lib/agent-claim";
import { isFallbackTxMetricSource } from "@/lib/score-v2-fallback-signal";

export const PORTABLE_TRUST_SCHEMA_VERSION = "ghost-trust/v1" as const;
export const PORTABLE_TRUST_ISSUER_NAME = "Ghost Protocol" as const;
export const PORTABLE_TRUST_HASH_ALGORITHM = "keccak256" as const;
export const PORTABLE_TRUST_SIGNATURE_SCHEME = "eip191" as const;

type PortableTrustMeasuredRail = "EXPRESS" | "X402" | "WIRE";
type PortableTrustObservedSource =
  | "GHOST_EXPRESS_MEASURED"
  | "GHOST_X402_SIGNED_SETTLEMENT"
  | "GHOSTWIRE_TERMINAL_JOB";
type PortableTrustFallbackSource = "OWNER_WALLET_ACTIVITY" | "CREATOR_WALLET_ACTIVITY" | "AGENT_ONCHAIN_ACTIVITY";
type PortableTrustMetricSource =
  | "AGENT_ONCHAIN"
  | "USAGE_ACTIVITY"
  | "OWNER_FALLBACK"
  | "CREATOR_FALLBACK"
  | "UNRESOLVED";

export type PortableTrustSnapshotRow = Pick<
  LeaderboardSnapshotRow,
  | "agentAddress"
  | "agentId"
  | "name"
  | "creator"
  | "owner"
  | "status"
  | "tier"
  | "metricSource"
  | "canonicalOnchainAddress"
  | "canonicalAddressSource"
  | "rankScore"
  | "reputation"
  | "yield"
  | "uptime"
  | "railMode"
  | "usageAuthorizedCount7d"
  | "expressYield"
  | "x402Yield"
  | "wireYield"
  | "expressConfidence"
  | "x402Confidence"
  | "wireConfidence"
  | "expressReputation"
  | "x402Reputation"
  | "wireReputation"
  | "commerceQuality"
  | "x402QualifiedCount30d"
  | "x402UniqueCounterparties30d"
  | "x402RepeatCounterparties30d"
  | "x402ActiveDays30d"
  | "x402GrossVolume30d"
  | "x402NetVolume30d"
  | "x402SuccessRate30d"
  | "x402ConcentrationPenalty"
  | "x402RelatedPartyFilteredCount30d"
  | "onchainTxCountAgent"
  | "onchainTxCountOwner"
>;

export type PortableTrustSnapshot = Pick<LeaderboardSnapshot, "id" | "mode" | "txSource" | "completedAt">;

export type PortableTrustAgent = Pick<Agent, "address" | "agentId" | "name" | "creator" | "owner">;

export type PortableTrustPayload = {
  schemaVersion: typeof PORTABLE_TRUST_SCHEMA_VERSION;
  issuedAt: string;
  issuer: {
    name: typeof PORTABLE_TRUST_ISSUER_NAME;
    address: string;
    signatureScheme: typeof PORTABLE_TRUST_SIGNATURE_SCHEME;
    hashAlgorithm: typeof PORTABLE_TRUST_HASH_ALGORITHM;
  };
  agent: {
    address: string;
    agentId: string;
    name: string;
    owner: string;
    creator: string;
    claimed: boolean;
    canonicalOnchainAddress: string | null;
    canonicalAddressSource: CanonicalAddressSource;
  };
  snapshot: {
    id: string;
    mode: "score-v2";
    completedAt: string | null;
  };
  trust: {
    tier: AgentTier;
    railMode: AgentRailMode;
    metricSource: PortableTrustMetricSource;
    evidenceClass: TrustEvidenceClass;
    rankScore: number;
    reputation: number;
    yield: number;
    uptime: number;
  };
  summary: {
    measuredRails: PortableTrustMeasuredRail[];
    fallbackUsed: boolean;
    notes: string[];
  };
  provenance: {
    observedSources: PortableTrustObservedSource[];
    fallbackSources: PortableTrustFallbackSource[];
    notes: string[];
  };
  details?: {
    rails: {
      express?: {
        confidence: number;
        yield: number;
        reputation: number | null;
        usageAuthorizedCount7d: number;
      };
      x402?: {
        confidence: number;
        yield: number;
        reputation: number | null;
        qualifiedCount30d: number;
        uniqueCounterparties30d: number;
        repeatCounterparties30d: number;
        activeDays30d: number;
        grossVolume30d: string;
        netVolume30d: string;
        successRate30d: number;
        concentrationPenalty: number;
        relatedPartyFilteredCount30d: number;
      };
      wire?: {
        confidence: number;
        yield: number;
        reputation: number | null;
        commerceQuality: number;
      };
      fallback?: {
        metricSource: PortableTrustMetricSource;
        onchainTxCountAgent: number | null;
        onchainTxCountOwner: number;
      };
    };
  };
};

export type PortableTrustVerification = {
  artifactHash: `0x${string}`;
  signature: `0x${string}`;
};

export type PortableTrustArtifactResponse = PortableTrustPayload & {
  verification: PortableTrustVerification;
};

const hasPositiveMetric = (value: number | null | undefined): boolean =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const hasPositiveCount = (value: number | null | undefined): boolean =>
  typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;

const hasPositiveBigInt = (value: bigint | null | undefined): boolean => typeof value === "bigint" && value > 0n;

const normalizeMetricSource = (metricSource: TxMetricSource): PortableTrustMetricSource => {
  if (metricSource === "USAGE_ACTIVITY_7D") return "USAGE_ACTIVITY";
  return metricSource;
};

const getMeasuredRails = (row: PortableTrustSnapshotRow): PortableTrustMeasuredRail[] => {
  const measuredRails: PortableTrustMeasuredRail[] = [];
  if (
    hasAttributedExpressEvidence({
      expressYieldValue: row.expressYield,
      usageAuthorizedCount7dValue: row.usageAuthorizedCount7d,
    })
  ) {
    measuredRails.push("EXPRESS");
  }
  if (
    hasAttributedX402Evidence({
      x402YieldValue: row.x402Yield,
      x402QualifiedCount: row.x402QualifiedCount30d,
      x402UniqueCounterpartiesCount: row.x402UniqueCounterparties30d,
      x402NetVolumeValue: row.x402NetVolume30d,
    })
  ) {
    measuredRails.push("X402");
  }
  if (
    hasAttributedWireEvidence({
      wireYieldValue: row.wireYield,
    })
  ) {
    measuredRails.push("WIRE");
  }
  return measuredRails;
};

const getObservedSources = (measuredRails: PortableTrustMeasuredRail[]): PortableTrustObservedSource[] =>
  measuredRails.map((rail) => {
    if (rail === "EXPRESS") return "GHOST_EXPRESS_MEASURED";
    if (rail === "X402") return "GHOST_X402_SIGNED_SETTLEMENT";
    return "GHOSTWIRE_TERMINAL_JOB";
  });

const getFallbackSources = (
  row: Pick<PortableTrustSnapshotRow, "metricSource">,
  measuredRails: PortableTrustMeasuredRail[],
): PortableTrustFallbackSource[] => {
  if (row.metricSource === "OWNER_FALLBACK") return ["OWNER_WALLET_ACTIVITY"];
  if (row.metricSource === "CREATOR_FALLBACK") return ["CREATOR_WALLET_ACTIVITY"];
  if (row.metricSource === "AGENT_ONCHAIN" && measuredRails.length === 0) return ["AGENT_ONCHAIN_ACTIVITY"];
  return [];
};

export const deriveTrustEvidenceClass = (row: PortableTrustSnapshotRow): TrustEvidenceClass => {
  const measuredRails = getMeasuredRails(row);
  if (measuredRails.length > 0) {
    return isFallbackTxMetricSource(row.metricSource) ? "MIXED" : "MEASURED";
  }
  if (isFallbackTxMetricSource(row.metricSource)) return "FALLBACK_ONLY";
  return "UNPROVEN";
};

const buildSummaryNotes = (
  evidenceClass: TrustEvidenceClass,
  fallbackSources: PortableTrustFallbackSource[],
): string[] => {
  const notes: string[] = [];
  if (fallbackSources.length > 0) {
    notes.push("Fallback wallet activity is a discovery aid, not full-strength proof of agent quality.");
  }
  if (evidenceClass === "UNPROVEN") {
    notes.push("Ghost has not observed meaningful measured commercial evidence for this agent in the active snapshot.");
  }
  if (evidenceClass === "MEASURED") {
    notes.push("Ghost has observed measured commercial activity on one or more supported rails.");
  }
  return notes;
};

const buildProvenanceNotes = (measuredRails: PortableTrustMeasuredRail[]): string[] => {
  const notes = ["Ghost trust artifacts are issued from the active GhostRank snapshot."];
  if (measuredRails.length === 0) {
    notes.push("Missing non-applicable rails are omitted from details instead of represented as zero evidence.");
  }
  return notes;
};

const shouldIncludeExpressDetails = (row: PortableTrustSnapshotRow): boolean =>
  hasPositiveMetric(row.expressConfidence) ||
  hasPositiveMetric(row.expressYield) ||
  hasPositiveCount(row.usageAuthorizedCount7d) ||
  row.expressReputation != null;

const shouldIncludeX402Details = (row: PortableTrustSnapshotRow): boolean =>
  hasPositiveMetric(row.x402Confidence) ||
  hasPositiveMetric(row.x402Yield) ||
  row.x402Reputation != null ||
  hasPositiveCount(row.x402QualifiedCount30d) ||
  hasPositiveCount(row.x402UniqueCounterparties30d) ||
  hasPositiveCount(row.x402RepeatCounterparties30d) ||
  hasPositiveCount(row.x402ActiveDays30d) ||
  hasPositiveBigInt(row.x402GrossVolume30d) ||
  hasPositiveBigInt(row.x402NetVolume30d);

const shouldIncludeWireDetails = (row: PortableTrustSnapshotRow): boolean =>
  hasPositiveMetric(row.wireConfidence) ||
  hasPositiveMetric(row.wireYield) ||
  row.wireReputation != null ||
  hasPositiveMetric(row.commerceQuality);

const shouldIncludeFallbackDetails = (row: PortableTrustSnapshotRow): boolean =>
  row.metricSource === "OWNER_FALLBACK" ||
  row.metricSource === "CREATOR_FALLBACK" ||
  (row.metricSource === "AGENT_ONCHAIN" &&
    ((typeof row.onchainTxCountAgent === "number" && row.onchainTxCountAgent > 0) || row.onchainTxCountOwner > 0));

export const buildPortableTrustPayload = (input: {
  row: PortableTrustSnapshotRow;
  snapshot: PortableTrustSnapshot;
  agent: PortableTrustAgent;
  issuerAddress: string;
  issuedAt?: Date;
}): PortableTrustPayload => {
  const issuedAt = (input.issuedAt ?? new Date()).toISOString();
  const measuredRails = getMeasuredRails(input.row);
  const evidenceClass = deriveTrustEvidenceClass(input.row);
  const observedSources = getObservedSources(measuredRails);
  const fallbackSources = getFallbackSources(input.row, measuredRails);
  const fallbackUsed = fallbackSources.length > 0;
  const claimed = isClaimedAgent({
    status: input.row.status,
    tier: input.row.tier,
    yieldValue: input.row.yield,
    uptimeValue: input.row.uptime,
    usageAuthorizedCount7dValue: input.row.usageAuthorizedCount7d,
    x402YieldValue: input.row.x402Yield,
    x402QualifiedCount: input.row.x402QualifiedCount30d,
    x402UniqueCounterpartiesCount: input.row.x402UniqueCounterparties30d,
    x402NetVolumeValue: input.row.x402NetVolume30d,
    wireYieldValue: input.row.wireYield,
  });

  const payload: PortableTrustPayload = {
    schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
    issuedAt,
    issuer: {
      name: PORTABLE_TRUST_ISSUER_NAME,
      address: input.issuerAddress,
      signatureScheme: PORTABLE_TRUST_SIGNATURE_SCHEME,
      hashAlgorithm: PORTABLE_TRUST_HASH_ALGORITHM,
    },
    agent: {
      address: input.agent.address,
      agentId: input.row.agentId,
      name: input.row.name,
      owner: input.row.owner,
      creator: input.row.creator,
      claimed,
      canonicalOnchainAddress: input.row.canonicalOnchainAddress,
      canonicalAddressSource: input.row.canonicalAddressSource,
    },
    snapshot: {
      id: input.snapshot.id,
      mode: "score-v2",
      completedAt: input.snapshot.completedAt?.toISOString() ?? null,
    },
    trust: {
      tier: input.row.tier,
      railMode: input.row.railMode,
      metricSource: normalizeMetricSource(input.row.metricSource),
      evidenceClass,
      rankScore: input.row.rankScore,
      reputation: input.row.reputation,
      yield: input.row.yield,
      uptime: input.row.uptime,
    },
    summary: {
      measuredRails,
      fallbackUsed,
      notes: buildSummaryNotes(evidenceClass, fallbackSources),
    },
    provenance: {
      observedSources,
      fallbackSources,
      notes: buildProvenanceNotes(measuredRails),
    },
  };

  const rails: NonNullable<PortableTrustPayload["details"]>["rails"] = {};

  if (shouldIncludeExpressDetails(input.row)) {
    rails.express = {
      confidence: input.row.expressConfidence,
      yield: input.row.expressYield,
      reputation: input.row.expressReputation ?? null,
      usageAuthorizedCount7d: input.row.usageAuthorizedCount7d,
    };
  }

  if (shouldIncludeX402Details(input.row)) {
    rails.x402 = {
      confidence: input.row.x402Confidence,
      yield: input.row.x402Yield,
      reputation: input.row.x402Reputation ?? null,
      qualifiedCount30d: input.row.x402QualifiedCount30d,
      uniqueCounterparties30d: input.row.x402UniqueCounterparties30d,
      repeatCounterparties30d: input.row.x402RepeatCounterparties30d,
      activeDays30d: input.row.x402ActiveDays30d,
      grossVolume30d: input.row.x402GrossVolume30d.toString(),
      netVolume30d: input.row.x402NetVolume30d.toString(),
      successRate30d: input.row.x402SuccessRate30d,
      concentrationPenalty: input.row.x402ConcentrationPenalty,
      relatedPartyFilteredCount30d: input.row.x402RelatedPartyFilteredCount30d,
    };
  }

  if (shouldIncludeWireDetails(input.row)) {
    rails.wire = {
      confidence: input.row.wireConfidence,
      yield: input.row.wireYield,
      reputation: input.row.wireReputation ?? null,
      commerceQuality: input.row.commerceQuality,
    };
  }

  if (shouldIncludeFallbackDetails(input.row)) {
    rails.fallback = {
      metricSource: normalizeMetricSource(input.row.metricSource),
      onchainTxCountAgent: input.row.onchainTxCountAgent ?? null,
      onchainTxCountOwner: input.row.onchainTxCountOwner,
    };
  }

  if (Object.keys(rails).length > 0) {
    payload.details = { rails };
  }

  return payload;
};

export const buildPortableTrustArtifactResponse = (
  payload: PortableTrustPayload,
  verification: PortableTrustVerification,
): PortableTrustArtifactResponse => ({
  ...payload,
  verification,
});
