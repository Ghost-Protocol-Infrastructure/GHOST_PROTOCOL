import assert from "node:assert/strict";
import test from "node:test";
import { hasAttributedWireEvidence, isClaimedAgent } from "../lib/agent-claim";

test("wire-only attributed evidence is recognized even without claimed status", () => {
  assert.equal(
    hasAttributedWireEvidence({
      wireYieldValue: 0.00975,
    }),
    true,
  );

  assert.equal(
    isClaimedAgent({
      status: "active",
      tier: "NEW",
      yieldValue: 0,
      uptimeValue: 0,
      wireYieldValue: 0.00975,
    }),
    true,
  );
});

test("completed attributed GhostWire jobs with zero yield still count as proof", () => {
  assert.equal(
    hasAttributedWireEvidence({
      wireCompletedCount: 1,
      wireYieldValue: 0,
      wireSettledPrincipalValue: 0n,
      wireSettledProviderEarningsValue: 0n,
    }),
    true,
  );
});

test("agents without status, tier, express, or wire proof remain unclaimed", () => {
  assert.equal(
    isClaimedAgent({
      status: "active",
      tier: "NEW",
      yieldValue: 0,
      uptimeValue: 0,
      wireYieldValue: 0,
      wireCompletedCount: 0,
      wireRejectedCount: 0,
      wireExpiredCount: 0,
      wireSettledPrincipalValue: 0n,
      wireSettledProviderEarningsValue: 0n,
    }),
    false,
  );
});
