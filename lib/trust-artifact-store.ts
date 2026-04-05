import { Prisma, type TrustEvidenceClass } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  buildPortableTrustArtifactResponse,
  buildPortableTrustPayload,
  PORTABLE_TRUST_SCHEMA_VERSION,
  type PortableTrustAgent,
  type PortableTrustArtifactResponse,
  type PortableTrustPayload,
  type PortableTrustSnapshot,
  type PortableTrustSnapshotRow,
} from "@/lib/trust-artifact";
import {
  isPortableTrustEnabled,
  normalizePortableTrustPayload,
  resolvePortableTrustIssuerConfig,
  signPortableTrustPayload,
} from "@/lib/trust-signing";

type PortableTrustSnapshotRowWithAgent = PortableTrustSnapshotRow & {
  agent: PortableTrustAgent;
};

type PortableTrustMaterializationDb = {
  leaderboardSnapshot: {
    findFirst: (args: Prisma.LeaderboardSnapshotFindFirstArgs) => Promise<PortableTrustSnapshot | null>;
    findUnique: (args: Prisma.LeaderboardSnapshotFindUniqueArgs) => Promise<PortableTrustSnapshot | null>;
  };
  leaderboardSnapshotRow: {
    findMany: (args: Prisma.LeaderboardSnapshotRowFindManyArgs) => Promise<PortableTrustSnapshotRowWithAgent[]>;
  };
  agentTrustArtifact: {
    updateMany: (args: Prisma.AgentTrustArtifactUpdateManyArgs) => Promise<{ count: number }>;
    upsert: (args: Prisma.AgentTrustArtifactUpsertArgs) => Promise<unknown>;
    findFirst: (args: Prisma.AgentTrustArtifactFindFirstArgs) => Promise<{
      agentId: string;
      evidenceClass: TrustEvidenceClass;
      issuedAt: Date;
      artifactHash: string;
      signature: string;
      payload: Prisma.JsonValue;
      schemaVersion: string;
      issuerAddress: string;
      hashAlgorithm: string;
      signatureScheme: string;
    } | null>;
    findMany: (args: Prisma.AgentTrustArtifactFindManyArgs) => Promise<
      Array<{
        agentId: string;
        evidenceClass: TrustEvidenceClass;
        issuedAt: Date;
        artifactHash: string;
        schemaVersion: string;
      }>
    >;
  };
};

export type PortableTrustMaterializationResult = {
  snapshotId: string;
  processed: number;
  upserted: number;
  deactivated: number;
  skipped: boolean;
};

const PORTABLE_TRUST_ROW_SELECT = {
  agentAddress: true,
  agentId: true,
  name: true,
  creator: true,
  owner: true,
  status: true,
  tier: true,
  metricSource: true,
  canonicalOnchainAddress: true,
  canonicalAddressSource: true,
  rankScore: true,
  reputation: true,
  yield: true,
  uptime: true,
  railMode: true,
  usageAuthorizedCount7d: true,
  expressYield: true,
  x402Yield: true,
  wireYield: true,
  expressConfidence: true,
  x402Confidence: true,
  wireConfidence: true,
  expressReputation: true,
  x402Reputation: true,
  wireReputation: true,
  commerceQuality: true,
  x402QualifiedCount30d: true,
  x402UniqueCounterparties30d: true,
  x402RepeatCounterparties30d: true,
  x402ActiveDays30d: true,
  x402GrossVolume30d: true,
  x402NetVolume30d: true,
  x402SuccessRate30d: true,
  x402ConcentrationPenalty: true,
  x402RelatedPartyFilteredCount30d: true,
  onchainTxCountAgent: true,
  onchainTxCountOwner: true,
  agent: {
    select: {
      address: true,
      agentId: true,
      name: true,
      creator: true,
      owner: true,
    },
  },
} satisfies Prisma.LeaderboardSnapshotRowSelect;

const ACTIVE_TRUST_ARTIFACT_SELECT = {
  agentId: true,
  evidenceClass: true,
  issuedAt: true,
  artifactHash: true,
  signature: true,
  payload: true,
  schemaVersion: true,
  issuerAddress: true,
  hashAlgorithm: true,
  signatureScheme: true,
} satisfies Prisma.AgentTrustArtifactSelect;

