import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { backfillPortableTrustForActiveSnapshot } from "../lib/trust-artifact-store";

const ORIGINAL_PORTABLE_TRUST_ENABLED = process.env.PORTABLE_TRUST_ENABLED;
const ORIGINAL_GHOST_TRUST_ISSUER_PRIVATE_KEY = process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
const ORIGINAL_GHOST_TRUST_ISSUER_ADDRESS = process.env.GHOST_TRUST_ISSUER_ADDRESS;

const TEST_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TEST_ISSUER_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address.toLowerCase();

const restoreEnv = () => {
  process.env.PORTABLE_TRUST_ENABLED = ORIGINAL_PORTABLE_TRUST_ENABLED;
  process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY = ORIGINAL_GHOST_TRUST_ISSUER_PRIVATE_KEY;
  process.env.GHOST_TRUST_ISSUER_ADDRESS = ORIGINAL_GHOST_TRUST_ISSUER_ADDRESS;
};

test.afterEach(() => {
  restoreEnv();
});

test("portable trust backfill is idempotent for an already-active snapshot", async () => {
  process.env.PORTABLE_TRUST_ENABLED = "true";
  process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY = TEST_PRIVATE_KEY;
  process.env.GHOST_TRUST_ISSUER_ADDRESS = TEST_ISSUER_ADDRESS;

  const snapshot = {
    id: "snap_1",
    mode: "erc8004",
    txSource: "agent",
    completedAt: new Date("2026-04-02T12:00:00.000Z"),
  };
  const rows = [
    {
      agentAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentId: "18755",
      name: "Booski",
      creator: "0xcccccccccccccccccccccccccccccccccccccccc",
      owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "active",
      tier: "NEW",
      metricSource: "USAGE_ACTIVITY_7D",
      canonicalOnchainAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      canonicalAddressSource: "AGENT_ADDRESS",
      rankScore: 67.35,
      reputation: 72.1,
      yield: 0.0123,
      uptime: 99.3,
      railMode: "HYBRID",
      usageAuthorizedCount7d: 4,
      expressYield: 0.15,
      x402Yield: 0,
      wireYield: 0,
      expressConfidence: 0.65,
      x402Confidence: 0,
      wireConfidence: 0,
      expressReputation: 71.5,
      x402Reputation: null,
      wireReputation: null,
      commerceQuality: 0,
      x402QualifiedCount30d: 0,
      x402UniqueCounterparties30d: 0,
      x402RepeatCounterparties30d: 0,
      x402ActiveDays30d: 0,
      x402GrossVolume30d: 0n,
      x402NetVolume30d: 0n,
      x402SuccessRate30d: 0,
      x402ConcentrationPenalty: 0,
      x402RelatedPartyFilteredCount30d: 0,
      onchainTxCountAgent: 0,
      onchainTxCountOwner: 0,
      agent: {
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        agentId: "18755",
        name: "Booski",
        creator: "0xcccccccccccccccccccccccccccccccccccccccc",
        owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  ];

  const artifacts: Array<Record<string, unknown>> = [];

  const db = {
    leaderboardSnapshot: {
      findFirst: async () => snapshot,
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === snapshot.id ? snapshot : null),
    },
    leaderboardSnapshotRow: {
      findMany: async ({ where }: { where: { snapshotId: string } }) => (where.snapshotId === snapshot.id ? rows : []),
    },
    agentTrustArtifact: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const artifact of artifacts) {
          if (
            artifact.agentAddress === where.agentAddress &&
            artifact.schemaVersion === where.schemaVersion &&
            artifact.isActive === true &&
            artifact.snapshotId !== where.snapshotId.not
          ) {
            artifact.isActive = data.isActive;
            count += 1;
          }
        }
        return { count };
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = artifacts.find(
          (artifact) =>
            artifact.snapshotId === where.snapshotId_agentAddress_schemaVersion.snapshotId &&
            artifact.agentAddress === where.snapshotId_agentAddress_schemaVersion.agentAddress &&
            artifact.schemaVersion === where.snapshotId_agentAddress_schemaVersion.schemaVersion,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        artifacts.push({ id: `artifact_${artifacts.length + 1}`, ...create });
        return artifacts[artifacts.length - 1];
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
  };

  const firstRun = await backfillPortableTrustForActiveSnapshot(db as any);
  const secondRun = await backfillPortableTrustForActiveSnapshot(db as any);

  assert(firstRun);
  assert(secondRun);
  assert.equal(firstRun.processed, 1);
  assert.equal(firstRun.upserted, 1);
  assert.equal(secondRun.processed, 1);
  assert.equal(secondRun.upserted, 1);
  assert.equal(secondRun.deactivated, 0);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.isActive, true);
  assert.equal(
    typeof artifacts[0]?.issuedAt === "object" && artifacts[0]?.issuedAt instanceof Date
      ? artifacts[0].issuedAt.toISOString()
      : String(artifacts[0]?.issuedAt),
    "2026-04-02T12:00:00.000Z",
  );
});
