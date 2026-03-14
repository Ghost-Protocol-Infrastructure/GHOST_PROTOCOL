import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("runtime score readers are wired to the new snapshot lookup and rollback flag helpers", async () => {
  const routeSource = await readText("app/api/agents/route.ts");
  const agentPageSource = await readText("app/(app)/agent/[id]/page.tsx");

  assert.match(routeSource, /resolveScoreReadSource/);
  assert.match(agentPageSource, /resolveScoreReadSource/);
  assert.match(agentPageSource, /findActiveSnapshotScoreByAgentId/);
});
