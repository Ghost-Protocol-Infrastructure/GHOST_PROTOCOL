import assert from "node:assert/strict";
import test from "node:test";
import { scoreAgentRailAware } from "../lib/ghostrank-rail-score";

test("wire-only agent is not punished for missing express signals", () => {
  const result = scoreAgentRailAware({
    velocity: 55,
    antiWashPenalty: 0,
    express: null,
    x402: null,
    wire: {
      commerceQuality: 84,
      wireYieldNorm: 40,
      confidence: 0.8,
    },
  });

  assert.equal(result.expressReputation, null);
  assert.equal(result.wireReputation, 70.8);
  assert.equal(result.reputation, 70.8);
  assert.equal(result.railMode, "WIRE");
});

test("express-only agent is not punished for missing wire signals", () => {
  const result = scoreAgentRailAware({
    velocity: 48,
    antiWashPenalty: 0,
    express: {
      uptime: 91,
      expressYieldNorm: 30,
      confidence: 0.75,
    },
    x402: null,
    wire: null,
  });

  assert.equal(result.wireReputation, null);
  assert.equal(result.expressReputation, 69.65);
  assert.equal(result.reputation, 69.65);
  assert.equal(result.railMode, "EXPRESS");
});

test("hybrid agent blends both rail reputations by confidence", () => {
  const result = scoreAgentRailAware({
    velocity: 62,
    antiWashPenalty: 4,
    express: {
      uptime: 90,
      expressYieldNorm: 40,
      confidence: 0.9,
    },
    x402: null,
    wire: {
      commerceQuality: 84,
      wireYieldNorm: 40,
      confidence: 0.3,
    },
  });

  assert.equal(result.reputation, 72.08);
  assert.equal(result.rankScore, 65.06);
  assert.equal(result.railMode, "HYBRID");
});

test("x402-only agent can earn x402 rail reputation without express or wire inputs", () => {
  const result = scoreAgentRailAware({
    velocity: 58,
    antiWashPenalty: 0,
    express: null,
    x402: {
      breadthScore: 72,
      repeatScore: 64,
      x402YieldNorm: 55,
      successRate: 96,
      uptime: 93,
      concentrationPenalty: 8,
      confidence: 0.82,
    },
    wire: null,
  });

  assert.equal(result.expressReputation, null);
  assert.equal(result.wireReputation, null);
  assert.equal(result.x402Reputation, 64.3);
  assert.equal(result.reputation, 64.3);
  assert.equal(result.railMode, "X402");
});
