import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildScoreV2RailMetricFields,
  scoreV2RailMetricFieldsChanged,
} from "../lib/score-v2-rail-sync";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("builds zeroed rail metrics when no GhostWire rollup exists", () => {
  assert.deepEqual(buildScoreV2RailMetricFields(), {
    wireYield: 0,
    commerceQuality: 0,
    wireConfidence: 0,
    wireCompletedCount30d: 0,
    wireRejectedCount30d: 0,
    wireExpiredCount30d: 0,
    wireSettledPrincipal30d: 0n,
    wireSettledProviderEarnings30d: 0n,
  });
});

test("rail metric delta returns false when persisted and computed wire fields match", () => {
  const next = buildScoreV2RailMetricFields({
    wireYield: 24.375,
    commerceQuality: 72.4,
    wireConfidence: 0.8,
    completedCount: 8,
    rejectedCount: 1,
    expiredCount: 1,
    settledPrincipalAmount: 25_000000n,
    settledProviderEarnings: 24_375000n,
  });

  assert.equal(scoreV2RailMetricFieldsChanged(next, next), false);
});

test("rail metric delta returns true when any wire field differs", () => {
  const current = buildScoreV2RailMetricFields({
    wireYield: 24.375,
    commerceQuality: 72.4,
    wireConfidence: 0.8,
    completedCount: 8,
    rejectedCount: 1,
    expiredCount: 1,
    settledPrincipalAmount: 25_000000n,
    settledProviderEarnings: 24_375000n,
  });
  const next = buildScoreV2RailMetricFields({
    wireYield: 30,
    commerceQuality: 80,
    wireConfidence: 0.9,
    completedCount: 9,
    rejectedCount: 1,
    expiredCount: 0,
    settledPrincipalAmount: 32_000000n,
    settledProviderEarnings: 30_000000n,
  });

  assert.equal(scoreV2RailMetricFieldsChanged(current, next), true);
});

test("score-v2 rail sync skips non-wire rewrites and records rail metric update counts", async () => {
  const source = await readText("scripts/score-v2.ts");
  const syncSectionMatch = source.match(/const syncRailMetricsToScoreInputs[\s\S]*?const buildSnapshotRows/);

  assert.ok(syncSectionMatch, "expected syncRailMetricsToScoreInputs section to exist");
  const syncSection = syncSectionMatch[0];

  assert.match(syncSection, /scoreV2RailMetricFieldsChanged/);
  assert.doesNotMatch(syncSection, /\byield:\s*Math\.max/);
  assert.doesNotMatch(syncSection, /\bexpressYield:\s*Math\.max/);
  assert.doesNotMatch(syncSection, /\buptime:\s*clamp/);
  assert.match(source, /last_rail_metric_rows_updated/);
  assert.match(source, /rail_metric_rows_updated=/);
});
