import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildSnapshotRetentionPlan, normalizeSnapshotRetentionOptions } from "../lib/snapshot-retention";

const retentionDatabaseUrl =
  process.env.SCORE_SNAPSHOT_RETENTION_DATABASE_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  process.env.POSTGRES_URL_NON_POOLING;

const prisma = new PrismaClient({
  datasources: retentionDatabaseUrl
    ? {
        db: {
          url: retentionDatabaseUrl,
        },
      }
    : undefined,
});

type VacuumMode = "none" | "analyze" | "full";

type Args = {
  execute: boolean;
  keepReadySnapshots: number;
  keepNonReadyHours: number;
  maxDeleteSnapshots: number | null;
  vacuum: VacuumMode;
  statementTimeoutMs: number;
};

const parsePositiveInt = (raw: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number => {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Math.min(max, Math.max(min, parsed));
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const getValue = (name: string): string | undefined => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1];
    return undefined;
  };
  const hasFlag = (name: string): boolean => argv.includes(name);
  const vacuumRaw = (getValue("--vacuum") ?? process.env.SCORE_SNAPSHOT_RETENTION_VACUUM ?? "none").toLowerCase();
  const vacuum: VacuumMode = vacuumRaw === "full" || vacuumRaw === "analyze" || vacuumRaw === "none" ? vacuumRaw : "none";

  return {
    execute: hasFlag("--execute") || process.env.SCORE_SNAPSHOT_RETENTION_EXECUTE === "true",
    keepReadySnapshots: parsePositiveInt(
      getValue("--keep-ready-snapshots") ?? process.env.SCORE_SNAPSHOT_RETENTION_KEEP_READY,
      2,
      1,
      30,
    ),
    keepNonReadyHours: parsePositiveInt(
      getValue("--keep-non-ready-hours") ?? process.env.SCORE_SNAPSHOT_RETENTION_KEEP_NON_READY_HOURS,
      48,
      0,
      24 * 30,
    ),
    maxDeleteSnapshots: (() => {
      const raw = getValue("--max-delete-snapshots") ?? process.env.SCORE_SNAPSHOT_RETENTION_MAX_DELETE_SNAPSHOTS;
      if (!raw || raw.toLowerCase() === "all") return null;
      return parsePositiveInt(raw, 0, 0, 10_000);
    })(),
    vacuum,
    statementTimeoutMs: parsePositiveInt(
      getValue("--statement-timeout-ms") ?? process.env.SCORE_SNAPSHOT_RETENTION_STATEMENT_TIMEOUT_MS,
      300_000,
      10_000,
      3_600_000,
    ),
  };
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

const runVacuum = async (mode: VacuumMode): Promise<void> => {
  if (mode === "none") return;

  const tables = ["AgentTrustArtifact", "LeaderboardSnapshotRow", "LeaderboardSnapshot"];
  const clause = mode === "full" ? "VACUUM (FULL, ANALYZE)" : "VACUUM (ANALYZE)";
  for (const table of tables) {
    console.log(`snapshot retention vacuum: mode=${mode}, table=${table}`);
    await prisma.$executeRawUnsafe(`${clause} ${quoteIdentifier(table)}`);
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  await prisma.$executeRawUnsafe(`SET statement_timeout = ${Math.floor(args.statementTimeoutMs)}`);

  const snapshots = await prisma.leaderboardSnapshot.findMany({
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      isActive: true,
      totalAgents: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  const options = normalizeSnapshotRetentionOptions({
    keepReadySnapshots: args.keepReadySnapshots,
    keepNonReadyHours: args.keepNonReadyHours,
  });
  const plan = buildSnapshotRetentionPlan(snapshots, options);
  const deleteSnapshots = args.maxDeleteSnapshots == null ? plan.deleteSnapshots : plan.deleteSnapshots.slice(0, args.maxDeleteSnapshots);

  console.log(
    [
      "snapshot retention plan",
      `execute=${args.execute}`,
      `keep_ready_snapshots=${options.keepReadySnapshots}`,
      `keep_non_ready_hours=${options.keepNonReadyHours}`,
      `active_snapshot=${plan.activeSnapshotId}`,
      `snapshots_total=${snapshots.length}`,
      `snapshots_keep=${plan.keepIds.length}`,
      `snapshots_delete_planned=${plan.deleteIds.length}`,
      `snapshots_delete_this_run=${deleteSnapshots.length}`,
      `estimated_snapshot_rows_to_delete=${deleteSnapshots.reduce((sum, snapshot) => sum + Math.max(0, snapshot.totalAgents ?? 0), 0)}`,
      `vacuum=${args.vacuum}`,
    ].join(", "),
  );

  if (deleteSnapshots.length === 0) {
    console.log("snapshot retention: nothing to delete.");
    if (args.execute) await runVacuum(args.vacuum);
    return;
  }

  if (!args.execute) {
    console.log(
      `snapshot retention dry-run: oldest_delete=${deleteSnapshots[0]?.id}, newest_delete=${deleteSnapshots[deleteSnapshots.length - 1]?.id}. Pass --execute to delete.`,
    );
    return;
  }

  let deletedTrustArtifacts = 0;
  let deletedRows = 0;
  let deletedSnapshots = 0;

  for (const snapshot of deleteSnapshots) {
    if (snapshot.isActive || snapshot.id === plan.activeSnapshotId) {
      throw new Error(`Refusing to delete active snapshot ${snapshot.id}.`);
    }

    const trustResult = await prisma.agentTrustArtifact.deleteMany({ where: { snapshotId: snapshot.id } });
    const rowResult = await prisma.leaderboardSnapshotRow.deleteMany({ where: { snapshotId: snapshot.id } });
    const snapshotResult = await prisma.leaderboardSnapshot.deleteMany({
      where: {
        id: snapshot.id,
        isActive: false,
      },
    });

    deletedTrustArtifacts += trustResult.count;
    deletedRows += rowResult.count;
    deletedSnapshots += snapshotResult.count;

    console.log(
      `snapshot retention deleted: snapshot=${snapshot.id}, status=${snapshot.status}, trust_artifacts=${trustResult.count}, rows=${rowResult.count}, snapshots=${snapshotResult.count}`,
    );
  }

  console.log(
    `snapshot retention complete: snapshots=${deletedSnapshots}, trust_artifacts=${deletedTrustArtifacts}, rows=${deletedRows}, vacuum=${args.vacuum}`,
  );

  await runVacuum(args.vacuum);
};

main()
  .catch((error) => {
    console.error("snapshot retention failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
