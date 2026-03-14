import assert from "node:assert/strict";
import test from "node:test";

import { findActiveSnapshotScoreByAgentId } from "../lib/leaderboard-snapshot";

test("returns null when no active ready snapshot exists", async () => {
  let rowLookups = 0;
  const db = {
    leaderboardSnapshot: {
      findFirst: async () => null,
    },
    leaderboardSnapshotRow: {
      findFirst: async () => {
        rowLookups += 1;
        return null;
      },
    },
  };

  const result = await findActiveSnapshotScoreByAgentId(db, "18755");

  assert.equal(result, null);
  assert.equal(rowLookups, 0);
});

test("queries the active snapshot row by snapshotId and agentId", async () => {
  let rowQuery: Record<string, unknown> | null = null;
  const db = {
    leaderboardSnapshot: {
      findFirst: async () => ({ id: "snap_123" }),
    },
    leaderboardSnapshotRow: {
      findFirst: async (query: Record<string, unknown>) => {
        rowQuery = query;
        return {
          snapshotId: "snap_123",
          agentId: "18755",
          agentAddress: "0xabc",
          tier: "ACTIVE",
          txCount: 42,
          reputation: 77.5,
          rankScore: 71.2,
          yield: 1.25,
          uptime: 98,
          score: 71,
        };
      },
    },
  };

  const result = await findActiveSnapshotScoreByAgentId(db, "18755");

  assert.equal(result?.snapshotId, "snap_123");
  assert.equal(result?.agentId, "18755");
  assert.deepEqual(rowQuery, {
    where: {
      snapshotId: "snap_123",
      agentId: "18755",
    },
    select: undefined,
  });
});
