import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("score-v2 and rank page honor attributed GhostWire evidence without status claims", async () => {
  const scoreSource = await readText("scripts/score-v2.ts");
  const rankPageSource = await readText("app/(app)/rank/page.tsx");

  assert.match(scoreSource, /hasAttributedWireEvidence/);
  assert.match(scoreSource, /const canUseWireMetrics = \(input: ScoreInputRow\): boolean =>/);
  assert.match(scoreSource, /input\.isClaimed \|\|[\s\S]*hasAttributedWireEvidence/);
  assert.match(scoreSource, /const baselineReputation = roundToTwo\(Math\.min\(velocityNorm, UNCLAIMED_REPUTATION_CAP\)\)/);
  assert.match(scoreSource, /Math\.max\(baselineReputation, railScore\?\.reputation \?\? 0\)/);
  assert.match(scoreSource, /Math\.max\(baselineRankScore, railScore\?\.rankScore \?\? 0\)/);
  assert.match(rankPageSource, /wireYieldValue:\s*rawWireYield/);
});
