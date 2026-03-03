import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMerchantAllocationBatch,
  determineSettlementReconciliationOutcome,
  resolveAllocatorSelectionLimit,
  selectPendingMerchantEarningsForAllocation,
  type MerchantEarningAllocationCandidate,
} from "../lib/merchant-settlement-allocator";

const makeCandidate = (
  overrides: Partial<MerchantEarningAllocationCandidate> & Pick<MerchantEarningAllocationCandidate, "id" | "settlementId">,
): MerchantEarningAllocationCandidate => ({
  id: overrides.id,
  settlementId: overrides.settlementId,
  merchantOwnerAddress: overrides.merchantOwnerAddress ?? "0x00000000000000000000000000000000000000aa",
  grossWei: overrides.grossWei ?? 10_000_000_000_000n,
  feeWei: overrides.feeWei ?? 250_000_000_000n,
  netWei: overrides.netWei ?? 9_750_000_000_000n,
  createdAt: overrides.createdAt ?? new Date("2026-03-01T00:00:00.000Z"),
});

describe("merchant settlement allocator helpers", () => {
  it("selects the oldest pending rows first within batch and gas limits", () => {
    const selected = selectPendingMerchantEarningsForAllocation(
      [
        makeCandidate({
          id: "late",
          settlementId: `0x${"33".repeat(32)}`,
          createdAt: new Date("2026-03-01T03:00:00.000Z"),
        }),
        makeCandidate({
          id: "first",
          settlementId: `0x${"11".repeat(32)}`,
          createdAt: new Date("2026-03-01T01:00:00.000Z"),
        }),
        makeCandidate({
          id: "second",
          settlementId: `0x${"22".repeat(32)}`,
          createdAt: new Date("2026-03-01T02:00:00.000Z"),
        }),
      ],
      {
        maxBatchSize: 10,
        gasBudgetPerRun: 360_000n,
        gasEstimatePerSettlement: 120_000n,
      },
    );

    assert.deepEqual(
      selected.map((row) => row.id),
      ["first", "second", "late"],
    );
  });

  it("caps selection by the lower of batch size and gas budget", () => {
    const limit = resolveAllocatorSelectionLimit({
      maxBatchSize: 5,
      gasBudgetPerRun: 250_000n,
      gasEstimatePerSettlement: 120_000n,
    });

    assert.equal(limit, 2);
  });

  it("builds a contract batch payload from claimed earnings", () => {
    const payload = buildMerchantAllocationBatch([
      makeCandidate({
        id: "first",
        settlementId: `0x${"44".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000bb",
      }),
      makeCandidate({
        id: "second",
        settlementId: `0x${"55".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000cc",
        grossWei: 20_000_000_000_000n,
        feeWei: 500_000_000_000n,
        netWei: 19_500_000_000_000n,
      }),
    ]);

    assert.deepEqual(payload.merchants, [
      "0x00000000000000000000000000000000000000bb",
      "0x00000000000000000000000000000000000000cc",
    ]);
    assert.deepEqual(payload.grossAmounts, [10_000_000_000_000n, 20_000_000_000_000n]);
    assert.deepEqual(payload.feeAmounts, [250_000_000_000n, 500_000_000_000n]);
    assert.deepEqual(payload.settlementIds, [`0x${"44".repeat(32)}`, `0x${"55".repeat(32)}`]);
    assert.equal(payload.totalGrossWei, 30_000_000_000_000n);
    assert.equal(payload.totalFeeWei, 750_000_000_000n);
    assert.equal(payload.totalNetWei, 29_250_000_000_000n);
  });
});

describe("merchant settlement reconciliation decisions", () => {
  it("confirms a settlement when the chain has processed the settlement id", () => {
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain: true,
      receiptStatus: "missing",
      confirmations: 0,
      minConfirmations: 2,
    });

    assert.equal(outcome, "confirmed");
  });

  it("keeps a submitted earning in-flight until confirmations clear", () => {
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain: false,
      receiptStatus: "success",
      confirmations: 1,
      minConfirmations: 2,
    });

    assert.equal(outcome, "keep_submitted");
  });

  it("requeues an unsettled earning when the tracked submission reverted", () => {
    const outcome = determineSettlementReconciliationOutcome({
      processedOnChain: false,
      receiptStatus: "reverted",
      confirmations: 0,
      minConfirmations: 2,
    });

    assert.equal(outcome, "requeue");
  });
});
