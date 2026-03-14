type ActiveSnapshotRow = {
  snapshotId: string;
  agentId: string;
  agentAddress: string;
  tier: string;
  txCount: number;
  reputation: number;
  rankScore: number;
  yield: number;
  uptime: number;
  score: number;
};

type SnapshotLookupDb = {
  leaderboardSnapshot: {
    findFirst: (...args: any[]) => Promise<{ id: string } | null>;
  };
  leaderboardSnapshotRow: {
    findFirst: (...args: any[]) => Promise<unknown | null>;
  };
};

type SnapshotLookupOptions = {
  select?: Record<string, unknown>;
};

export const findActiveSnapshotScoreByAgentId = async <TRow = ActiveSnapshotRow>(
  db: SnapshotLookupDb,
  agentId: string,
  options?: SnapshotLookupOptions,
): Promise<TRow | null> => {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;

  const activeSnapshot = await db.leaderboardSnapshot.findFirst({
    where: {
      isActive: true,
      status: "READY",
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
    },
  });

  if (!activeSnapshot) {
    return null;
  }

  const row = await db.leaderboardSnapshotRow.findFirst({
    where: {
      snapshotId: activeSnapshot.id,
      agentId: normalizedAgentId,
    },
    select: options?.select,
  });
  return (row as TRow | null) ?? null;
};
