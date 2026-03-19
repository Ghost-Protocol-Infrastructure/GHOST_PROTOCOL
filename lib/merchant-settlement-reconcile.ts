import type { MerchantSettlementBatchStatus } from "@prisma/client";
import { GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "./constants";
import { prisma } from "./db";
import { createSettlementPublicClient } from "./merchant-settlement-chain";

type SettlementPublicClient = ReturnType<typeof createSettlementPublicClient>;

export type SettlementReceiptStatus = "missing" | "success" | "reverted";
export type SettlementReconciliationOutcome = "confirmed" | "keep_submitted" | "requeue";

export const determineSettlementReconciliationOutcome = (input: {
  processedOnChain: boolean;
  receiptStatus: SettlementReceiptStatus;
  confirmations: number;
  minConfirmations: number;
}): SettlementReconciliationOutcome => {
  if (input.processedOnChain) {
    return "confirmed";
  }

  if (input.receiptStatus === "success") {
    return input.confirmations >= input.minConfirmations ? "confirmed" : "keep_submitted";
  }

  if (input.receiptStatus === "reverted") {
    return "requeue";
  }

  return "keep_submitted";
};

export type MerchantSettlementReconcileConfig = {
  minConfirmations: number;
};

type ReceiptCacheEntry = {
  status: SettlementReceiptStatus;
  confirmations: number;
};

type BatchStatusUpdate = {
  status: MerchantSettlementBatchStatus;
  confirmedAt: Date | null;
  failureMessage: string | null;
};

export type MerchantSettlementReconcileResult = {
  ok: true;
  selectedCount: number;
  confirmedCount: number;
  requeuedCount: number;
  stillSubmittedCount: number;
  updatedBatchCount: number;
};

type DerivedBatchRowState = { status: "CONFIRMED" | "PENDING" | "SUBMITTED" | "FAILED" };

type SubmittedLegacyRow = {
  id: string;
  settlementId: string;
  txHash: string | null;
  allocatorBatchId: string | null;
};

type SubmittedRollupRow = {
  id: string;
  settlementId: string;
  txHash: string | null;
  allocatorBatchId: string | null;
  earningCount: number;
};

const readProcessedSettlementId = async (
  client: SettlementPublicClient,
  settlementId: string,
): Promise<boolean> => {
  return (await client.readContract({
    address: GHOST_VAULT_ADDRESS,
    abi: GHOST_VAULT_ABI,
    functionName: "processedSettlementIds",
    args: [settlementId as `0x${string}`],
  })) as boolean;
};

const buildReceiptCache = async (
  client: SettlementPublicClient,
  txHashes: string[],
): Promise<Map<string, ReceiptCacheEntry>> => {
  const cache = new Map<string, ReceiptCacheEntry>();
  if (txHashes.length === 0) {
    return cache;
  }

  const latestBlock = await client.getBlockNumber();

  for (const txHash of txHashes) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const confirmations = Number(latestBlock - receipt.blockNumber + 1n);
      cache.set(txHash, {
        status: receipt.status === "success" ? "success" : "reverted",
        confirmations,
      });
    } catch {
      cache.set(txHash, {
        status: "missing",
        confirmations: 0,
      });
    }
  }

  return cache;
};

const deriveBatchStatusUpdate = (rows: DerivedBatchRowState[]): BatchStatusUpdate | null => {
  if (rows.length === 0) return null;

  const hasSubmitted = rows.some((row) => row.status === "SUBMITTED");
  if (hasSubmitted) {
    return {
      status: "SUBMITTED",
      confirmedAt: null,
      failureMessage: null,
    };
  }

  const allConfirmed = rows.every((row) => row.status === "CONFIRMED");
  if (allConfirmed) {
    return {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      failureMessage: null,
    };
  }

  return {
    status: "FAILED",
    confirmedAt: null,
    failureMessage: "One or more submitted settlements were re-queued or failed during reconciliation.",
  };
};

