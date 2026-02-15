import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Address } from "viem";

const CREDITS_DB_PATH = join(process.cwd(), "data", "credits.json");

type CreditsDbRecord = {
  credits: string;
  totalDepositedWei: string;
  totalSyncedCredits: string;
  updatedAt: string;
};

type CreditsDb = Record<string, CreditsDbRecord>;

let writeQueue: Promise<unknown> = Promise.resolve();

const runSerialized = async <T>(operation: () => Promise<T>): Promise<T> => {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const normalizeAddressKey = (userAddress: Address): string => getAddress(userAddress).toLowerCase();

const parseNonNegativeBigInt = (value: unknown): bigint => {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return 0n;
};

const normalizeRecord = (record: CreditsDbRecord | undefined): CreditsDbRecord => ({
  credits: parseNonNegativeBigInt(record?.credits).toString(),
  totalDepositedWei: parseNonNegativeBigInt(record?.totalDepositedWei).toString(),
  totalSyncedCredits: parseNonNegativeBigInt(record?.totalSyncedCredits).toString(),
  updatedAt: record?.updatedAt ?? new Date(0).toISOString(),
});

const ensureDbFile = async (): Promise<void> => {
  await mkdir(join(process.cwd(), "data"), { recursive: true });

  try {
    await readFile(CREDITS_DB_PATH, "utf8");
  } catch {
    await writeFile(CREDITS_DB_PATH, "{}", "utf8");
  }
};

const readDb = async (): Promise<CreditsDb> => {
  await ensureDbFile();
  try {
    const raw = await readFile(CREDITS_DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as CreditsDb;
    }
    return {};
  } catch {
    return {};
  }
};

const writeDb = async (db: CreditsDb): Promise<void> => {
  await ensureDbFile();
  await writeFile(CREDITS_DB_PATH, JSON.stringify(db, null, 2), "utf8");
};

export const getUserCredits = async (userAddress: Address): Promise<bigint> => {
  const db = await readDb();
  const key = normalizeAddressKey(userAddress);
  const record = normalizeRecord(db[key]);
  return BigInt(record.credits);
};

export const syncUserCreditsFromDeposits = async (
  userAddress: Address,
  totalDepositedWei: bigint,
  creditPriceWei: bigint,
): Promise<void> => {
  const safeDeposited = totalDepositedWei < 0n ? 0n : totalDepositedWei;
  const safePrice = creditPriceWei > 0n ? creditPriceWei : 1n;
  const key = normalizeAddressKey(userAddress);
  const nextTotalSyncedCredits = safeDeposited / safePrice;

  await runSerialized(async () => {
    const db = await readDb();
    const previous = normalizeRecord(db[key]);
    const previousBalance = BigInt(previous.credits);
    const previousTotalSyncedCredits = BigInt(previous.totalSyncedCredits);
    const delta = nextTotalSyncedCredits - previousTotalSyncedCredits;
    const nextBalance = previousBalance + delta;

    db[key] = {
      credits: (nextBalance > 0n ? nextBalance : 0n).toString(),
      totalDepositedWei: safeDeposited.toString(),
      totalSyncedCredits: nextTotalSyncedCredits.toString(),
      updatedAt: new Date().toISOString(),
    };
    await writeDb(db);
  });
};

export const consumeUserCredits = async (
  userAddress: Address,
  cost: bigint,
): Promise<{ before: bigint; after: bigint } | null> => {
  if (cost <= 0n) {
    return null;
  }

  const key = normalizeAddressKey(userAddress);

  return runSerialized(async () => {
    const db = await readDb();
    const existing = normalizeRecord(db[key]);
    const before = BigInt(existing.credits);
    if (before < cost) {
      return null;
    }

    const after = before - cost;
    db[key] = {
      credits: after.toString(),
      totalDepositedWei: existing.totalDepositedWei,
      totalSyncedCredits: existing.totalSyncedCredits,
      updatedAt: new Date().toISOString(),
    };
    await writeDb(db);
    return { before, after };
  });
};

export const addUserCredits = async (
  userAddress: Address,
  amount: bigint,
): Promise<{ before: bigint; after: bigint } | null> => {
  if (amount <= 0n) {
    return null;
  }

  const key = normalizeAddressKey(userAddress);

  return runSerialized(async () => {
    const db = await readDb();
    const existing = normalizeRecord(db[key]);
    const before = BigInt(existing.credits);
    const after = before + amount;

    db[key] = {
      credits: after.toString(),
      totalDepositedWei: existing.totalDepositedWei,
      totalSyncedCredits: existing.totalSyncedCredits,
      updatedAt: new Date().toISOString(),
    };
    await writeDb(db);
    return { before, after };
  });
};
