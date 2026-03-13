import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGhostWireProviderRollup,
  deriveWireDepthConfidence,
  deriveWireVolumeConfidence,
} from "../lib/ghostwire-score-rollup";

test("wire depth confidence ramps with terminal jobs", () => {
  assert.equal(deriveWireDepthConfidence(0), 0);
  assert.equal(deriveWireDepthConfidence(5), 0.5);
  assert.equal(deriveWireDepthConfidence(12), 1);
});

test("wire volume confidence is normalized against the observed max", () => {
  const confidence = deriveWireVolumeConfidence(25_000000n, 100_000000n);
  assert.equal(confidence > 0, true);
  assert.equal(confidence < 1, true);
});

test("ghostwire rollup computes 30d provider quality and confidence", () => {
  const result = buildGhostWireProviderRollup({
    providerAgentId: "18755",
    completedCount: 8,
    rejectedCount: 1,
    expiredCount: 1,
    settledPrincipalAtomic: 25_000000n,
    settledProviderEarningsAtomic: 24_375000n,
    maxSettledPrincipalAtomic: 25_000000n,
  });

  assert.equal(result.providerAgentId, "18755");
  assert.equal(result.terminalJobs, 10);
  assert.equal(result.commerceQuality > 0, true);
  assert.equal(result.wireConfidence > 0, true);
  assert.equal(result.wireYield, 24.375);
});
