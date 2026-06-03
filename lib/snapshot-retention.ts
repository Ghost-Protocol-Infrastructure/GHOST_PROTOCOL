export type RetentionSnapshotStatus = "BUILDING" | "READY" | "FAILED" | string;

export type RetentionSnapshot = {
  id: string;
  status: RetentionSnapshotStatus;
  isActive: boolean;
  totalAgents?: number | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export type SnapshotRetentionOptions = {
  /** Number of READY snapshots to keep in total, including the active snapshot when it is READY. */
  keepReadySnapshots: number;
  /** Recent non-ready snapshots are preserved for debugging failed/in-flight runs. */
  keepNonReadyHours: number;
  now?: Date;
};

export type SnapshotRetentionPlan = {
  keepIds: string[];
  deleteIds: string[];
  activeSnapshotId: string;
  keptReadyIds: string[];
  keptRecentNonReadyIds: string[];
  estimatedSnapshotRowsToDelete: number;
  deleteSnapshots: RetentionSnapshot[];
};

const toTime = (value: Date | null | undefined): number => (value instanceof Date ? value.getTime() : 0);

const snapshotSortTime = (snapshot: RetentionSnapshot): number =>
  Math.max(toTime(snapshot.completedAt), toTime(snapshot.startedAt), toTime(snapshot.createdAt));

const compareSnapshotsNewestFirst = (left: RetentionSnapshot, right: RetentionSnapshot): number => {
  const delta = snapshotSortTime(right) - snapshotSortTime(left);
  if (delta !== 0) return delta;
  return right.id.localeCompare(left.id);
};

const compareSnapshotsOldestFirst = (left: RetentionSnapshot, right: RetentionSnapshot): number => {
  const delta = snapshotSortTime(left) - snapshotSortTime(right);
  if (delta !== 0) return delta;
  return left.id.localeCompare(right.id);
};

export const normalizeSnapshotRetentionOptions = (input: Partial<SnapshotRetentionOptions> = {}): SnapshotRetentionOptions => ({
  keepReadySnapshots: Math.max(1, Math.floor(input.keepReadySnapshots ?? 2)),
  keepNonReadyHours: Math.max(0, Math.floor(input.keepNonReadyHours ?? 48)),
  now: input.now ?? new Date(),
});

export const buildSnapshotRetentionPlan = (
  snapshots: RetentionSnapshot[],
  rawOptions: Partial<SnapshotRetentionOptions> = {},
): SnapshotRetentionPlan => {
  const options = normalizeSnapshotRetentionOptions(rawOptions);
  const activeSnapshots = snapshots.filter((snapshot) => snapshot.isActive);
  if (activeSnapshots.length !== 1) {
    throw new Error(`Expected exactly one active snapshot, found ${activeSnapshots.length}. Refusing retention cleanup.`);
  }

  const activeSnapshot = activeSnapshots[0];
  if (activeSnapshot.status !== "READY") {
    throw new Error(`Active snapshot ${activeSnapshot.id} has status ${activeSnapshot.status}. Refusing retention cleanup.`);
  }

  const readySnapshots = snapshots
    .filter((snapshot) => snapshot.status === "READY")
    .sort(compareSnapshotsNewestFirst);

  const keptReadyIds = readySnapshots.slice(0, options.keepReadySnapshots).map((snapshot) => snapshot.id);
  if (!keptReadyIds.includes(activeSnapshot.id)) {
    keptReadyIds.push(activeSnapshot.id);
  }

  const now = options.now ?? new Date();
  const nonReadyCutoffMs = now.getTime() - options.keepNonReadyHours * 60 * 60 * 1000;
  const keptRecentNonReadyIds = snapshots
    .filter((snapshot) => snapshot.status !== "READY" && snapshotSortTime(snapshot) >= nonReadyCutoffMs)
    .map((snapshot) => snapshot.id);

  const keepIds = Array.from(new Set([...keptReadyIds, ...keptRecentNonReadyIds]));
  const keepIdSet = new Set(keepIds);
  const deleteSnapshots = snapshots
    .filter((snapshot) => !keepIdSet.has(snapshot.id))
    .sort(compareSnapshotsOldestFirst);

  if (deleteSnapshots.some((snapshot) => snapshot.id === activeSnapshot.id || snapshot.isActive)) {
    throw new Error("Retention plan attempted to delete the active snapshot. Refusing cleanup.");
  }

  return {
    keepIds,
    deleteIds: deleteSnapshots.map((snapshot) => snapshot.id),
    activeSnapshotId: activeSnapshot.id,
    keptReadyIds,
    keptRecentNonReadyIds,
    estimatedSnapshotRowsToDelete: deleteSnapshots.reduce((sum, snapshot) => sum + Math.max(0, snapshot.totalAgents ?? 0), 0),
    deleteSnapshots,
  };
};
