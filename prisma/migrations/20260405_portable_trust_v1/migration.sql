CREATE TYPE "TrustEvidenceClass" AS ENUM ('MEASURED', 'MIXED', 'FALLBACK_ONLY', 'UNPROVEN');

CREATE TABLE "AgentTrustArtifact" (
  "id" TEXT NOT NULL,
  "agentAddress" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL DEFAULT 'ghost-trust/v1',
  "evidenceClass" "TrustEvidenceClass" NOT NULL DEFAULT 'UNPROVEN',
  "artifactHash" TEXT NOT NULL,
  "hashAlgorithm" TEXT NOT NULL DEFAULT 'keccak256',
  "signatureScheme" TEXT NOT NULL DEFAULT 'eip191',
  "issuerAddress" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,
  "signature" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentTrustArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTrustArtifact_snapshotId_agentAddress_schemaVersion_key"
  ON "AgentTrustArtifact"("snapshotId", "agentAddress", "schemaVersion");

CREATE INDEX "AgentTrustArtifact_agentId_isActive_issuedAt_idx"
  ON "AgentTrustArtifact"("agentId", "isActive", "issuedAt");

CREATE INDEX "AgentTrustArtifact_snapshotId_isActive_idx"
  ON "AgentTrustArtifact"("snapshotId", "isActive");

CREATE INDEX "AgentTrustArtifact_artifactHash_idx"
  ON "AgentTrustArtifact"("artifactHash");

ALTER TABLE "AgentTrustArtifact"
  ADD CONSTRAINT "AgentTrustArtifact_agentAddress_fkey"
  FOREIGN KEY ("agentAddress") REFERENCES "Agent"("address")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentTrustArtifact"
  ADD CONSTRAINT "AgentTrustArtifact_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "LeaderboardSnapshot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
