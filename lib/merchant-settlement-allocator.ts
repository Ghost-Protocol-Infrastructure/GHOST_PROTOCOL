import { Prisma, type MerchantSettlementBatch, type MerchantSettlementBatchStatus } from "@prisma/client";
import { getAddress, type Address } from "viem";
import { GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "./constants";
import { createMerchantSettlementRollups, prisma } from "./db";
import {
  parsePositiveBigIntEnv,
  parsePositiveIntegerEnv,
  resolveMerchantSettlementRollupConfig,
} from "./merchant-settlement-config";
import {
  buildMerchantSettlementRollupCandidates,
  type MerchantSettlementRollupSourceRow,
} from "./merchant-settlement-rollup";
import { createSettlementPublicClient, createSettlementWalletClient } from "./merchant-settlement-chain";
export { determineSettlementReconciliationOutcome } from "./merchant-settlement-reconcile";

type SettlementPublicClient = ReturnType<typeof createSettlementPublicClient>;
type SettlementWalletClient = ReturnType<typeof createSettlementWalletClient>["walletClient"];

const DEFAULT_ALLOCATOR_MAX_BATCH_SIZE = 20;
const DEFAULT_ALLOCATOR_GAS_BUDGET_PER_RUN = 2_400_000n;
const DEFAULT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT = 120_000n;
const DEFAULT_ALLOCATOR_COOLDOWN_MS = 30_000;
const DEFAULT_ALLOCATOR_MAX_GAS_PRICE_GWEI = 3n;
const DEFAULT_ALLOCATOR_MIN_CONFIRMATIONS = 2;
const GWEI = 1_000_000_000n;

const normalizeBatchStatus = (status: MerchantSettlementBatchStatus): MerchantSettlementBatchStatus => status;

export type MerchantEarningAllocationCandidate = {
  id: string;
  settlementId: `0x${string}` | string;
  merchantOwnerAddress: Address | string;
  grossWei: bigint;
  feeWei: bigint;
  netWei: bigint;
  createdAt: Date;
  earningCount?: number;
};

export type MerchantSettlementAllocatorConfig = {
  maxBatchSize: number;
  gasBudgetPerRun: bigint;
  gasEstimatePerSettlement: bigint;
  cooldownMs: number;
  maxGasPriceWei: bigint;
  minConfirmations: number;
};

export type MerchantSettlementBatchPayload = {
  merchants: Address[];
  grossAmounts: bigint[];
  feeAmounts: bigint[];
  settlementIds: `0x${string}`[];
  totalGrossWei: bigint;
  totalFeeWei: bigint;
  totalNetWei: bigint;
};

export type MerchantSettlementBatchPreview = {
  selectionLimit: number;
  selectedCount: number;
  rawEarningCount: number;
  pendingRollupCount: number;
  projectedNewRollupCount: number;
  legacySubmittedCount: number;
};

export type MerchantSettlementBatchClaimResult =
  | { status: "noop"; reason: string; config: MerchantSettlementAllocatorConfig }
  | { status: "cooldown"; reason: string; batchId: string; config: MerchantSettlementAllocatorConfig }
  | {
      status: "claimed";
      batch: MerchantSettlementBatch;
      earnings: MerchantEarningAllocationCandidate[];
      config: MerchantSettlementAllocatorConfig;
    };

export type MerchantSettlementBatchSubmissionResult =
  | {
      status: "submitted";
      batchId: string;
      txHash: `0x${string}`;
      selectedCount: number;
      gasPriceWei: bigint;
      config: MerchantSettlementAllocatorConfig;
    }
  | {
      status: "confirmed";
      reason: string;
      selectedCount: number;
      config: MerchantSettlementAllocatorConfig;
    }
  | {
      status: "reverted";
      reason: string;
      selectedCount: number;
      config: MerchantSettlementAllocatorConfig;
    }
  | {
      status: "noop";
      reason: string;
      selectedCount: number;
      config: MerchantSettlementAllocatorConfig;
    };

export const resolveAllocatorSelectionLimit = (
  config: Pick<MerchantSettlementAllocatorConfig, "maxBatchSize" | "gasBudgetPerRun" | "gasEstimatePerSettlement">,
): number => {
  if (config.maxBatchSize <= 0) return 0;
  if (config.gasBudgetPerRun <= 0n || config.gasEstimatePerSettlement <= 0n) return 0;

  const budgetLimited = Number(config.gasBudgetPerRun / config.gasEstimatePerSettlement);
  if (!Number.isFinite(budgetLimited) || budgetLimited <= 0) return 0;
  return Math.max(0, Math.min(config.maxBatchSize, budgetLimited));
};

export const selectPendingMerchantEarningsForAllocation = (
  rows: MerchantEarningAllocationCandidate[],
  config: Pick<MerchantSettlementAllocatorConfig, "maxBatchSize" | "gasBudgetPerRun" | "gasEstimatePerSettlement">,
): MerchantEarningAllocationCandidate[] => {
  const limit = resolveAllocatorSelectionLimit(config);
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, limit);
};

