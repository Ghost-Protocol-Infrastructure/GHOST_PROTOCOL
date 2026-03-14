import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

test("score-v2 tx fetch failures preserve prior txCount values instead of overwriting with zero", async () => {
  const source = await readText("scripts/score-v2.ts");

  assert.doesNotMatch(source, /txCountBySourceAddressLower\.set\(sourceAddressLower,\s*0\)/);
  assert.match(source, /Preserving previous txCount value\./);
});
