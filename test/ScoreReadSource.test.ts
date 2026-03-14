import assert from "node:assert/strict";
import test from "node:test";

import { resolveScoreReadSource } from "../lib/score-read-source";

test("prefers explicit snapshot score read source", () => {
  assert.equal(resolveScoreReadSource("snapshot", "false"), "snapshot");
});

test("prefers explicit agent score read source", () => {
  assert.equal(resolveScoreReadSource("agent", "true"), "agent");
});

test("falls back to legacy snapshot flag when explicit score read source is unset", () => {
  assert.equal(resolveScoreReadSource(undefined, "true"), "snapshot");
  assert.equal(resolveScoreReadSource(undefined, "false"), "agent");
});

test("ignores invalid explicit score read source values", () => {
  assert.equal(resolveScoreReadSource("invalid", "true"), "snapshot");
  assert.equal(resolveScoreReadSource("invalid", "false"), "agent");
});
