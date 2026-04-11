import assert from "node:assert/strict";
import test from "node:test";
import {
  blendRailReputation,
  computeCommerceQuality,
  computeExpressReputation,
  computeExpressConfidence,
  computeReadinessBonus,
  computeRankScore,
  computeWireReputation,
  hasMeasuredExpressCommerceEvidence,
} from "../lib/ghostrank-rail-score";

test("commerce quality weights completed/rejected/expired correctly", () => {
  const score = computeCommerceQuality({
    completedCount: 7,
    rejectedCount: 2,
    expiredCount: 1,
    volumeConfidence: 0.5,
    depthConfidence: 1,
  });

  assert.equal(score, 64.8);
});

test("express and wire reputation sub-scores use the expected weighting", () => {
  assert.equal(computeExpressReputation(90, 40), 72.5);
  assert.equal(computeWireReputation(84, 40), 70.8);
});

test("uptime-only express does not count as measured commerce evidence", () => {
  assert.equal(
    hasMeasuredExpressCommerceEvidence({
      usageAuthorizedCount7d: 0,
      expressYield: 0,
    }),
    false,
  );
  assert.equal(
    computeExpressConfidence({
      usageAuthorizedCount7d: 0,
      uptime: 100,
      expressYield: 0,
    }),
    0,
  );
});

test("measured express usage still retains confidence without yield", () => {
  assert.equal(
    hasMeasuredExpressCommerceEvidence({
      usageAuthorizedCount7d: 4,
      expressYield: 0,
    }),
    true,
  );
  assert.equal(
    computeExpressConfidence({
      usageAuthorizedCount7d: 4,
      uptime: 100,
      expressYield: 0,
    }),
    0.65,
  );
});

test("hybrid blend follows confidence weights", () => {
  const reputation = blendRailReputation({
    expressReputation: 82,
    expressConfidence: 0.9,
    x402Reputation: null,
    x402Confidence: 0,
    wireReputation: 60,
    wireConfidence: 0.3,
  });

  assert.equal(reputation, 76.5);
});

test("rank score preserves anti-wash deduction", () => {
  const rank = computeRankScore({
    reputation: 80,
    velocity: 50,
    antiWashPenalty: 6,
  });

  assert.equal(rank, 65);
});

test("readiness bonus is bounded and status-based", () => {
  assert.equal(computeReadinessBonus("LIVE"), 4);
  assert.equal(computeReadinessBonus("DEGRADED"), 2);
  assert.equal(computeReadinessBonus("CONFIGURED"), 1);
  assert.equal(computeReadinessBonus("UNCONFIGURED"), 0);
});
