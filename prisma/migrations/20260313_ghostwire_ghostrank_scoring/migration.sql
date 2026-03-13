-- CreateEnum
CREATE TYPE "AgentRailMode" AS ENUM ('EXPRESS', 'WIRE', 'HYBRID', 'UNPROVEN');

-- AlterTable
ALTER TABLE "AgentScoreInput"
ADD COLUMN "expressYield" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "wireYield" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "commerceQuality" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "expressConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "wireConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "wireCompletedCount30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wireRejectedCount30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wireExpiredCount30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wireSettledPrincipal30d" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "wireSettledProviderEarnings30d" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "expressReputation" DOUBLE PRECISION,
ADD COLUMN "wireReputation" DOUBLE PRECISION,
ADD COLUMN "railMode" "AgentRailMode" NOT NULL DEFAULT 'UNPROVEN';

-- AlterTable
ALTER TABLE "LeaderboardSnapshotRow"
ADD COLUMN "expressYield" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "wireYield" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "commerceQuality" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "expressConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "wireConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "expressReputation" DOUBLE PRECISION,
ADD COLUMN "wireReputation" DOUBLE PRECISION,
ADD COLUMN "railMode" "AgentRailMode" NOT NULL DEFAULT 'UNPROVEN';

-- AlterTable
ALTER TABLE "WireQuote"
ADD COLUMN "providerAgentId" TEXT,
ADD COLUMN "providerServiceSlug" TEXT;

-- AlterTable
ALTER TABLE "WireJob"
ADD COLUMN "providerAgentId" TEXT,
ADD COLUMN "providerServiceSlug" TEXT;

-- CreateIndex
CREATE INDEX "WireQuote_providerAgentId_createdAt_idx" ON "WireQuote"("providerAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "WireQuote_providerServiceSlug_createdAt_idx" ON "WireQuote"("providerServiceSlug", "createdAt");

-- CreateIndex
CREATE INDEX "WireJob_providerAgentId_createdAt_idx" ON "WireJob"("providerAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "WireJob_providerServiceSlug_createdAt_idx" ON "WireJob"("providerServiceSlug", "createdAt");
