import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildTargetedAgentGatewayRecheckWhere,
  getSelectedLiveAgentIdsForStaleSweep,
  shouldRunAgentGatewayStaleSweep,
} from "../app/api/agent-gateway/recheck/route";
import {
  computeAgentGatewaySchedulerStaleAfterMs,
  splitAgentGatewayRecheckLimit,
} from "../lib/agent-gateway-canary";

const readText = async (relativePath: string): Promise<string> =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("agent gateway recheck scheduling", () => {
  it("extends the stale window when the live fleet requires multiple scheduled runs", () => {
    const staleAfterMs = computeAgentGatewaySchedulerStaleAfterMs({
      configuredStaleAfterMs: 60 * 60 * 1000,
      liveConfigCount: 80,
      liveRecheckLimit: 50,
      recheckIntervalMs: 30 * 60 * 1000,
      staleBufferRuns: 2,
    });

    assert.equal(staleAfterMs, 4 * 30 * 60 * 1000);
  });

  it("keeps the configured stale window when it is already higher than the scheduler floor", () => {
    const staleAfterMs = computeAgentGatewaySchedulerStaleAfterMs({
      configuredStaleAfterMs: 6 * 60 * 60 * 1000,
      liveConfigCount: 10,
      liveRecheckLimit: 100,
      recheckIntervalMs: 30 * 60 * 1000,
      staleBufferRuns: 2,
    });

    assert.equal(staleAfterMs, 6 * 60 * 60 * 1000);
  });

  it("allocates most slots to live configs while leaving bounded retry room for degraded configs", () => {
    const plan = splitAgentGatewayRecheckLimit({
      limit: 50,
      liveCount: 40,
      degradedCount: 500,
      degradedReserveRatio: 0.2,
    });

    assert.deepEqual(plan, {
      liveLimit: 40,
      degradedLimit: 10,
    });
  });

  it("fills spare capacity with degraded retries when the live fleet is small", () => {
    const plan = splitAgentGatewayRecheckLimit({
      limit: 50,
      liveCount: 5,
      degradedCount: 500,
      degradedReserveRatio: 0.2,
    });

    assert.deepEqual(plan, {
      liveLimit: 5,
      degradedLimit: 45,
    });
  });

  it("runs stale sweeps only when the live-freshness pass is included", () => {
    assert.equal(shouldRunAgentGatewayStaleSweep(["LIVE"]), true);
    assert.equal(shouldRunAgentGatewayStaleSweep(["LIVE", "DEGRADED"]), true);
    assert.equal(shouldRunAgentGatewayStaleSweep(["DEGRADED"]), false);
  });

  it("respects readiness filters for targeted agent rechecks", () => {
    assert.deepEqual(buildTargetedAgentGatewayRecheckWhere("18755", ["DEGRADED"]), {
      agentId: "18755",
      readinessStatus: { in: ["DEGRADED"] },
    });
  });

  it("protects only the selected live batch from stale demotion", () => {
    assert.deepEqual(
      getSelectedLiveAgentIdsForStaleSweep([
        { agentId: "live-1", readinessStatus: "LIVE" },
        { agentId: "degraded-1", readinessStatus: "DEGRADED" },
        { agentId: "live-2", readinessStatus: "LIVE" },
      ]),
      ["live-1", "live-2"],
    );
  });

  it("runs stale demotion after live selection and excludes selected live agent ids", async () => {
    const source = await readText("app/api/agent-gateway/recheck/route.ts");

    assert.match(source, /const selectedLiveAgentIds = getSelectedLiveAgentIdsForStaleSweep\(liveConfigs\);/);
    assert.match(source, /excludeAgentIds: selectedLiveAgentIds/);

    const liveSelectionIndex = source.indexOf("const selectedLiveAgentIds = getSelectedLiveAgentIdsForStaleSweep(liveConfigs);");
    const staleSweepIndex = source.indexOf("const staleSweep = shouldRunStaleSweep");

    assert.notEqual(liveSelectionIndex, -1);
    assert.notEqual(staleSweepIndex, -1);
    assert.ok(liveSelectionIndex < staleSweepIndex);
  });
});
