import "dotenv/config";
import { prisma } from "../lib/db";

type SnapshotSummaryRow = {
  txCount: number;
  agents: bigint;
  owners: bigint;
};

type OwnerClusterRow = {
  owner: string;
  txCount: number;
  agents: bigint;
  min_rank: number;
  max_rank: number;
};

const parseAgentIdsArg = (): string[] => {
  const rawArg = process.argv.find((arg) => arg.startsWith("--agent-ids="));
  if (!rawArg) return [];
  const raw = rawArg.split("=", 2)[1] ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const toNumber = (value: bigint): number => Number(value);

async function run(): Promise<void> {
  const agentIds = parseAgentIdsArg();

  const activeSnapshot = await prisma.leaderboardSnapshot.findFirst({
    where: { isActive: true, status: "READY" },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      totalAgents: true,
      mode: true,
      txSource: true,
      completedAt: true,
      createdAt: true,
    },
  });

  if (!activeSnapshot) {
    console.error("No active READY leaderboard snapshot found.");
    process.exitCode = 1;
    return;
  }

  console.log("Active snapshot:");
  console.log({
    id: activeSnapshot.id,
    totalAgents: activeSnapshot.totalAgents,
    mode: activeSnapshot.mode,
    txSource: activeSnapshot.txSource,
    completedAt: activeSnapshot.completedAt?.toISOString() ?? null,
    createdAt: activeSnapshot.createdAt.toISOString(),
  });

  const repeatedAcrossOwners = await prisma.$queryRaw<SnapshotSummaryRow[]>`
    SELECT
      "txCount",
      COUNT(*)::bigint AS agents,
      COUNT(DISTINCT "owner")::bigint AS owners
    FROM "LeaderboardSnapshotRow"
    WHERE "snapshotId" = ${activeSnapshot.id}
    GROUP BY "txCount"
    HAVING COUNT(DISTINCT "owner") > 1
    ORDER BY owners DESC, agents DESC
    LIMIT 15
  `;

  console.log("\nTop repeated txCount values across different owners:");
  for (const row of repeatedAcrossOwners) {
    console.log({
      txCount: row.txCount,
      agents: toNumber(row.agents),
      owners: toNumber(row.owners),
    });
  }

  const topOwnerClusters = await prisma.$queryRaw<OwnerClusterRow[]>`
    SELECT
      "owner",
      "txCount",
      COUNT(*)::bigint AS agents,
      MIN("rank")::int AS min_rank,
      MAX("rank")::int AS max_rank
    FROM "LeaderboardSnapshotRow"
    WHERE "snapshotId" = ${activeSnapshot.id}
    GROUP BY "owner", "txCount"
    HAVING COUNT(*) >= 5
    ORDER BY agents DESC, "txCount" DESC
    LIMIT 20
  `;

  console.log("\nLargest owner clusters sharing the same txCount:");
  for (const row of topOwnerClusters) {
    console.log({
      owner: row.owner,
      txCount: row.txCount,
      agents: toNumber(row.agents),
      rankRange: `${row.min_rank}-${row.max_rank}`,
    });
  }

  if (agentIds.length > 0) {
    const rows = await prisma.leaderboardSnapshotRow.findMany({
      where: {
        snapshotId: activeSnapshot.id,
        agentId: { in: agentIds },
      },
      select: {
        rank: true,
        agentId: true,
        owner: true,
        creator: true,
        txCount: true,
        reputation: true,
        rankScore: true,
      },
      orderBy: { rank: "asc" },
    });

    console.log("\nRequested agent rows in active snapshot:");
    for (const row of rows) {
      console.log(row);
    }
  }
}

run()
  .catch((error) => {
    console.error("audit-score-clusters failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
