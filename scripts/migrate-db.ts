import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { PrismaClient, Prisma } from "@prisma/client";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const ensurePostgresEnv = (): void => {
  process.env.POSTGRES_PRISMA_URL =
    process.env.POSTGRES_PRISMA_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_DATABASE_URL ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_DATABASE_URL_UNPOOLED;

  process.env.POSTGRES_URL_NON_POOLING =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_PRISMA_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_DATABASE_URL;

  if (!process.env.POSTGRES_PRISMA_URL || !process.env.POSTGRES_URL_NON_POOLING) {
    throw new Error(
      "Missing Postgres env. Set POSTGRES_PRISMA_URL and POSTGRES_URL_NON_POOLING (or POSTGRES_DATABASE_URL_UNPOOLED).",
    );
  }
};

ensurePostgresEnv();

const prisma = new PrismaClient({
  log: ["error"],
});

const applyPhaseCCustomIndexes = async (): Promise<void> => {
  const fulfillmentHoldTableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass('public."FulfillmentHold"')::text AS relation
  `);

  if (!fulfillmentHoldTableCheck[0]?.relation) {
    console.log('Custom index step skipped: table "FulfillmentHold" does not exist yet.');
    return;
  }

  // Prisma cannot express this partial unique index; enforce it with raw SQL after db push.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "FulfillmentHold_wallet_service_active_held_idx"
    ON "FulfillmentHold" ("walletAddress", "serviceSlug")
    WHERE "state" = 'HELD'
  `);

  console.log('Applied/verified custom partial unique index for "FulfillmentHold" active holds.');
};

const run = async (): Promise<void> => {
  execSync("npx prisma db push", {
    stdio: "inherit",
  });

  await applyPhaseCCustomIndexes();
};

run()
  .catch((error) => {
    console.error("Database migration failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
