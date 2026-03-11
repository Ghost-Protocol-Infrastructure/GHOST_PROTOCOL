import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFulfillmentCaptureSettlementId,
  buildGateSettlementId,
  calculateSettlementAmounts,
} from "../lib/merchant-settlement";

describe("merchant settlement helpers", () => {
  it("builds deterministic and cross-type-safe settlement ids", () => {
    const gateA = buildGateSettlementId({
      walletAddress: "0x00000000000000000000000000000000000000aa",
      requestId: "gate-123",
    });
    const gateB = buildGateSettlementId({
      walletAddress: "0x00000000000000000000000000000000000000aa",
      requestId: "gate-123",
    });
    const gateDifferent = buildGateSettlementId({
      walletAddress: "0x00000000000000000000000000000000000000aa",
      requestId: "gate-456",
    });
    const fulfillment = buildFulfillmentCaptureSettlementId({
      ticketId: "ticket-123",
    });

    assert.equal(gateA, gateB);
    assert.notEqual(gateA, gateDifferent);
    assert.notEqual(gateA, fulfillment);
  });

  it("converts gross credits into gross, fee, and net wei using the locked credit price", () => {
    const result = calculateSettlementAmounts({
      grossCredits: 4n,
      feeBps: 500,
    });

    assert.equal(result.creditPriceWei, 10_000_000_000_000n);
    assert.equal(result.grossWei, 40_000_000_000_000n);
    assert.equal(result.feeWei, 2_000_000_000_000n);
    assert.equal(result.netWei, 38_000_000_000_000n);
  });
});
