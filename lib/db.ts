import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { getAddress, type Address } from "viem";

const MAX_PRISMA_INT = 2_147_483_647n;

if (!process.env.POSTGRES_PRISMA_URL) {
  loadEnv({ path: ".env", quiet: true });
  loadEnv({ path: ".env.local", override: true, quiet: true });
}

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

const normalizeAddressKey = (userAddress: Address): string => getAddress(userAddress).toLowerCase();

const toPrismaInt = (value: bigint, field: string): number => {
  if (value < 0n) {
    throw new Error(`${field} must be non-negative.`);
  }
  if (value > MAX_PRISMA_INT) {
    throw new Error(`${field} exceeds Int column capacity.`);
  }
  return Number(value);
};

export const prisma =
  globalThis.prismaGlobal ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma;

type CreditBalanceRecord = {
  walletAddress: string;
  credits: number;
  lastSyncedBlock: bigint;
  updatedAt: Date;
};

const mapCreditBalance = (record: CreditBalanceRecord) => ({
  walletAddress: record.walletAddress,
  credits: BigInt(record.credits),
  lastSyncedBlock: record.lastSyncedBlock,
  updatedAt: record.updatedAt,
});

export type CreditBalanceState = ReturnType<typeof mapCreditBalance>;

export const getCreditBalance = async (userAddress: Address): Promise<CreditBalanceState | null> => {
  const key = normalizeAddressKey(userAddress);
  const record = await prisma.creditBalance.findUnique({
    where: { walletAddress: key },
  });
  return record ? mapCreditBalance(record) : null;
};

export const getUserCredits = async (userAddress: Address): Promise<bigint> =>
  (await getCreditBalance(userAddress))?.credits ?? 0n;

export const updateUserCredits = async (userAddress: Address, amount: bigint): Promise<CreditBalanceState> => {
  const key = normalizeAddressKey(userAddress);
  const credits = toPrismaInt(amount, "credits");
  const record = await prisma.creditBalance.upsert({
    where: { walletAddress: key },
    create: {
      walletAddress: key,
      credits,
      lastSyncedBlock: 0n,
    },
    update: { credits },
  });
  return mapCreditBalance(record);
};

export const syncDeposits = async (
  userAddress: Address,
  depositedWei: bigint,
  creditPriceWei: bigint,
  syncedToBlock: bigint,
): Promise<{ before: bigint; added: bigint; after: bigint; lastSyncedBlock: bigint }> => {
  if (creditPriceWei <= 0n) {
    throw new Error("creditPriceWei must be greater than zero.");
  }
  if (syncedToBlock < 0n) {
    throw new Error("syncedToBlock must be non-negative.");
  }

  const safeDeposited = depositedWei > 0n ? depositedWei : 0n;
  const addedCredits = safeDeposited / creditPriceWei;
  const key = normalizeAddressKey(userAddress);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
    });

    if (!existing) {
      const created = await tx.creditBalance.create({
        data: {
          walletAddress: key,
          credits: toPrismaInt(addedCredits, "added credits"),
          lastSyncedBlock: syncedToBlock,
        },
      });
      return {
        before: 0n,
        added: addedCredits,
        after: BigInt(created.credits),
        lastSyncedBlock: created.lastSyncedBlock,
      };
    }

    const before = BigInt(existing.credits);
    const after = before + addedCredits;
    const nextLastSyncedBlock =
      syncedToBlock > existing.lastSyncedBlock ? syncedToBlock : existing.lastSyncedBlock;

    const updated = await tx.creditBalance.update({
      where: { walletAddress: key },
      data: {
        credits: toPrismaInt(after, "credits"),
        lastSyncedBlock: nextLastSyncedBlock,
      },
    });

    return {
      before,
      added: addedCredits,
      after: BigInt(updated.credits),
      lastSyncedBlock: updated.lastSyncedBlock,
    };
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
  const debit = toPrismaInt(cost, "cost");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
      select: { credits: true },
    });

    const before = BigInt(existing?.credits ?? 0);
    if (before < cost) {
      return null;
    }

    const consumed = await tx.creditBalance.updateMany({
      where: {
        walletAddress: key,
        credits: { gte: debit },
      },
      data: {
        credits: { decrement: debit },
      },
    });
    if (consumed.count === 0) {
      return null;
    }

    const updated = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
      select: { credits: true },
    });
    if (!updated) return null;

    const after = BigInt(updated.credits);
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
  const increment = toPrismaInt(amount, "amount");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.creditBalance.upsert({
      where: { walletAddress: key },
      create: {
        walletAddress: key,
        credits: increment,
        lastSyncedBlock: 0n,
      },
      update: {
        credits: { increment },
      },
    });

    const after = BigInt(updated.credits);
    const before = after - amount;
    return { before, after };
  });
};
