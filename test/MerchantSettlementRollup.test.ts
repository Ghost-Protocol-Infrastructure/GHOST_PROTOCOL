import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSettlementRollupId } from "../lib/merchant-settlement";
import { buildMerchantSettlementRollupCandidates, type MerchantSettlementRollupSourceRow } from "../lib/merchant-settlement-rollup";

const makeRow = (
  overrides: Partial<MerchantSettlementRollupSourceRow> &
    Pick<MerchantSettlementRollupSourceRow, "id" | "settlementId" | "merchantOwnerAddress">,
): MerchantSettlementRollupSourceRow => ({
  id: overrides.id,
  settlementId: overrides.settlementId,
  merchantOwnerAddress: overrides.merchantOwnerAddress,
  grossWei: overrides.grossWei ?? 10_000_000_000_000n,
  feeWei: overrides.feeWei ?? 250_000_000_000n,
  netWei: overrides.netWei ?? 9_750_000_000_000n,
  createdAt: overrides.createdAt ?? new Date("2026-03-19T00:00:00.000Z"),
});

describe("merchant settlement rollup builder", () => {
  it("groups eligible rows by merchant owner and preserves exact sums", () => {
    const rows = [
      makeRow({
        id: "a-1",
        settlementId: `0x${"11".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
      }),
      makeRow({
        id: "a-2",
        settlementId: `0x${"12".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
      }),
      makeRow({
        id: "a-3",
        settlementId: `0x${"13".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
      }),
      makeRow({
        id: "b-1",
        settlementId: `0x${"21".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000bb",
        grossWei: 20_000_000_000_000n,
        feeWei: 500_000_000_000n,
        netWei: 19_500_000_000_000n,
      }),
      makeRow({
        id: "b-2",
        settlementId: `0x${"22".repeat(32)}`,
        merchantOwnerAddress: "0x00000000000000000000000000000000000000bb",
      }),
    ];

    const candidates = buildMerchantSettlementRollupCandidates(
      rows,
      {
        minFeeWei: 1n,
        maxAgeMs: 15 * 60_000,
        maxEarningsPerRollup: 100,
      },
      new Date("2026-03-19T00:10:00.000Z"),
    );

    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => candidate.merchantOwnerAddress), [
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
    ]);
    assert.equal(candidates[0]?.grossWei, 30_000_000_000_000n);
    assert.equal(candidates[0]?.feeWei, 750_000_000_000n);
    assert.equal(candidates[0]?.netWei, 29_250_000_000_000n);
    assert.equal(candidates[1]?.grossWei, 30_000_000_000_000n);
    assert.equal(candidates[1]?.feeWei, 750_000_000_000n);
    assert.equal(candidates[1]?.netWei, 29_250_000_000_000n);
  });

  it("releases a rollup immediately when cumulative fee crosses the threshold", () => {
    const candidates = buildMerchantSettlementRollupCandidates(
      [
        makeRow({
          id: "a-1",
          settlementId: `0x${"31".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
          feeWei: 500n,
          netWei: 9_999_999_999_500n,
        }),
        makeRow({
          id: "a-2",
          settlementId: `0x${"32".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
          feeWei: 600n,
          netWei: 9_999_999_999_400n,
        }),
      ],
      {
        minFeeWei: 1_000n,
        maxAgeMs: 15 * 60_000,
        maxEarningsPerRollup: 100,
      },
      new Date("2026-03-19T00:05:00.000Z"),
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.releaseReason, "FEE_THRESHOLD");
  });

  it("releases an old rollup via max-age even below the fee threshold", () => {
    const candidates = buildMerchantSettlementRollupCandidates(
      [
        makeRow({
          id: "aged-1",
          settlementId: `0x${"41".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
          createdAt: new Date("2026-03-19T00:00:00.000Z"),
          feeWei: 10n,
          netWei: 9_999_999_999_990n,
        }),
      ],
      {
        minFeeWei: 1_000n,
        maxAgeMs: 15 * 60_000,
        maxEarningsPerRollup: 100,
      },
      new Date("2026-03-19T00:20:00.000Z"),
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.releaseReason, "MAX_AGE");
  });

  it("caps each merchant rollup by the configured maximum earning count", () => {
    const candidates = buildMerchantSettlementRollupCandidates(
      [
        makeRow({
          id: "row-1",
          settlementId: `0x${"51".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
        }),
        makeRow({
          id: "row-2",
          settlementId: `0x${"52".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
        }),
        makeRow({
          id: "row-3",
          settlementId: `0x${"53".repeat(32)}`,
          merchantOwnerAddress: "0x00000000000000000000000000000000000000aa",
        }),
      ],
      {
        minFeeWei: 1n,
        maxAgeMs: 15 * 60_000,
        maxEarningsPerRollup: 2,
      },
      new Date("2026-03-19T00:05:00.000Z"),
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.earningCount, 2);
    assert.deepEqual(candidates[0]?.earningIds, ["row-1", "row-2"]);
  });
});

describe("merchant settlement rollup ids", () => {
  it("uses a namespaced settlement id that cannot collide with raw event ids accidentally", () => {
    const rollupA = buildSettlementRollupId({ rollupId: "rollup-alpha" });
    const rollupB = buildSettlementRollupId({ rollupId: "rollup-beta" });

    assert.notEqual(rollupA, rollupB);
    assert.match(rollupA, /^0x[0-9a-f]{64}$/);
    assert.match(rollupB, /^0x[0-9a-f]{64}$/);
  });
});
