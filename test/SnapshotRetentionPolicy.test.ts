import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshotRetentionPlan, type RetentionSnapshot } from "../lib/snapshot-retention";

const date = (iso: string): Date => new Date(iso);

const snapshot = (input: Partial<RetentionSnapshot> & Pick<RetentionSnapshot, "id">): RetentionSnapshot => ({
  id: input.id,
  status: input.status ?? "READY",
  isActive: input.isActive ?? false,
  totalAgents: input.totalAgents ?? 10,
  createdAt: input.createdAt ?? date("2026-06-01T00:00:00.000Z"),
  startedAt: input.startedAt ?? null,
  completedAt: input.completedAt ?? input.createdAt ?? date("2026-06-01T00:00:00.000Z"),
});

test("snapshot retention keeps active and previous ready snapshot", () => {
  const plan = buildSnapshotRetentionPlan(
    [
      snapshot({ id: "ready-old", completedAt: date("2026-06-01T00:00:00.000Z"), totalAgents: 100 }),
      snapshot({ id: "ready-previous", completedAt: date("2026-06-02T00:00:00.000Z"), totalAgents: 200 }),
      snapshot({ id: "ready-active", isActive: true, completedAt: date("2026-06-03T00:00:00.000Z"), totalAgents: 300 }),
    ],
    { keepReadySnapshots: 2, now: date("2026-06-03T01:00:00.000Z") },
  );

  assert.deepEqual(plan.keptReadyIds, ["ready-active", "ready-previous"]);
  assert.deepEqual(plan.deleteIds, ["ready-old"]);
  assert.equal(plan.estimatedSnapshotRowsToDelete, 100);
});

test("snapshot retention preserves recent non-ready snapshots but deletes stale failures", () => {
  const plan = buildSnapshotRetentionPlan(
    [
      snapshot({ id: "active", isActive: true, completedAt: date("2026-06-03T00:00:00.000Z") }),
      snapshot({
        id: "failed-recent",
        status: "FAILED",
        isActive: false,
        createdAt: date("2026-06-02T23:00:00.000Z"),
        completedAt: date("2026-06-02T23:01:00.000Z"),
      }),
      snapshot({
        id: "failed-old",
        status: "FAILED",
        isActive: false,
        createdAt: date("2026-05-25T00:00:00.000Z"),
        completedAt: date("2026-05-25T00:01:00.000Z"),
      }),
    ],
    { keepReadySnapshots: 1, keepNonReadyHours: 48, now: date("2026-06-03T01:00:00.000Z") },
  );

  assert(plan.keepIds.includes("failed-recent"));
  assert(!plan.deleteIds.includes("failed-recent"));
  assert.deepEqual(plan.deleteIds, ["failed-old"]);
});

test("snapshot retention refuses to run without exactly one active ready snapshot", () => {
  assert.throws(
    () =>
      buildSnapshotRetentionPlan([
        snapshot({ id: "a", isActive: false }),
        snapshot({ id: "b", isActive: false }),
      ]),
    /Expected exactly one active snapshot/,
  );

  assert.throws(
    () =>
      buildSnapshotRetentionPlan([
        snapshot({ id: "a", isActive: true }),
        snapshot({ id: "b", isActive: true }),
      ]),
    /Expected exactly one active snapshot/,
  );

  assert.throws(
    () =>
      buildSnapshotRetentionPlan([
        snapshot({ id: "building-active", status: "BUILDING", isActive: true }),
      ]),
    /has status BUILDING/,
  );
});

test("snapshot retention always keeps the active snapshot even if ordering data is odd", () => {
  const plan = buildSnapshotRetentionPlan(
    [
      snapshot({ id: "newer-ready", completedAt: date("2026-06-03T00:00:00.000Z") }),
      snapshot({ id: "active", isActive: true, completedAt: date("2026-06-01T00:00:00.000Z") }),
      snapshot({ id: "older", completedAt: date("2026-05-30T00:00:00.000Z") }),
    ],
    { keepReadySnapshots: 1, now: date("2026-06-03T01:00:00.000Z") },
  );

  assert(plan.keepIds.includes("active"));
  assert(!plan.deleteIds.includes("active"));
});
