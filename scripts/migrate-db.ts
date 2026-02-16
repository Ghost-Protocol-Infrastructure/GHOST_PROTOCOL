import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

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

execSync("npx prisma db push", {
  stdio: "inherit",
});