const TRUST_POINTER_SELECT = {
  agentId: true,
  evidenceClass: true,
  issuedAt: true,
  artifactHash: true,
  schemaVersion: true,
} satisfies Prisma.AgentTrustArtifactSelect;

const assertPortableTrustPayload = (value: Prisma.JsonValue): PortableTrustPayload => value as PortableTrustPayload;

const buildTrustUrl = (agentId: string): string => `/api/agents/${encodeURIComponent(agentId)}/trust`;
const PORTABLE_TRUST_UPSERT_BATCH_SIZE = 200;
const PORTABLE_TRUST_DEACTIVATION_BATCH_SIZE = 5000;

const chunk = <TItem>(items: TItem[], size: number): TItem[][] => {
  if (size <= 0) return [items];
  const batches: TItem[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const isMissingTrustArtifactTableError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021";

export const materializePortableTrustArtifactsForSnapshot = async (
  input: {
    snapshotId: string;
    db?: PortableTrustMaterializationDb;
  },
): Promise<PortableTrustMaterializationResult> => {
  if (!isPortableTrustEnabled()) {
    return {
      snapshotId: input.snapshotId,
      processed: 0,
      upserted: 0,
      deactivated: 0,
      skipped: true,
    };
  }

  const db = input.db ?? (prisma as unknown as PortableTrustMaterializationDb);
  const issuerConfig = resolvePortableTrustIssuerConfig();
  const snapshot = await db.leaderboardSnapshot.findUnique({
    where: { id: input.snapshotId },
    select: {
      id: true,
      mode: true,
      txSource: true,
      completedAt: true,
    },
  });

  if (!snapshot) {
    throw new Error(`Portable trust snapshot ${input.snapshotId} not found.`);
  }

  const issuedAt = snapshot.completedAt ?? new Date();
  const rows = await db.leaderboardSnapshotRow.findMany({
    where: { snapshotId: snapshot.id },
    select: PORTABLE_TRUST_ROW_SELECT,
  });

  const agentAddresses = Array.from(new Set(rows.map((row) => row.agentAddress)));

  let deactivated = 0;
  for (const addressBatch of chunk(agentAddresses, PORTABLE_TRUST_DEACTIVATION_BATCH_SIZE)) {
    if (addressBatch.length === 0) continue;
    const deactivatedResult = await db.agentTrustArtifact.updateMany({
      where: {
        agentAddress: { in: addressBatch },
        schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
        isActive: true,
        snapshotId: { not: snapshot.id },
      },
      data: {
        isActive: false,
      },
    });
    deactivated += deactivatedResult.count;
  }

  let upserted = 0;
  for (const batch of chunk(rows, PORTABLE_TRUST_UPSERT_BATCH_SIZE)) {
    await Promise.all(
      batch.map(async (row) => {
        const payload = normalizePortableTrustPayload(
          buildPortableTrustPayload({
            row,
            snapshot,
            agent: row.agent,
            issuerAddress: issuerConfig.issuerAddress,
            issuedAt,
          }),
        );
        const verification = await signPortableTrustPayload({
          payload,
          privateKey: issuerConfig.privateKey,
        });

        await db.agentTrustArtifact.upsert({
          where: {
            snapshotId_agentAddress_schemaVersion: {
              snapshotId: snapshot.id,
              agentAddress: row.agentAddress,
              schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
            },
          },
          update: {
            agentId: row.agentId,
            evidenceClass: payload.trust.evidenceClass,
            artifactHash: verification.artifactHash,
            hashAlgorithm: payload.issuer.hashAlgorithm,
            signatureScheme: payload.issuer.signatureScheme,
            issuerAddress: payload.issuer.address,
            issuedAt,
            payload: payload as unknown as Prisma.InputJsonValue,
            signature: verification.signature,
            isActive: true,
          },
          create: {
            agentAddress: row.agentAddress,
            agentId: row.agentId,
            snapshotId: snapshot.id,
            schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
            evidenceClass: payload.trust.evidenceClass,
            artifactHash: verification.artifactHash,
            hashAlgorithm: payload.issuer.hashAlgorithm,
            signatureScheme: payload.issuer.signatureScheme,
            issuerAddress: payload.issuer.address,
            issuedAt,
            payload: payload as unknown as Prisma.InputJsonValue,
            signature: verification.signature,
            isActive: true,
          },
        });
      }),
    );

    upserted += batch.length;
  }

  return {
    snapshotId: snapshot.id,
    processed: rows.length,
    upserted,
    deactivated,
    skipped: false,
  };
};

export const backfillPortableTrustForActiveSnapshot = async (
  db: PortableTrustMaterializationDb = prisma as unknown as PortableTrustMaterializationDb,
): Promise<PortableTrustMaterializationResult | null> => {
  if (!isPortableTrustEnabled()) return null;

  const activeSnapshot = await db.leaderboardSnapshot.findFirst({
    where: {
      isActive: true,
      status: "READY",
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      mode: true,
      txSource: true,
      completedAt: true,
    },
  });

  if (!activeSnapshot) return null;

  return materializePortableTrustArtifactsForSnapshot({
    snapshotId: activeSnapshot.id,
    db,
  });
};

export const loadActivePortableTrustArtifactByAgentId = async (
  agentId: string,
  db: PortableTrustMaterializationDb = prisma as unknown as PortableTrustMaterializationDb,
): Promise<PortableTrustArtifactResponse | null> => {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;

  const row = await db.agentTrustArtifact.findFirst({
    where: {
      agentId: normalizedAgentId,
      schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
      isActive: true,
      snapshot: {
        isActive: true,
        status: "READY",
      },
    },
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
    select: ACTIVE_TRUST_ARTIFACT_SELECT,
  }).catch((error) => {
    if (isMissingTrustArtifactTableError(error)) return null;
    throw error;
  });

  if (!row) return null;

  return buildPortableTrustArtifactResponse(assertPortableTrustPayload(row.payload), {
    artifactHash: row.artifactHash as `0x${string}`,
    signature: row.signature as `0x${string}`,
  });
};

export type PortableTrustPointer = {
  available: boolean;
  evidenceClass: TrustEvidenceClass | null;
  issuedAt: string | null;
  trustUrl: string | null;
};

export const listActivePortableTrustPointersByAgentId = async (
  agentIds: string[],
  db: PortableTrustMaterializationDb = prisma as unknown as PortableTrustMaterializationDb,
): Promise<Map<string, PortableTrustPointer>> => {
  const normalizedAgentIds = Array.from(
    new Set(
      agentIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  const pointers = new Map<string, PortableTrustPointer>();
  for (const agentId of normalizedAgentIds) {
    pointers.set(agentId.toLowerCase(), {
      available: false,
      evidenceClass: null,
      issuedAt: null,
      trustUrl: null,
    });
  }

  if (!isPortableTrustEnabled() || normalizedAgentIds.length === 0) {
    return pointers;
  }

  const rows = await db.agentTrustArtifact
    .findMany({
      where: {
        agentId: { in: normalizedAgentIds },
        schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
        isActive: true,
        snapshot: {
          isActive: true,
          status: "READY",
        },
      },
      select: TRUST_POINTER_SELECT,
    })
    .catch((error) => {
      if (isMissingTrustArtifactTableError(error)) return [];
      throw error;
    });

  for (const row of rows) {
    pointers.set(row.agentId.toLowerCase(), {
      available: true,
      evidenceClass: row.evidenceClass,
      issuedAt: row.issuedAt.toISOString(),
      trustUrl: buildTrustUrl(row.agentId),
    });
  }

  return pointers;
};

export type PortableTrustProfileSummary = {
  evidenceClass: TrustEvidenceClass;
  issuedAt: string;
  measuredRails: string[];
  trustUrl: string;
};

export const loadPortableTrustProfileSummaryByAgentId = async (
  agentId: string,
  db: PortableTrustMaterializationDb = prisma as unknown as PortableTrustMaterializationDb,
): Promise<PortableTrustProfileSummary | null> => {
  if (!isPortableTrustEnabled()) return null;

  const artifact = await loadActivePortableTrustArtifactByAgentId(agentId, db);
  if (!artifact) return null;

  return {
    evidenceClass: artifact.trust.evidenceClass,
    issuedAt: artifact.issuedAt,
    measuredRails: [...artifact.summary.measuredRails],
    trustUrl: buildTrustUrl(agentId),
  };
};
