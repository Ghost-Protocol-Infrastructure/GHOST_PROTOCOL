import type { PrismaClient } from "@prisma/client";

type RetryablePrismaClient = Pick<PrismaClient, "$connect" | "$disconnect">;

export type PrismaRetryOptions = {
  attempts?: number;
  delayMs?: number;
  connectionTimeoutMs?: number;
  labelPrefix?: string;
  onRetry?: (input: { label: string; attempt: number; attempts: number; error: unknown }) => void;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const parseBoundedInt = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const errorToSearchText = (error: unknown): string => {
  if (error instanceof Error) {
    const details = Object.entries(error as Error & Record<string, unknown>)
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(" ");
    return `${error.name}: ${error.message} ${details}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const isRecoverablePrismaError = (error: unknown): boolean => {
  const message = errorToSearchText(error);
  return /(postgresql connection|kind:\s*closed|connection.*closed|can't reach database server|database server.*running|engine is not yet connected|response from the engine was empty|genericfailure|prismaclientunknownrequesterror|P1001|P1017|P2024|57P01|57P03|08000|08003|08006|53300|timeout|timed out|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection reset)/i.test(
    message,
  );
};

const withTimeout = async <T>(label: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const resetPrismaConnection = async (
  prisma: RetryablePrismaClient,
  label: string,
  attempt: number,
  attempts: number,
  delayMs: number,
  connectionTimeoutMs: number,
): Promise<void> => {
  try {
    await withTimeout(`${label} prisma.$disconnect`, connectionTimeoutMs, () => prisma.$disconnect());
  } catch (error) {
    console.warn(`${label} prisma.$disconnect failed during retry reset (attempt ${attempt}/${attempts}). Continuing.`);
    console.error(error);
  }

  await sleep(delayMs * attempt);

  try {
    await withTimeout(`${label} prisma.$connect`, connectionTimeoutMs, () => prisma.$connect());
  } catch (error) {
    console.warn(`${label} prisma.$connect failed during retry reset (attempt ${attempt}/${attempts}).`);
    console.error(error);
  }
};

export const withPrismaRetry = async <T>(
  prisma: RetryablePrismaClient,
  label: string,
  operation: () => Promise<T>,
  options: PrismaRetryOptions = {},
): Promise<T> => {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 4));
  const delayMs = Math.max(100, Math.trunc(options.delayMs ?? 1_000));
  const connectionTimeoutMs = Math.max(1_000, Math.trunc(options.connectionTimeoutMs ?? 12_000));
  const fullLabel = options.labelPrefix ? `${options.labelPrefix} ${label}` : label;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Do not race the primary Prisma operation against a JS timeout.
      // Promise.race does not cancel in-flight Prisma engine work and can leave the engine in a bad state.
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRecoverablePrismaError(error) || attempt >= attempts) {
        throw error;
      }

      options.onRetry?.({ label: fullLabel, attempt, attempts, error });
      console.warn(`${fullLabel} failed with recoverable Prisma error (attempt ${attempt}/${attempts}). Retrying...`);
      console.error(error);
      await resetPrismaConnection(prisma, fullLabel, attempt, attempts, delayMs, connectionTimeoutMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${fullLabel} failed after retries`);
};
