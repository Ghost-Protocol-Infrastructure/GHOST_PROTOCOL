import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("score-v2 applies readiness bonus at final rank score, not rail reputation", async () => {
  const source = await readText("scripts/score-v2.ts");

  assert.match(source, /computeReadinessBonus/);
  assert.match(source, /const readinessStatus = readinessStatusByAgentId\.get\(input\.agentId\) \?\? "UNCONFIGURED"/);
  assert.match(source, /const readinessBonus = computeReadinessBonus\(readinessStatus\)/);
  assert.match(source, /const adjustedRankScore = roundToTwo\(clamp\(rankScore \+ readinessBonus, 0, 100\)\)/);
  assert.match(source, /rankScore: adjustedRankScore/);
  assert.doesNotMatch(source, /reputation:\s*adjustedRankScore/);
});

test("score-v2 loads readiness statuses from gateway configs during snapshot ranking", async () => {
  const source = await readText("scripts/score-v2.ts");

  assert.match(source, /prisma\.agentGatewayConfig\.findMany/);
  assert.match(source, /select:\s*{[\s\S]*agentId:\s*true,[\s\S]*readinessStatus:\s*true/);
  assert.match(source, /buildSnapshotRows\(\s*inputs,\s*gateSybilSignals,\s*readinessStatusByAgentId,\s*\)/);
});
