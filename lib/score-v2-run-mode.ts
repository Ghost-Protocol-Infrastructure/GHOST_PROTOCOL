export type ScoreV2RunMode = "full" | "refresh-only" | "snapshot-only";

export const resolveScoreV2RunMode = (argv: string[]): ScoreV2RunMode => {
  const hasRefreshOnly = argv.includes("--refresh-only");
  const hasSnapshotOnly = argv.includes("--snapshot-only");

  if (hasRefreshOnly && hasSnapshotOnly) {
    throw new Error("score-v2 run modes --refresh-only and --snapshot-only are mutually exclusive.");
  }
  if (hasRefreshOnly) return "refresh-only";
  if (hasSnapshotOnly) return "snapshot-only";
  return "full";
};