export const reconcileMerchantSettlementRows = async (input: {
  config: MerchantSettlementReconcileConfig;
  batchId?: string | null;
  settlementId?: string | null;
  limit?: number;
  publicClient?: SettlementPublicClient;
}): Promise<MerchantSettlementReconcileResult> => {
  const client = input.publicClient ?? createSettlementPublicClient();
  const batchId = input.batchId?.trim() || null;
  const settlementId = input.settlementId?.trim().toLowerCase() || null;
  const limit = Math.max(1, input.limit ?? 100);

  const submittedRollups = await prisma.merchantSettlementRollup.findMany({
    where: {
      status: "SUBMITTED",
      ...(batchId ? { allocatorBatchId: batchId } : {}),
      ...(settlementId ? { settlementId } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { oldestEarningCreatedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      settlementId: true,
      txHash: true,
      allocatorBatchId: true,
      earningCount: true,
    },
  });

  const remainingLimit = Math.max(0, limit - submittedRollups.length);
  const submittedLegacyRows =
    remainingLimit > 0
      ? await prisma.merchantEarning.findMany({
          where: {
            status: "SUBMITTED",
            settlementRollupId: null,
            ...(batchId ? { allocatorBatchId: batchId } : {}),
            ...(settlementId ? { settlementId } : {}),
          },
          orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: remainingLimit,
          select: {
            id: true,
            settlementId: true,
            txHash: true,
            allocatorBatchId: true,
          },
        })
      : [];

  const uniqueTxHashes = Array.from(
    new Set(
      [...submittedRollups, ...submittedLegacyRows]
        .map((row) => row.txHash?.trim().toLowerCase() || null)
        .filter((row): row is string => row != null),
    ),
  );
  const receiptCache = await buildReceiptCache(client, uniqueTxHashes);

  let confirmedCount = 0;
  let requeuedCount = 0;
  let stillSubmittedCount = 0;
  const touchedBatchIds = new Set<string>();
  const requeuedBatchStateCounts = new Map<string, number>();
  const confirmedRollupIds: string[] = [];
  const requeuedRollupIds: string[] = [];
  const confirmedLegacyRowIds: string[] = [];
  const requeuedLegacyRowIds: string[] = [];

  const handleOutcome = (
    row: SubmittedLegacyRow | SubmittedRollupRow,
    outcome: SettlementReconciliationOutcome,
    targetIds: {
      confirmed: string[];
      requeued: string[];
    },
  ): void => {
    if (outcome === "confirmed") {
      confirmedCount += 1;
      targetIds.confirmed.push(row.id);
      if (row.allocatorBatchId) {
        touchedBatchIds.add(row.allocatorBatchId);
      }
      return;
    }

    if (outcome === "requeue") {
      requeuedCount += 1;
      targetIds.requeued.push(row.id);
      if (row.allocatorBatchId) {
        touchedBatchIds.add(row.allocatorBatchId);
        requeuedBatchStateCounts.set(
          row.allocatorBatchId,
          (requeuedBatchStateCounts.get(row.allocatorBatchId) ?? 0) + 1,
        );
      }
      return;
    }

    stillSubmittedCount += 1;
    if (row.allocatorBatchId) {
      touchedBatchIds.add(row.allocatorBatchId);
    }
  };

  for (const rollup of submittedRollups) {
    const processedOnChain = await readProcessedSettlementId(client, rollup.settlementId);
    const receipt = rollup.txHash ? receiptCache.get(rollup.txHash.toLowerCase()) : undefined;
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain,
      receiptStatus: receipt?.status ?? "missing",
      confirmations: receipt?.confirmations ?? 0,
      minConfirmations: input.config.minConfirmations,
    });

    handleOutcome(rollup, outcome, {
      confirmed: confirmedRollupIds,
      requeued: requeuedRollupIds,
    });
  }

  for (const row of submittedLegacyRows) {
    const processedOnChain = await readProcessedSettlementId(client, row.settlementId);
    const receipt = row.txHash ? receiptCache.get(row.txHash.toLowerCase()) : undefined;
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain,
      receiptStatus: receipt?.status ?? "missing",
      confirmations: receipt?.confirmations ?? 0,
      minConfirmations: input.config.minConfirmations,
    });

    handleOutcome(row, outcome, {
      confirmed: confirmedLegacyRowIds,
      requeued: requeuedLegacyRowIds,
    });
  }

  let updatedBatchCount = 0;
  const confirmedRollupEarningCount = submittedRollups
    .filter((rollup) => confirmedRollupIds.includes(rollup.id))
    .reduce((sum, rollup) => sum + rollup.earningCount, 0);
  const requeuedRollupEarningCount = submittedRollups
    .filter((rollup) => requeuedRollupIds.includes(rollup.id))
    .reduce((sum, rollup) => sum + rollup.earningCount, 0);

  await prisma.$transaction(async (tx) => {
    if (confirmedRollupIds.length > 0) {
      const updatedRollups = await tx.merchantSettlementRollup.updateMany({
        where: {
          id: { in: confirmedRollupIds },
          status: "SUBMITTED",
        },
        data: {
          status: "CONFIRMED",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (updatedRollups.count !== confirmedRollupIds.length) {
        throw new Error("Reconcile failed to update all confirmed settlement rollups.");
      }

      const updatedEarnings = await tx.merchantEarning.updateMany({
        where: {
          settlementRollupId: { in: confirmedRollupIds },
          status: "SUBMITTED",
        },
        data: {
          status: "CONFIRMED",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (updatedEarnings.count !== confirmedRollupEarningCount) {
        throw new Error("Reconcile failed to update all confirmed member earnings.");
      }
    }

    if (requeuedRollupIds.length > 0) {
      const updatedRollups = await tx.merchantSettlementRollup.updateMany({
        where: {
          id: { in: requeuedRollupIds },
          status: "SUBMITTED",
        },
        data: {
          status: "FAILED",
          allocatorBatchId: null,
          txHash: null,
          failureCode: "RECONCILE_REQUEUED",
          failureMessage: "Reconciliation did not find a confirmed on-chain settlement for this rollup.",
        },
      });
      if (updatedRollups.count !== requeuedRollupIds.length) {
        throw new Error("Reconcile failed to requeue all expected settlement rollups.");
      }

      const updatedEarnings = await tx.merchantEarning.updateMany({
        where: {
          settlementRollupId: { in: requeuedRollupIds },
          status: "SUBMITTED",
        },
        data: {
          status: "PENDING",
          settlementRollupId: null,
          allocatorBatchId: null,
          txHash: null,
          failureCode: "RECONCILE_REQUEUED",
          failureMessage: "Reconciliation did not find a confirmed on-chain settlement for this earning.",
        },
      });
      if (updatedEarnings.count !== requeuedRollupEarningCount) {
        throw new Error("Reconcile failed to requeue all expected member earnings.");
      }
    }

    if (confirmedLegacyRowIds.length > 0) {
      const updated = await tx.merchantEarning.updateMany({
        where: {
          id: { in: confirmedLegacyRowIds },
          status: "SUBMITTED",
        },
        data: {
          status: "CONFIRMED",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (updated.count !== confirmedLegacyRowIds.length) {
        throw new Error("Reconcile failed to update all confirmed legacy earnings.");
      }
    }

    if (requeuedLegacyRowIds.length > 0) {
      const updated = await tx.merchantEarning.updateMany({
        where: {
          id: { in: requeuedLegacyRowIds },
          status: "SUBMITTED",
        },
        data: {
          status: "PENDING",
          allocatorBatchId: null,
          txHash: null,
          failureCode: "RECONCILE_REQUEUED",
          failureMessage: "Reconciliation did not find a confirmed on-chain settlement for this earning.",
        },
      });
      if (updated.count !== requeuedLegacyRowIds.length) {
        throw new Error("Reconcile failed to requeue all expected legacy earnings.");
      }
    }

    for (const allocatorBatchId of touchedBatchIds) {
      const [persistedLegacyRows, persistedRollups] = await Promise.all([
        tx.merchantEarning.findMany({
          where: {
            allocatorBatchId,
            settlementRollupId: null,
          },
          select: { status: true },
        }),
        tx.merchantSettlementRollup.findMany({
          where: { allocatorBatchId },
          select: { status: true },
        }),
      ]);

      const rows: DerivedBatchRowState[] = [
        ...persistedLegacyRows.map((currentRow) => ({ status: currentRow.status })),
        ...persistedRollups.map((currentRow) => ({ status: currentRow.status })),
      ];

      const requeuedCountForBatch = requeuedBatchStateCounts.get(allocatorBatchId) ?? 0;
      for (let index = 0; index < requeuedCountForBatch; index += 1) {
        rows.push({ status: "FAILED" });
      }

      const nextBatchState = deriveBatchStatusUpdate(rows);
      if (!nextBatchState) continue;

      await tx.merchantSettlementBatch.update({
        where: { id: allocatorBatchId },
        data: nextBatchState,
      });
      updatedBatchCount += 1;
    }
  });

  return {
    ok: true,
    selectedCount: submittedRollups.length + submittedLegacyRows.length,
    confirmedCount,
    requeuedCount,
    stillSubmittedCount,
    updatedBatchCount,
  };
};
