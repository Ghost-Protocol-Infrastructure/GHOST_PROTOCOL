import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  listActivePortableTrustPointersByAgentId,
  loadPortableTrustProfileSummaryByAgentId,
} from "../lib/trust-artifact-store";
import {
  buildPortableTrustPayload,
  PORTABLE_TRUST_SCHEMA_VERSION,
} from "../lib/trust-artifact";

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

test("portable trust profile summary and discovery pointers agree on the public trust URL", async () => {
  process.env.PORTABLE_TRUST_ENABLED = "true";
  delete process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
  delete process.env.GHOST_TRUST_ISSUER_ADDRESS;

  const payload = buildPortableTrustPayload({
    row: {
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
    },
    snapshot: {
      id: "snap_1",
      mode: "erc8004",
      txSource: "agent",
      completedAt: new Date("2026-04-02T12:00:00.000Z"),
    },
    agent: {
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentId: "18755",
      name: "Booski",
      creator: "0xcccccccccccccccccccccccccccccccccccccccc",
      owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    issuerAddress: TEST_ISSUER_ADDRESS,
    issuedAt: new Date("2026-04-02T12:00:00.000Z"),
  });

  const db = {
    leaderboardSnapshot: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    leaderboardSnapshotRow: {
      findMany: async () => [],
    },
    agentTrustArtifact: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      findFirst: async () => ({
        agentId: "18755",
        evidenceClass: payload.trust.evidenceClass,
        issuedAt: new Date(payload.issuedAt),
        artifactHash: "0xabc123",
        signature: "0xdef456",
        payload,
        schemaVersion: payload.schemaVersion,
        issuerAddress: TEST_ISSUER_ADDRESS,
        hashAlgorithm: "keccak256",
        signatureScheme: "eip191",
      }),
      findMany: async () => [
        {
          agentId: "18755",
          evidenceClass: payload.trust.evidenceClass,
          issuedAt: new Date(payload.issuedAt),
          artifactHash: "0xabc123",
          schemaVersion: payload.schemaVersion,
        },
      ],
    },
  };

  const summary = await loadPortableTrustProfileSummaryByAgentId("18755", db as any);
  const pointers = await listActivePortableTrustPointersByAgentId(["18755"], db as any);

  assert(summary);
  assert.equal(summary.trustUrl, "/api/agents/18755/trust");
  assert.equal(summary.evidenceClass, payload.trust.evidenceClass);
  assert.deepEqual(summary.measuredRails, ["EXPRESS"]);

  assert.deepEqual(pointers.get("18755"), {
    available: true,
    evidenceClass: payload.trust.evidenceClass,
    issuedAt: payload.issuedAt,
    trustUrl: "/api/agents/18755/trust",
  });
});

test("portable trust public reads stay on ghost-trust/v1 without requiring issuer signing config", async () => {
  process.env.PORTABLE_TRUST_ENABLED = "true";
  delete process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
  delete process.env.GHOST_TRUST_ISSUER_ADDRESS;

  const payload = buildPortableTrustPayload({
    row: {
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
    },
    snapshot: {
      id: "snap_1",
      mode: "erc8004",
      txSource: "agent",
      completedAt: new Date("2026-04-02T12:00:00.000Z"),
    },
    agent: {
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentId: "18755",
      name: "Booski",
      creator: "0xcccccccccccccccccccccccccccccccccccccccc",
      owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    issuerAddress: TEST_ISSUER_ADDRESS,
    issuedAt: new Date("2026-04-02T12:00:00.000Z"),
  });

  let capturedFindFirstArgs: unknown = null;
  let capturedFindManyArgs: unknown = null;

  const db = {
    leaderboardSnapshot: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    leaderboardSnapshotRow: {
      findMany: async () => [],
    },
    agentTrustArtifact: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      findFirst: async (args: unknown) => {
        capturedFindFirstArgs = args;
        return {
          agentId: "18755",
          evidenceClass: payload.trust.evidenceClass,
          issuedAt: new Date(payload.issuedAt),
          artifactHash: "0xabc123",
          signature: "0xdef456",
          payload,
          schemaVersion: payload.schemaVersion,
          issuerAddress: TEST_ISSUER_ADDRESS,
          hashAlgorithm: "keccak256",
          signatureScheme: "eip191",
        };
      },
      findMany: async (args: unknown) => {
        capturedFindManyArgs = args;
        return [
          {
            agentId: "18755",
            evidenceClass: payload.trust.evidenceClass,
            issuedAt: new Date(payload.issuedAt),
            artifactHash: "0xabc123",
            schemaVersion: payload.schemaVersion,
          },
        ];
      },
    },
  };

  const summary = await loadPortableTrustProfileSummaryByAgentId("18755", db as any);
  const pointers = await listActivePortableTrustPointersByAgentId(["18755"], db as any);

  assert(summary);
  assert.equal(summary.trustUrl, "/api/agents/18755/trust");
  assert.deepEqual(pointers.get("18755"), {
    available: true,
    evidenceClass: payload.trust.evidenceClass,
    issuedAt: payload.issuedAt,
    trustUrl: "/api/agents/18755/trust",
  });

  assert.deepEqual(capturedFindFirstArgs, {
    where: {
      agentId: "18755",
      schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
      isActive: true,
      snapshot: {
        isActive: true,
        status: "READY",
      },
    },
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
    select: {
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
    },
  });

  assert.deepEqual(capturedFindManyArgs, {
    where: {
      agentId: { in: ["18755"] },
      schemaVersion: PORTABLE_TRUST_SCHEMA_VERSION,
      isActive: true,
      snapshot: {
        isActive: true,
        status: "READY",
      },
    },
    select: {
      agentId: true,
      evidenceClass: true,
      issuedAt: true,
      artifactHash: true,
      schemaVersion: true,
    },
  });
});
