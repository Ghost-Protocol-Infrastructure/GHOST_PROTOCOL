import assert from "node:assert/strict";
import test from "node:test";
import {
  blendRailReputation,
  computeCommerceQuality,
  computeExpressReputation,
  computeRankScore,
  computeWireReputation,
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

test("hybrid blend follows confidence weights", () => {
  const reputation = blendRailReputation({
    expressReputation: 82,
    expressConfidence: 0.9,
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
