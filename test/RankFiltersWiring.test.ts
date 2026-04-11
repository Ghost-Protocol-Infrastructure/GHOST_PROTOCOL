import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("rank page wires V1 filters and URL params into the agents fetch", async () => {
  const rankPageSource = await readText("app/(app)/rank/page.tsx");

  assert.match(rankPageSource, /params\.set\("rail"/);
  assert.match(rankPageSource, /params\.set\("readiness"/);
  assert.match(rankPageSource, /params\.set\("trust"/);
  assert.match(rankPageSource, /router\.replace/);
  assert.match(rankPageSource, /Clear Filters/);
  assert.match(rankPageSource, /Sort/);
});
