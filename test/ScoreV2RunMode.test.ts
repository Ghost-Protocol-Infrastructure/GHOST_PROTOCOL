import assert from "node:assert/strict";
import test from "node:test";

import { resolveScoreV2RunMode } from "../lib/score-v2-run-mode";

test("defaults score-v2 to full mode", () => {
  assert.equal(resolveScoreV2RunMode([]), "full");
});

test("supports refresh-only score-v2 mode", () => {
  assert.equal(resolveScoreV2RunMode(["--refresh-only"]), "refresh-only");
});

test("supports snapshot-only score-v2 mode", () => {
  assert.equal(resolveScoreV2RunMode(["--snapshot-only"]), "snapshot-only");
});

test("rejects incompatible score-v2 modes", () => {
  assert.throws(() => resolveScoreV2RunMode(["--refresh-only", "--snapshot-only"]), /mutually exclusive/i);
});