export const buildMerchantAllocationBatch = (
  rows: MerchantEarningAllocationCandidate[],
): MerchantSettlementBatchPayload => {
  const merchants: Address[] = [];
  const grossAmounts: bigint[] = [];
  const feeAmounts: bigint[] = [];
  const settlementIds: `0x${string}`[] = [];
  let totalGrossWei = 0n;
  let totalFeeWei = 0n;
  let totalNetWei = 0n;

  for (const row of rows) {
    merchants.push(getAddress(row.merchantOwnerAddress));
    grossAmounts.push(row.grossWei);
    feeAmounts.push(row.feeWei);
    settlementIds.push(row.settlementId as `0x${string}`);
    totalGrossWei += row.grossWei;
    totalFeeWei += row.feeWei;
    totalNetWei += row.netWei;
  }

  return {
    merchants,
    grossAmounts,
    feeAmounts,
    settlementIds,
    totalGrossWei,
    totalFeeWei,
    totalNetWei,
  };
};

export const resolveMerchantSettlementAllocatorConfig = (): MerchantSettlementAllocatorConfig => ({
  maxBatchSize: parsePositiveIntegerEnv(process.env.GHOST_SETTLEMENT_ALLOCATOR_MAX_BATCH_SIZE, DEFAULT_ALLOCATOR_MAX_BATCH_SIZE),
  gasBudgetPerRun: parsePositiveBigIntEnv(
    process.env.GHOST_SETTLEMENT_ALLOCATOR_GAS_BUDGET_PER_RUN,
    DEFAULT_ALLOCATOR_GAS_BUDGET_PER_RUN,
  ),
  gasEstimatePerSettlement: parsePositiveBigIntEnv(
    process.env.GHOST_SETTLEMENT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT,
    DEFAULT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT,
  ),
  cooldownMs: parsePositiveIntegerEnv(process.env.GHOST_SETTLEMENT_ALLOCATOR_COOLDOWN_MS, DEFAULT_ALLOCATOR_COOLDOWN_MS),
  maxGasPriceWei:
    parsePositiveBigIntEnv(process.env.GHOST_SETTLEMENT_ALLOCATOR_MAX_GAS_PRICE_GWEI, DEFAULT_ALLOCATOR_MAX_GAS_PRICE_GWEI) *
    GWEI,
  minConfirmations: parsePositiveIntegerEnv(
    process.env.GHOST_SETTLEMENT_ALLOCATOR_MIN_CONFIRMATIONS,
    DEFAULT_ALLOCATOR_MIN_CONFIRMATIONS,
  ),
});

const loadPendingMerchantEarningIds = async (
  tx: Prisma.TransactionClient,
  limit: number,
): Promise<string[]> => {
  if (limit <= 0) return [];

  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MerchantSettlementRollup"
    WHERE "status" = 'PENDING'
      AND "allocatorBatchId" IS NULL
    ORDER BY "oldestEarningCreatedAt" ASC, "id" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);

  return rows.map((row) => row.id);
};

