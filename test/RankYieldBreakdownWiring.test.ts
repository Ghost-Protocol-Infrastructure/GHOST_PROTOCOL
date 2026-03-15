import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("rank page and agents api expose express and wire yield breakdown fields", async () => {
  const rankPageSource = await readText("app/(app)/rank/page.tsx");
  const routeSource = await readText("app/api/agents/route.ts");

  assert.match(rankPageSource, /expressYield/);
  assert.match(rankPageSource, /wireYield/);
  assert.match(rankPageSource, /formatYieldBreakdown\("GhostGate"/);
  assert.match(rankPageSource, /formatYieldBreakdown\("GhostWire"/);

  assert.match(routeSource, /expressYield:/);
  assert.match(routeSource, /wireYield:/);
});
