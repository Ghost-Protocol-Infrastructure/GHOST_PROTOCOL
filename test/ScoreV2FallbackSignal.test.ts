import assert from "node:assert/strict";
import test from "node:test";

import {
  FALLBACK_PROXY_TX_SIGNAL_CAP,
  computeFallbackProxyTxSignal,
  resolveScoreV2Tier,
} from "../lib/score-v2-fallback-signal";

test("caps single-wallet fallback tx strength below full onchain proof", () => {
  assert.equal(computeFallbackProxyTxSignal(100, 1), FALLBACK_PROXY_TX_SIGNAL_CAP);
});

test("damps shared fallback tx strength as more agents share the same wallet", () => {
  assert.equal(computeFallbackProxyTxSignal(100, 4), 15);
  assert.equal(computeFallbackProxyTxSignal(100, 16), 7.5);
});

test("fallback-only agents never escalate into whale or active trust tiers", () => {
  assert.equal(resolveScoreV2Tier(678_964, false, "OWNER_FALLBACK"), "NEW");
  assert.equal(resolveScoreV2Tier(5, false, "CREATOR_FALLBACK"), "NEW");
  assert.equal(resolveScoreV2Tier(0, false, "OWNER_FALLBACK"), "GHOST");
});

test("measured tx sources keep the existing tier thresholds", () => {
  assert.equal(resolveScoreV2Tier(700, false, "AGENT_ONCHAIN"), "WHALE");
  assert.equal(resolveScoreV2Tier(75, true, "USAGE_ACTIVITY_7D"), "ACTIVE");
  assert.equal(resolveScoreV2Tier(5, false, "AGENT_ONCHAIN"), "NEW");
});
