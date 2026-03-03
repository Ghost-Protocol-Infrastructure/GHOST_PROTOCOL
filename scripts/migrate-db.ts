import { spawnSync } from "node:child_process";
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

const DEFAULT_DB_PUSH_RETRY_ATTEMPTS = 4;
const DEFAULT_DB_PUSH_RETRY_DELAY_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;

const parsePositiveInt = (value: string | undefined, fallback: number, max = 60_000): number => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > max ? max : parsed;
};

const DB_PUSH_RETRY_ATTEMPTS = parsePositiveInt(
  process.env.PRISMA_DB_PUSH_RETRY_ATTEMPTS,
  DEFAULT_DB_PUSH_RETRY_ATTEMPTS,
  10,
);
const DB_PUSH_RETRY_DELAY_MS = parsePositiveInt(
  process.env.PRISMA_DB_PUSH_RETRY_DELAY_MS,
  DEFAULT_DB_PUSH_RETRY_DELAY_MS,
  120_000,
);
const CONNECT_TIMEOUT_SECONDS = parsePositiveInt(
  process.env.PRISMA_DB_PUSH_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  120,
);
const PRISMA_DB_PUSH_COMMAND =
  process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npx prisma db push"] }
    : { command: "npx", args: ["prisma", "db", "push"] };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const normalizePostgresUrl = (value: string, connectTimeoutSeconds: number): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (!parsed.searchParams.has("connect_timeout")) {
    parsed.searchParams.set("connect_timeout", String(connectTimeoutSeconds));
  }
  if (!parsed.searchParams.has("sslmode")) {
    parsed.searchParams.set("sslmode", "require");
  }

  return parsed.toString();
};

process.env.POSTGRES_PRISMA_URL = normalizePostgresUrl(process.env.POSTGRES_PRISMA_URL ?? "", CONNECT_TIMEOUT_SECONDS);
process.env.POSTGRES_URL_NON_POOLING = normalizePostgresUrl(
  process.env.POSTGRES_URL_NON_POOLING ?? "",
  CONNECT_TIMEOUT_SECONDS,
);

const isRetryableDbPushError = (output: string): boolean => {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("p1001") ||
    normalized.includes("can't reach database server") ||
    normalized.includes("connection refused") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound")
  );
};

const runPrismaDbPush = async (): Promise<void> => {
  const directUrl = process.env.POSTGRES_URL_NON_POOLING ?? "";
  const pooledUrl = process.env.POSTGRES_PRISMA_URL ?? "";

  const attemptDbPush = async (mode: "direct" | "pooled"): Promise<void> => {
    if (mode === "pooled") {
      process.env.POSTGRES_URL_NON_POOLING = pooledUrl;
    } else {
      process.env.POSTGRES_URL_NON_POOLING = directUrl;
    }

    for (let attempt = 1; attempt <= DB_PUSH_RETRY_ATTEMPTS; attempt += 1) {
      console.log(
        `Running prisma db push (${mode} connection, attempt ${attempt}/${DB_PUSH_RETRY_ATTEMPTS}).`,
      );

      const result = spawnSync(PRISMA_DB_PUSH_COMMAND.command, PRISMA_DB_PUSH_COMMAND.args, {
        env: process.env,
        encoding: "utf8",
        stdio: "pipe",
      });

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);

      if (result.error) {
        throw result.error;
      }

      if (result.status === 0) {
        return;
      }

      const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (!isRetryableDbPushError(combinedOutput) || attempt === DB_PUSH_RETRY_ATTEMPTS) {
        const error = new Error(`prisma db push failed using ${mode} connection.`);
        Object.assign(error, {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        throw error;
      }

      console.warn(
        `prisma db push failed with retryable connectivity error (${mode} connection). Waiting ${DB_PUSH_RETRY_DELAY_MS}ms before retry.`,
      );
      await sleep(DB_PUSH_RETRY_DELAY_MS);
    }
  };

  try {
    await attemptDbPush("direct");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pooledUrl || pooledUrl === directUrl) {
      throw error;
    }

    console.warn(
      `Direct prisma db push failed after retries. Falling back to pooled connection for schema push. Details: ${message}`,
    );
    await attemptDbPush("pooled");
  } finally {
    process.env.POSTGRES_URL_NON_POOLING = directUrl;
  }
};

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
  await runPrismaDbPush();

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
