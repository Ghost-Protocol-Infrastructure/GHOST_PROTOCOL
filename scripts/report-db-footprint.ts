import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const footprintDatabaseUrl =
  process.env.DB_FOOTPRINT_DATABASE_URL ?? process.env.POSTGRES_PRISMA_URL ?? process.env.POSTGRES_URL_NON_POOLING;

const prisma = new PrismaClient({
  datasources: footprintDatabaseUrl
    ? {
        db: {
          url: footprintDatabaseUrl,
        },
      }
    : undefined,
});

const main = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(`SET statement_timeout = 60000`);

  const dbSize = await prisma.$queryRawUnsafe(`
    SELECT current_database() AS db,
           pg_database_size(current_database()) AS bytes,
           pg_size_pretty(pg_database_size(current_database())) AS pretty
  `);

  const topTables = await prisma.$queryRawUnsafe(`
    SELECT relname AS table,
           n_live_tup::bigint AS estimated_rows,
           pg_total_relation_size(relid) AS total_bytes,
           pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
           pg_size_pretty(pg_relation_size(relid)) AS table_size,
           pg_size_pretty(pg_indexes_size(relid)) AS index_size
    FROM pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 20
  `);

  const snapshots = await prisma.$queryRawUnsafe(`
    SELECT count(*)::bigint AS snapshots,
           count(*) FILTER (WHERE "isActive")::bigint AS active,
           min("createdAt") AS oldest,
           max("createdAt") AS newest
    FROM "LeaderboardSnapshot"
  `);

  console.log(JSON.stringify({ dbSize, snapshots, topTables }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
};

main()
  .catch((error) => {
    console.error("db footprint report failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
