-- CreateEnum
CREATE TYPE "MerchantSettlementRollupReleaseReason" AS ENUM ('FEE_THRESHOLD', 'MAX_AGE');

-- AlterTable
ALTER TABLE "MerchantEarning"
ADD COLUMN "settlementRollupId" TEXT;

-- CreateTable
CREATE TABLE "MerchantSettlementRollup" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "merchantOwnerAddress" TEXT NOT NULL,
    "status" "MerchantEarningStatus" NOT NULL DEFAULT 'PENDING',
    "grossWei" BIGINT NOT NULL,
    "feeWei" BIGINT NOT NULL,
    "netWei" BIGINT NOT NULL,
    "earningCount" INTEGER NOT NULL,
    "oldestEarningCreatedAt" TIMESTAMP(3) NOT NULL,
    "newestEarningCreatedAt" TIMESTAMP(3) NOT NULL,
    "releaseReason" "MerchantSettlementRollupReleaseReason" NOT NULL,
    "allocatorBatchId" TEXT,
    "txHash" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantSettlementRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSettlementRollup_settlementId_key" ON "MerchantSettlementRollup"("settlementId");

-- CreateIndex
CREATE INDEX "MerchantSettlementRollup_status_createdAt_idx" ON "MerchantSettlementRollup"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MerchantSettlementRollup_merchantOwnerAddress_status_createdAt_idx" ON "MerchantSettlementRollup"("merchantOwnerAddress", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MerchantSettlementRollup_allocatorBatchId_status_idx" ON "MerchantSettlementRollup"("allocatorBatchId", "status");

-- CreateIndex
CREATE INDEX "MerchantSettlementRollup_txHash_idx" ON "MerchantSettlementRollup"("txHash");

-- CreateIndex
CREATE INDEX "MerchantEarning_settlementRollupId_status_idx" ON "MerchantEarning"("settlementRollupId", "status");

-- AddForeignKey
ALTER TABLE "MerchantSettlementRollup"
ADD CONSTRAINT "MerchantSettlementRollup_allocatorBatchId_fkey"
FOREIGN KEY ("allocatorBatchId") REFERENCES "MerchantSettlementBatch"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantEarning"
ADD CONSTRAINT "MerchantEarning_settlementRollupId_fkey"
FOREIGN KEY ("settlementRollupId") REFERENCES "MerchantSettlementRollup"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
