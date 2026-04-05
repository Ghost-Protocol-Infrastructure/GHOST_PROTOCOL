import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/agents/[id]/trust/route";
import { prisma } from "../lib/db";
import {
  buildPortableTrustPayload,
  PORTABLE_TRUST_SCHEMA_VERSION,
} from "../lib/trust-artifact";
import { privateKeyToAccount } from "viem/accounts";

const ORIGINAL_PORTABLE_TRUST_ENABLED = process.env.PORTABLE_TRUST_ENABLED;
const ORIGINAL_GHOST_TRUST_ISSUER_PRIVATE_KEY = process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
const ORIGINAL_GHOST_TRUST_ISSUER_ADDRESS = process.env.GHOST_TRUST_ISSUER_ADDRESS;

const TEST_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TEST_ISSUER_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address.toLowerCase();

const originalTrustFindFirst = prisma.agentTrustArtifact.findFirst;

const request = () => new NextRequest("https://ghost.local/api/agents/18755/trust");

const restoreEnv = () => {
  process.env.PORTABLE_TRUST_ENABLED = ORIGINAL_PORTABLE_TRUST_ENABLED;
  process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY = ORIGINAL_GHOST_TRUST_ISSUER_PRIVATE_KEY;
  process.env.GHOST_TRUST_ISSUER_ADDRESS = ORIGINAL_GHOST_TRUST_ISSUER_ADDRESS;
};

const stubTrustFindFirst = (impl: any) => {
  (prisma.agentTrustArtifact as { findFirst: any }).findFirst = impl;
};

const buildPayload = () =>
  buildPortableTrustPayload({
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

afterEach(() => {
  stubTrustFindFirst(originalTrustFindFirst);
  restoreEnv();
});

describe("agent trust route", () => {
  it("returns 404 when portable trust is disabled", async () => {
    process.env.PORTABLE_TRUST_ENABLED = "false";

    const response = await GET(request(), { params: Promise.resolve({ id: "18755" }) });
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 404);
    assert.match(String(payload.error), /not enabled/i);
  });

  it("serves stored artifacts even when the read tier has no issuer private key", async () => {
    process.env.PORTABLE_TRUST_ENABLED = "true";
    delete process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
    delete process.env.GHOST_TRUST_ISSUER_ADDRESS;

    const payload = buildPayload();
    stubTrustFindFirst(async () => ({
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
    }));

    const response = await GET(request(), { params: Promise.resolve({ id: "18755" }) });
    const body = (await response.json()) as {
      ok?: boolean;
      artifact?: {
        summary?: { measuredRails?: string[] };
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.artifact?.summary?.measuredRails, ["EXPRESS"]);
  });

  it("queries only the active v1 trust artifact for the requested agent", async () => {
    process.env.PORTABLE_TRUST_ENABLED = "true";
    delete process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY;
    delete process.env.GHOST_TRUST_ISSUER_ADDRESS;

    let capturedArgs: unknown = null;
    stubTrustFindFirst(async (args: unknown) => {
      capturedArgs = args;
      return null;
    });

    const response = await GET(request(), { params: Promise.resolve({ id: "18755" }) });

    assert.equal(response.status, 404);
    assert.deepEqual(capturedArgs, {
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
  });

  it("serves the active portable trust artifact with verification data", async () => {
    process.env.PORTABLE_TRUST_ENABLED = "true";
    process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GHOST_TRUST_ISSUER_ADDRESS = TEST_ISSUER_ADDRESS;

    const payload = buildPayload();
    stubTrustFindFirst(async () => ({
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
    }));

    const response = await GET(request(), { params: Promise.resolve({ id: "18755" }) });
    const body = (await response.json()) as {
      ok?: boolean;
      artifact?: {
        summary?: { measuredRails?: string[] };
        verification?: { artifactHash?: string; signature?: string };
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.artifact?.summary?.measuredRails, ["EXPRESS"]);
    assert.equal(body.artifact?.verification?.artifactHash, "0xabc123");
    assert.equal(body.artifact?.verification?.signature, "0xdef456");
  });
});
