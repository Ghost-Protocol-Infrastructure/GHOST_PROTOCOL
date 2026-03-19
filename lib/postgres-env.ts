import { config as loadEnv } from "dotenv";

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;

const PRISMA_URL_KEYS = [
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_DATABASE_URL_UNPOOLED",
] as const;

const DIRECT_POSTGRES_URL_KEYS = [
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
] as const;

const trimEnvValue = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const getUrlScheme = (value: string): string | null => {
  const match = value.match(/^([a-z0-9+.-]+):\/\//i);
  return match?.[1]?.toLowerCase() ?? null;
};

const isPrismaDatasourceUrl = (value: string): boolean => {
  const scheme = getUrlScheme(value);
  return scheme === "prisma" || scheme === "prisma+postgres";
};

const isDirectPostgresUrl = (value: string): boolean => {
  const scheme = getUrlScheme(value);
  return scheme === "postgres" || scheme === "postgresql";
};

const describeObservedSchemes = (keys: readonly string[]): string => {
  const observed = keys.flatMap((key) => {
    const value = trimEnvValue(process.env[key]);
    if (!value) return [];
    return [`${key}=${getUrlScheme(value) ?? "unknown"}://`];
  });

  return observed.length > 0 ? observed.join(", ") : "none";
};

const pickEnvValueByScheme = (
  keys: readonly string[],
  predicate: (value: string) => boolean,
): { key: string; value: string } | null => {
  for (const key of keys) {
    const value = trimEnvValue(process.env[key]);
    if (value && predicate(value)) {
      return { key, value };
    }
  }

  return null;
};

const loadProjectEnv = (): void => {
  loadEnv({ path: ".env", quiet: true });
  loadEnv({ path: ".env.local", override: true, quiet: true });
};

export const normalizeDirectPostgresUrl = (
  value: string,
  connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): string => {
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

const getHostname = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isLoopbackHostname = (hostname: string | null): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

export const bootstrapPostgresEnv = (input?: {
  connectTimeoutSeconds?: number;
  loadEnvFiles?: boolean;
  normalizeDirectUrl?: boolean;
}): {
  directSource: string;
  directUrl: string;
  prismaSource: string;
  prismaUrl: string;
} => {
  if (input?.loadEnvFiles !== false) {
    loadProjectEnv();
  }

  const prismaCandidate = pickEnvValueByScheme(PRISMA_URL_KEYS, isPrismaDatasourceUrl);
  if (!prismaCandidate) {
    throw new Error(
      `Missing Prisma datasource URL. Set POSTGRES_PRISMA_URL or DATABASE_URL to prisma:// or prisma+postgres://. Observed schemes: ${describeObservedSchemes(PRISMA_URL_KEYS)}.`,
    );
  }

  const directCandidate = pickEnvValueByScheme(DIRECT_POSTGRES_URL_KEYS, isDirectPostgresUrl);
  if (!directCandidate) {
    throw new Error(
      `Missing direct Postgres URL. Set POSTGRES_URL_NON_POOLING or POSTGRES_DATABASE_URL_UNPOOLED to postgres:// or postgresql://. Observed schemes: ${describeObservedSchemes(DIRECT_POSTGRES_URL_KEYS)}.`,
    );
  }

  process.env.POSTGRES_PRISMA_URL = prismaCandidate.value;
  process.env.POSTGRES_URL_NON_POOLING =
    input?.normalizeDirectUrl === false
      ? directCandidate.value
      : normalizeDirectPostgresUrl(
          directCandidate.value,
          input?.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
        );

  return {
    prismaUrl: process.env.POSTGRES_PRISMA_URL,
    directUrl: process.env.POSTGRES_URL_NON_POOLING,
    prismaSource: prismaCandidate.key,
    directSource: directCandidate.key,
  };
};

export const shouldUseDirectPrismaClientUrl = (input: {
  directUrl: string;
  prismaUrl: string;
}): boolean => isLoopbackHostname(getHostname(input.prismaUrl));

export const getPrismaClientDatasourceOptions = (input: {
  directUrl: string;
  prismaUrl: string;
}): { datasources: { db: { url: string } } } | undefined => {
  if (!shouldUseDirectPrismaClientUrl(input)) {
    return undefined;
  }

  return {
    datasources: {
      db: {
        url: input.directUrl,
      },
    },
  };
};
