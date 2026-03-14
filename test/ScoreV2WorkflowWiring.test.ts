import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("score-v2 package scripts and workflow use split refresh/snapshot commands", async () => {
  const packageJson = await readText("package.json");
  const workflowSource = await readText(".github/workflows/score-v2-shadow.yml");

  assert.match(packageJson, /"score:v2:refresh":\s*"npx tsx scripts\/score-v2\.ts --refresh-only"/);
  assert.match(packageJson, /"score:v2:snapshot":\s*"npx tsx scripts\/score-v2\.ts --snapshot-only"/);
  assert.match(workflowSource, /run:\s+npm run score:v2:refresh/);
  assert.match(workflowSource, /run:\s+npm run score:v2:snapshot/);
});