const loadPendingMerchantEarningsForRollupPreview = async (
  selectionLimit: number,
  maxEarningsPerRollup: number,
): Promise<MerchantSettlementRollupSourceRow[]> => {
  if (selectionLimit <= 0 || maxEarningsPerRollup <= 0) {
    return [];
  }

  const rowLimit = Math.max(selectionLimit * maxEarningsPerRollup, maxEarningsPerRollup);
  return prisma.$queryRaw<MerchantSettlementRollupSourceRow[]>(Prisma.sql`
    SELECT "id", "settlementId", "merchantOwnerAddress", "grossWei", "feeWei", "netWei", "createdAt"
    FROM "MerchantEarning"
    WHERE "status" = 'PENDING'
      AND "settlementRollupId" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${rowLimit}
  `);
};

const revertBatchToPending = async (input: {
  batchId: string;
  reason: string;
}): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.merchantSettlementRollup.updateMany({
      where: {
        allocatorBatchId: input.batchId,
        status: "SUBMITTED",
      },
      data: {
        status: "FAILED",
        allocatorBatchId: null,
        txHash: null,
        failureCode: "ALLOCATOR_SUBMIT_FAILED",
        failureMessage: input.reason,
      },
    });

    await tx.merchantEarning.updateMany({
      where: {
        allocatorBatchId: input.batchId,
        status: "SUBMITTED",
      },
      data: {
        status: "PENDING",
        settlementRollupId: null,
        allocatorBatchId: null,
        txHash: null,
        failureCode: "ALLOCATOR_SUBMIT_FAILED",
        failureMessage: input.reason,
      },
    });

    await tx.merchantSettlementBatch.update({
      where: { id: input.batchId },
      data: {
        status: "FAILED",
        failureMessage: input.reason,
      },
    });
  });
};

const markBatchConfirmed = async (input: {
  batchId: string;
}): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.merchantSettlementRollup.updateMany({
      where: {
        allocatorBatchId: input.batchId,
        status: "SUBMITTED",
      },
      data: {
        status: "CONFIRMED",
        failureCode: null,
        failureMessage: null,
      },
    });

    await tx.merchantEarning.updateMany({
      where: {
        allocatorBatchId: input.batchId,
        status: "SUBMITTED",
      },
      data: {
        status: "CONFIRMED",
        failureCode: null,
        failureMessage: null,
      },
    });

    await tx.merchantSettlementBatch.update({
      where: { id: input.batchId },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        failureMessage: null,
      },
    });
  });
};

const readProcessedSettlementIds = async (
  client: SettlementPublicClient,
  settlementIds: readonly `0x${string}`[],
): Promise<boolean[]> => {
  return Promise.all(
    settlementIds.map((settlementId) =>
      client.readContract({
        address: GHOST_VAULT_ADDRESS,
        abi: GHOST_VAULT_ABI,
        functionName: "processedSettlementIds",
        args: [settlementId],
      }) as Promise<boolean>,
    ),
  );
};

export const previewNextMerchantSettlementBatch = async (
  config: MerchantSettlementAllocatorConfig,
): Promise<MerchantSettlementBatchPreview> => {
  const selectionLimit = resolveAllocatorSelectionLimit(config);
  if (selectionLimit <= 0) {
    return {
      selectionLimit,
      selectedCount: 0,
      rawEarningCount: 0,
      pendingRollupCount: 0,
      projectedNewRollupCount: 0,
      legacySubmittedCount: 0,
    };
  }

  const rollupConfig = resolveMerchantSettlementRollupConfig();
  const [legacySubmittedCount, pendingRollups] = await Promise.all([
    prisma.merchantEarning.count({
      where: {
        status: "SUBMITTED",
        settlementRollupId: null,
      },
    }),
    prisma.merchantSettlementRollup.findMany({
      where: {
        status: "PENDING",
        allocatorBatchId: null,
      },
      orderBy: [{ oldestEarningCreatedAt: "asc" }, { id: "asc" }],
      take: selectionLimit,
      select: {
        id: true,
        earningCount: true,
      },
    }),
  ]);

  const pendingRollupCount = pendingRollups.length;
  const pendingRawEarningCount = pendingRollups.reduce((sum, row) => sum + row.earningCount, 0);

  if (legacySubmittedCount > 0 || pendingRollupCount >= selectionLimit) {
    return {
      selectionLimit,
      selectedCount: pendingRollupCount,
      rawEarningCount: pendingRawEarningCount,
      pendingRollupCount,
      projectedNewRollupCount: 0,
      legacySubmittedCount,
    };
  }

  const previewRows = await loadPendingMerchantEarningsForRollupPreview(selectionLimit, rollupConfig.maxEarningsPerRollup);
  const projectedCandidates = buildMerchantSettlementRollupCandidates(previewRows, rollupConfig, new Date()).slice(
    0,
    selectionLimit - pendingRollupCount,
  );
  const projectedRawEarningCount = projectedCandidates.reduce((sum, row) => sum + row.earningCount, 0);

  return {
    selectionLimit,
    selectedCount: pendingRollupCount + projectedCandidates.length,
    rawEarningCount: pendingRawEarningCount + projectedRawEarningCount,
    pendingRollupCount,
    projectedNewRollupCount: projectedCandidates.length,
    legacySubmittedCount,
  };
};

