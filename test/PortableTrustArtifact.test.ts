import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPortableTrustPayload,
  deriveTrustEvidenceClass,
  PORTABLE_TRUST_SCHEMA_VERSION,
  type PortableTrustAgent,
  type PortableTrustSnapshot,
  type PortableTrustSnapshotRow,
} from "../lib/trust-artifact";
import {
  canonicalizePortableTrustPayload,
  hashPortableTrustPayload,
  normalizePortableTrustPayload,
  signPortableTrustPayload,
  verifyPortableTrustPayloadSignature,
} from "../lib/trust-signing";

const TEST_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TEST_ISSUER_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address.toLowerCase();

const baseSnapshot = (): PortableTrustSnapshot => ({
  id: "snap_1",
  mode: "erc8004",
  txSource: "agent",
  completedAt: new Date("2026-04-02T12:00:00.000Z"),
});

const baseAgent = (): PortableTrustAgent => ({
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agentId: "18755",
  name: "Booski",
  owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  creator: "0xcccccccccccccccccccccccccccccccccccccccc",
});

const baseRow = (): PortableTrustSnapshotRow => ({
  agentAddress: baseAgent().address,
  agentId: "18755",
  name: "Booski",
  creator: baseAgent().creator,
  owner: baseAgent().owner,
  status: "active",
  tier: "NEW",
  metricSource: "UNRESOLVED",
  canonicalOnchainAddress: baseAgent().address,
  canonicalAddressSource: "AGENT_ADDRESS",
  rankScore: 67.35,
  reputation: 72.1,
  yield: 0.0123,
  uptime: 99.3,
  railMode: "HYBRID",
  usageAuthorizedCount7d: 0,
  expressYield: 0,
  x402Yield: 0,
  wireYield: 0,
  expressConfidence: 0,
  x402Confidence: 0,
  wireConfidence: 0,
  expressReputation: null,
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
});

test("trust evidence classification is honest across measured, mixed, fallback-only, and unproven rows", () => {
  assert.equal(
    deriveTrustEvidenceClass({
      ...baseRow(),
      usageAuthorizedCount7d: 5,
      expressYield: 0.2,
      metricSource: "USAGE_ACTIVITY_7D",
    }),
    "MEASURED",
  );

  assert.equal(
    deriveTrustEvidenceClass({
      ...baseRow(),
      x402QualifiedCount30d: 3,
      x402NetVolume30d: 5000n,
      metricSource: "OWNER_FALLBACK",
    }),
    "MIXED",
  );

  assert.equal(
    deriveTrustEvidenceClass({
      ...baseRow(),
      metricSource: "CREATOR_FALLBACK",
      onchainTxCountOwner: 14,
    }),
    "FALLBACK_ONLY",
  );

  assert.equal(deriveTrustEvidenceClass(baseRow()), "UNPROVEN");
});

test("portable trust payload canonicalization and hashing are deterministic", () => {
  const payload = buildPortableTrustPayload({
    row: {
      ...baseRow(),
      usageAuthorizedCount7d: 8,
      expressYield: 0.12,
      expressConfidence: 0.7,
      expressReputation: 74.2,
      x402QualifiedCount30d: 14,
      x402UniqueCounterparties30d: 6,
      x402NetVolume30d: 12_000_000n,
      x402GrossVolume30d: 15_000_000n,
      x402SuccessRate30d: 92.5,
      x402ConcentrationPenalty: 4.3,
      x402RelatedPartyFilteredCount30d: 1,
      x402Yield: 0.0012,
      x402Confidence: 0.52,
      x402Reputation: 69.8,
      wireYield: 0.008,
      wireConfidence: 0.3,
      wireReputation: 61.2,
      commerceQuality: 58.4,
    },
    snapshot: baseSnapshot(),
    agent: baseAgent(),
    issuerAddress: TEST_ISSUER_ADDRESS,
    issuedAt: new Date("2026-04-02T12:00:00.000Z"),
  });

  assert.equal(payload.schemaVersion, PORTABLE_TRUST_SCHEMA_VERSION);
  assert.equal(payload.summary.measuredRails.join(","), "EXPRESS,X402,WIRE");
  assert.equal(typeof payload.details?.rails.x402?.grossVolume30d, "string");
  assert.equal(payload.details?.rails.x402?.grossVolume30d, "15000000");
  const normalized = normalizePortableTrustPayload(payload);
  const canonical = canonicalizePortableTrustPayload(normalized);
  const canonicalAgain = canonicalizePortableTrustPayload({
    ...normalized,
    issuer: {
      signatureScheme: normalized.issuer.signatureScheme,
      name: normalized.issuer.name,
      hashAlgorithm: normalized.issuer.hashAlgorithm,
      address: normalized.issuer.address,
    },
    trust: {
      reputation: normalized.trust.reputation,
      railMode: normalized.trust.railMode,
      tier: normalized.trust.tier,
      evidenceClass: normalized.trust.evidenceClass,
      uptime: normalized.trust.uptime,
      rankScore: normalized.trust.rankScore,
      metricSource: normalized.trust.metricSource,
      yield: normalized.trust.yield,
    },
  });

  assert.equal(canonical, canonicalAgain);
  assert.equal(hashPortableTrustPayload(normalized), hashPortableTrustPayload(normalized));
});

test("portable trust signatures verify against the Ghost issuer address", async () => {
  const payload = normalizePortableTrustPayload(
    buildPortableTrustPayload({
      row: {
        ...baseRow(),
        usageAuthorizedCount7d: 4,
        expressYield: 0.15,
        expressConfidence: 0.65,
      },
      snapshot: baseSnapshot(),
      agent: baseAgent(),
      issuerAddress: TEST_ISSUER_ADDRESS,
      issuedAt: new Date("2026-04-02T12:00:00.000Z"),
    }),
  );

  const verification = await signPortableTrustPayload({
    payload,
    privateKey: TEST_PRIVATE_KEY,
  });

  assert.equal(
    await verifyPortableTrustPayloadSignature({
      payload,
      artifactHash: verification.artifactHash,
      signature: verification.signature,
      issuerAddress: TEST_ISSUER_ADDRESS,
    }),
    true,
  );
});
