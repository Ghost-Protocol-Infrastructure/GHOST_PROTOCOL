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

const deriveBatchStatusUpdate = (
  rows: DerivedBatchRowState[],
): BatchStatusUpdate | null => {
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
    failureMessage: "One or more submitted earnings were re-queued or failed during reconciliation.",
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

  const submittedRows = await prisma.merchantEarning.findMany({
    where: {
      status: "SUBMITTED",
      ...(batchId ? { allocatorBatchId: batchId } : {}),
      ...(settlementId ? { settlementId } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      settlementId: true,
      txHash: true,
      allocatorBatchId: true,
    },
  });

  const uniqueTxHashes = Array.from(
    new Set(
      submittedRows
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
  const confirmedRowIds: string[] = [];
  const requeuedRowIds: string[] = [];

  for (const row of submittedRows) {
    const processedOnChain = await readProcessedSettlementId(client, row.settlementId);
    const receipt = row.txHash ? receiptCache.get(row.txHash.toLowerCase()) : undefined;
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain,
      receiptStatus: receipt?.status ?? "missing",
      confirmations: receipt?.confirmations ?? 0,
      minConfirmations: input.config.minConfirmations,
    });

    if (outcome === "confirmed") {
      confirmedCount += 1;
      confirmedRowIds.push(row.id);
      if (row.allocatorBatchId) {
        touchedBatchIds.add(row.allocatorBatchId);
      }
      continue;
    }

    if (outcome === "requeue") {
      requeuedCount += 1;
      requeuedRowIds.push(row.id);
      if (row.allocatorBatchId) {
        touchedBatchIds.add(row.allocatorBatchId);
        requeuedBatchStateCounts.set(
          row.allocatorBatchId,
          (requeuedBatchStateCounts.get(row.allocatorBatchId) ?? 0) + 1,
        );
      }
      continue;
    }

    stillSubmittedCount += 1;
    if (row.allocatorBatchId) {
      touchedBatchIds.add(row.allocatorBatchId);
    }
  }

  let updatedBatchCount = 0;
  await prisma.$transaction(async (tx) => {
    if (confirmedRowIds.length > 0) {
      const updated = await tx.merchantEarning.updateMany({
        where: {
          id: { in: confirmedRowIds },
          status: "SUBMITTED",
        },
        data: {
          status: "CONFIRMED",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (updated.count !== confirmedRowIds.length) {
        throw new Error("Reconcile failed to update all confirmed earnings.");
      }
    }

    if (requeuedRowIds.length > 0) {
      const updated = await tx.merchantEarning.updateMany({
        where: {
          id: { in: requeuedRowIds },
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
      if (updated.count !== requeuedRowIds.length) {
        throw new Error("Reconcile failed to requeue all expected earnings.");
      }
    }

    for (const allocatorBatchId of touchedBatchIds) {
      const persistedRows = await tx.merchantEarning.findMany({
        where: { allocatorBatchId },
        select: { status: true },
      });
      const rows: DerivedBatchRowState[] = persistedRows.map((currentRow) => ({
        status: currentRow.status,
      }));
      const requeuedCountForBatch = requeuedBatchStateCounts.get(allocatorBatchId) ?? 0;
      for (let index = 0; index < requeuedCountForBatch; index += 1) {
        rows.push({ status: "PENDING" });
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
    selectedCount: submittedRows.length,
    confirmedCount,
    requeuedCount,
    stillSubmittedCount,
    updatedBatchCount,
  };
};
