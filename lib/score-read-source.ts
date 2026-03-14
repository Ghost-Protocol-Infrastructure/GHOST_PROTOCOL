export type ScoreReadSource = "snapshot" | "agent";

const normalizeBooleanEnv = (value: string | null | undefined): boolean => {
  return value?.trim().toLowerCase() === "true";
};

export const resolveScoreReadSource = (
  explicitValue: string | null | undefined,
  legacySnapshotValue: string | null | undefined,
): ScoreReadSource => {
  const normalizedExplicit = explicitValue?.trim().toLowerCase();
  if (normalizedExplicit === "snapshot") return "snapshot";
  if (normalizedExplicit === "agent") return "agent";
  return normalizeBooleanEnv(legacySnapshotValue) ? "snapshot" : "agent";
};

export const getConfiguredScoreReadSource = (): ScoreReadSource => {
  return resolveScoreReadSource(process.env.SCORE_READ_SOURCE, process.env.LEADERBOARD_READ_FROM_SNAPSHOT);
};
