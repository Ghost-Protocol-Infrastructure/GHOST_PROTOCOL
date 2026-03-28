CREATE TYPE "AgentOfferingRail" AS ENUM ('X402', 'EXPRESS', 'GHOSTWIRE');

CREATE TYPE "AgentOfferingTargetKind" AS ENUM ('SERVICE_SLUG', 'MCP_TOOL', 'GHOSTWIRE_INTENT');

CREATE TABLE "AgentOffering" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "consumerCommand" TEXT NOT NULL,
  "rail" "AgentOfferingRail" NOT NULL,
  "targetKind" "AgentOfferingTargetKind" NOT NULL,
  "targetRef" TEXT NOT NULL,
  "priceHint" TEXT,
  "etaHint" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentOffering_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentOffering_agentId_isActive_sortOrder_idx" ON "AgentOffering"("agentId", "isActive", "sortOrder");
CREATE INDEX "AgentOffering_agentId_createdAt_idx" ON "AgentOffering"("agentId", "createdAt");
CREATE INDEX "AgentOffering_agentId_rail_targetKind_targetRef_idx" ON "AgentOffering"("agentId", "rail", "targetKind", "targetRef");

ALTER TABLE "AgentOffering"
ADD CONSTRAINT "AgentOffering_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;
