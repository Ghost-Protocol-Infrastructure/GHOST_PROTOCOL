import { getAddress, type Address } from "viem";
import type { MerchantSettlementRollupConfig } from "./merchant-settlement-config";

export type MerchantSettlementRollupReleaseReason = "FEE_THRESHOLD" | "MAX_AGE";

export type MerchantSettlementRollupSourceRow = {
  id: string;
  settlementId: string;
  merchantOwnerAddress: Address | string;
  grossWei: bigint;
  feeWei: bigint;
  netWei: bigint;
  createdAt: Date;
};

export type MerchantSettlementRollupCandidate = {
  merchantOwnerAddress: string;
  earningIds: string[];
  earningSettlementIds: string[];
  grossWei: bigint;
  feeWei: bigint;
  netWei: bigint;
  earningCount: number;
  oldestCreatedAt: Date;
  newestCreatedAt: Date;
  releaseReason: MerchantSettlementRollupReleaseReason;
};

const normalizeMerchantOwnerAddress = (value: Address | string): string => getAddress(value).toLowerCase();

const compareRows = (a: MerchantSettlementRollupSourceRow, b: MerchantSettlementRollupSourceRow): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

export const buildMerchantSettlementRollupCandidates = (
  rows: MerchantSettlementRollupSourceRow[],
  config: MerchantSettlementRollupConfig,
  now = new Date(),
): MerchantSettlementRollupCandidate[] => {
  if (config.maxEarningsPerRollup <= 0) return [];

  const sortedRows = [...rows].sort(compareRows);
  const groupedRows = new Map<string, MerchantSettlementRollupSourceRow[]>();

  for (const row of sortedRows) {
    const merchantOwnerAddress = normalizeMerchantOwnerAddress(row.merchantOwnerAddress);
    const existing = groupedRows.get(merchantOwnerAddress) ?? [];
    if (existing.length >= config.maxEarningsPerRollup) {
      continue;
    }
    existing.push({
      ...row,
      merchantOwnerAddress,
      settlementId: row.settlementId.trim().toLowerCase(),
    });
    groupedRows.set(merchantOwnerAddress, existing);
  }

  const candidates: MerchantSettlementRollupCandidate[] = [];
  const maxAgeThresholdMs = now.getTime() - config.maxAgeMs;

  for (const [merchantOwnerAddress, merchantRows] of groupedRows.entries()) {
    if (merchantRows.length === 0) continue;

    let grossWei = 0n;
    let feeWei = 0n;
    let netWei = 0n;
    for (const row of merchantRows) {
      grossWei += row.grossWei;
      feeWei += row.feeWei;
      netWei += row.netWei;
    }

    const oldestCreatedAt = merchantRows[0]!.createdAt;
    const newestCreatedAt = merchantRows[merchantRows.length - 1]!.createdAt;
    const releaseReason =
      feeWei >= config.minFeeWei
        ? "FEE_THRESHOLD"
        : oldestCreatedAt.getTime() <= maxAgeThresholdMs
          ? "MAX_AGE"
          : null;

    if (releaseReason == null) {
      continue;
    }

    candidates.push({
      merchantOwnerAddress,
      earningIds: merchantRows.map((row) => row.id),
      earningSettlementIds: merchantRows.map((row) => row.settlementId),
      grossWei,
      feeWei,
      netWei,
      earningCount: merchantRows.length,
      oldestCreatedAt,
      newestCreatedAt,
      releaseReason,
    });
  }

  return candidates.sort(
    (a, b) =>
      a.oldestCreatedAt.getTime() - b.oldestCreatedAt.getTime() ||
      a.merchantOwnerAddress.localeCompare(b.merchantOwnerAddress),
  );
};