export const claimNextMerchantSettlementBatch = async (
  config: MerchantSettlementAllocatorConfig,
): Promise<MerchantSettlementBatchClaimResult> => {
  const selectionLimit = resolveAllocatorSelectionLimit(config);
  if (selectionLimit <= 0) {
    return {
      status: "noop",
      reason: "Allocator selection limit resolved to zero.",
      config,
    };
  }

  const legacySubmittedCount = await prisma.merchantEarning.count({
    where: {
      status: "SUBMITTED",
      settlementRollupId: null,
    },
  });
  if (legacySubmittedCount > 0) {
    return {
      status: "noop",
      reason: `Legacy raw submitted settlement rows are still present (${legacySubmittedCount}). Reconcile them before rollup allocation continues.`,
      config,
    };
  }

  const now = new Date();
  const cooldownThreshold = new Date(now.getTime() - config.cooldownMs);
  const activeBatch = await prisma.merchantSettlementBatch.findFirst({
    where: {
      status: {
        in: ["OPEN", "SUBMITTED"],
      },
      updatedAt: {
        gte: cooldownThreshold,
      },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
  if (activeBatch) {
    return {
      status: "cooldown",
      reason: "A recent settlement batch is still within cooldown.",
      batchId: activeBatch.id,
      config,
    };
  }

  await createMerchantSettlementRollups({
    config: resolveMerchantSettlementRollupConfig(),
    maxRollups: selectionLimit,
  });

  return prisma.$transaction(async (tx) => {
    const selectedIds = await loadPendingMerchantEarningIds(tx, selectionLimit);
    if (selectedIds.length === 0) {
      return {
        status: "noop",
        reason: "No pending settlement rollups are ready for allocation.",
        config,
      } satisfies MerchantSettlementBatchClaimResult;
    }

    const batch = await tx.merchantSettlementBatch.create({
      data: {
        status: "OPEN",
      },
    });

    const updatedRollups = await tx.merchantSettlementRollup.updateMany({
      where: {
        id: { in: selectedIds },
        status: "PENDING",
      },
      data: {
        status: "SUBMITTED",
        allocatorBatchId: batch.id,
        txHash: null,
        failureCode: null,
        failureMessage: null,
      },
    });

    if (updatedRollups.count !== selectedIds.length) {
      throw new Error("Allocator failed to claim all selected settlement rollups.");
    }

    const rows = await tx.merchantSettlementRollup.findMany({
      where: { id: { in: selectedIds } },
      select: {
        id: true,
        settlementId: true,
        merchantOwnerAddress: true,
        grossWei: true,
        feeWei: true,
        netWei: true,
        earningCount: true,
        oldestEarningCreatedAt: true,
      },
    });

    const totalEarningCount = rows.reduce((sum, row) => sum + row.earningCount, 0);
    const updatedEarnings = await tx.merchantEarning.updateMany({
      where: {
        settlementRollupId: { in: selectedIds },
        status: "PENDING",
      },
      data: {
        status: "SUBMITTED",
        allocatorBatchId: batch.id,
        txHash: null,
        failureCode: null,
        failureMessage: null,
      },
    });

    if (updatedEarnings.count !== totalEarningCount) {
      throw new Error("Allocator failed to claim all member merchant earnings for the selected rollups.");
    }

    const orderedRows = selectedIds
      .map((id) => rows.find((row) => row.id === id))
      .filter((row): row is NonNullable<typeof rows[number]> => row != null);

    return {
      status: "claimed",
      batch,
      earnings: orderedRows.map((row) => ({
        id: row.id,
        settlementId: row.settlementId,
        merchantOwnerAddress: row.merchantOwnerAddress,
        grossWei: row.grossWei,
        feeWei: row.feeWei,
        netWei: row.netWei,
        createdAt: row.oldestEarningCreatedAt,
        earningCount: row.earningCount,
      })),
      config,
    } satisfies MerchantSettlementBatchClaimResult;
  });
};

export const submitMerchantSettlementBatch = async (input: {
  batchId: string;
  earnings: MerchantEarningAllocationCandidate[];
  config: MerchantSettlementAllocatorConfig;
  publicClient?: SettlementPublicClient;
  walletClient?: SettlementWalletClient;
}): Promise<MerchantSettlementBatchSubmissionResult> => {
  if (input.earnings.length === 0) {
    return {
      status: "noop",
      reason: "No claimed earnings were supplied for submission.",
      selectedCount: 0,
      config: input.config,
    };
  }

  const publicClient = input.publicClient ?? createSettlementPublicClient();

  const gasPriceWei = await publicClient.getGasPrice();
  if (gasPriceWei > input.config.maxGasPriceWei) {
    const reason = `Allocator gas price ${gasPriceWei.toString()} exceeded configured cap ${input.config.maxGasPriceWei.toString()}.`;
    await revertBatchToPending({
      batchId: input.batchId,
      reason,
    });
    return {
      status: "noop",
      reason,
      selectedCount: input.earnings.length,
      config: input.config,
    };
  }

  const batchPayload = buildMerchantAllocationBatch(input.earnings);

  try {
    const walletClient = input.walletClient ?? createSettlementWalletClient().walletClient;
    const txHash = await walletClient.writeContract({
      account: walletClient.account!,
      chain: walletClient.chain,
      address: GHOST_VAULT_ADDRESS,
      abi: GHOST_VAULT_ABI,
      functionName: "allocateMerchantEarningsBatch",
      args: [
        batchPayload.merchants,
        batchPayload.grossAmounts,
        batchPayload.feeAmounts,
        batchPayload.settlementIds,
      ],
    });

    await prisma.$transaction(async (tx) => {
      await tx.merchantSettlementBatch.update({
        where: { id: input.batchId },
        data: {
          status: normalizeBatchStatus("SUBMITTED"),
          txHash,
          submittedAt: new Date(),
          failureMessage: null,
        },
      });

      await tx.merchantSettlementRollup.updateMany({
        where: {
          allocatorBatchId: input.batchId,
          status: "SUBMITTED",
        },
        data: {
          txHash,
          failureCode: null,
          failureMessage: null,
        },
      });

      await tx.merchantEarning.updateMany({
        where: {
          allocatorBatchId: input.batchId,
          status: "SUBMITTED",
        },
        data: {
          txHash,
          failureCode: null,
          failureMessage: null,
        },
      });
    });

    return {
      status: "submitted",
      batchId: input.batchId,
      txHash,
      selectedCount: input.earnings.length,
      gasPriceWei,
      config: input.config,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement batch submission failed.";
    const processedStatuses = await readProcessedSettlementIds(publicClient, batchPayload.settlementIds);
    if (processedStatuses.length > 0 && processedStatuses.every(Boolean)) {
      const reason = "Allocation submission failed locally, but all settlement ids were already processed on-chain.";
      await markBatchConfirmed({
        batchId: input.batchId,
      });
      return {
        status: "confirmed",
        reason,
        selectedCount: input.earnings.length,
        config: input.config,
      };
    }

    await revertBatchToPending({
      batchId: input.batchId,
      reason: message,
    });
    return {
      status: "reverted",
      reason: message,
      selectedCount: input.earnings.length,
      config: input.config,
    };
  }
};
