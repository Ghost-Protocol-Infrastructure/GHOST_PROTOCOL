import { config as loadEnv } from "dotenv";
import { PrismaClient, type Prisma } from "@prisma/client";
import { getAddress, type Address } from "viem";

const MAX_PRISMA_INT = 2_147_483_647n;
const CREDIT_LEDGER_ENABLED = process.env.GHOST_CREDIT_LEDGER_ENABLED === "true";
const GATE_NONCE_STORE_ENABLED = process.env.GHOST_GATE_NONCE_STORE_ENABLED === "true";

if (!process.env.POSTGRES_PRISMA_URL) {
  loadEnv({ path: ".env", quiet: true });
  loadEnv({ path: ".env.local", override: true, quiet: true });
}

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

const normalizeAddressKey = (userAddress: Address): string => getAddress(userAddress).toLowerCase();
const normalizeSignerKey = (signer: Address | string): string => getAddress(signer).toLowerCase();

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

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

type CreditLedgerWriteInput = {
  walletAddress: string;
  direction: "CREDIT" | "DEBIT" | "ADJUSTMENT";
  amount: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  reason: string;
  service?: string | null;
  nonce?: string | null;
  requestId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

type AccessNonceWriteInput = {
  signer: string;
  service: string;
  nonce: string;
  payloadTimestamp: bigint;
  signature?: string | null;
  enforceUnique: boolean;
};

type AccessNoncePersistenceResult = {
  accepted: boolean;
};

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "P2002";

class AccessNonceReplayError extends Error {
  constructor() {
    super("Access nonce already used for this signer/service.");
    this.name = "AccessNonceReplayError";
  }
}

const writeCreditLedger = async (
  tx: Prisma.TransactionClient,
  input: CreditLedgerWriteInput,
): Promise<void> => {
  if (!CREDIT_LEDGER_ENABLED) return;
  if (input.amount <= 0n) return;

  await tx.creditLedger.create({
    data: {
      walletAddress: input.walletAddress,
      direction: input.direction,
      amount: toPrismaInt(input.amount, "ledger amount"),
      balanceBefore: toPrismaInt(input.balanceBefore, "ledger balanceBefore"),
      balanceAfter: toPrismaInt(input.balanceAfter, "ledger balanceAfter"),
      reason: input.reason,
      service: input.service ?? null,
      nonce: input.nonce ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
};

const persistAccessNonce = async (
  tx: Prisma.TransactionClient,
  input: AccessNonceWriteInput,
): Promise<AccessNoncePersistenceResult> => {
  if (!GATE_NONCE_STORE_ENABLED) {
    return { accepted: true };
  }

  const data = {
    signer: input.signer,
    service: input.service,
    nonce: input.nonce,
    payloadTimestamp: input.payloadTimestamp,
    signature: input.signature ?? null,
  };

  if (input.enforceUnique) {
    try {
      await tx.accessNonce.create({ data });
      return { accepted: true };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AccessNonceReplayError();
      }
      throw error;
    }
  }

  const created = await tx.accessNonce.createMany({
    data: [data],
    skipDuplicates: true,
  });
  return { accepted: created.count > 0 };
};

export const getCreditBalance = async (userAddress: Address): Promise<CreditBalanceState | null> => {
  const key = normalizeAddressKey(userAddress);
  const record = await prisma.creditBalance.findUnique({
    where: { walletAddress: key },
  });
  return record ? mapCreditBalance(record) : null;
};

export const getUserCredits = async (userAddress: Address): Promise<bigint> =>
  (await getCreditBalance(userAddress))?.credits ?? 0n;

export const getServiceCreditCost = async (service: string): Promise<bigint | null> => {
  const pricing = await prisma.servicePricing.findUnique({
    where: { service },
    select: { cost: true, isActive: true },
  });

  if (!pricing || !pricing.isActive) {
    return null;
  }

  return BigInt(pricing.cost);
};

export const updateUserCredits = async (userAddress: Address, amount: bigint): Promise<CreditBalanceState> => {
  const key = normalizeAddressKey(userAddress);
  const credits = toPrismaInt(amount, "credits");

  const record = await prisma.$transaction(async (tx) => {
    const existing = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
      select: { credits: true },
    });

    const before = BigInt(existing?.credits ?? 0);
    const updated = await tx.creditBalance.upsert({
      where: { walletAddress: key },
      create: {
        walletAddress: key,
        credits,
        lastSyncedBlock: 0n,
      },
      update: { credits },
    });

    const after = BigInt(updated.credits);
    const delta = after - before;
    if (delta !== 0n) {
      await writeCreditLedger(tx, {
        walletAddress: key,
        direction: delta > 0n ? "CREDIT" : "DEBIT",
        amount: abs(delta),
        balanceBefore: before,
        balanceAfter: after,
        reason: "manual_set_balance",
        metadata: {
          source: "updateUserCredits",
        },
      });
    }

    return updated;
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

      const after = BigInt(created.credits);
      if (addedCredits > 0n) {
        await writeCreditLedger(tx, {
          walletAddress: key,
          direction: "CREDIT",
          amount: addedCredits,
          balanceBefore: 0n,
          balanceAfter: after,
          reason: "vault_sync",
          metadata: {
            depositedWei: safeDeposited.toString(),
            creditPriceWei: creditPriceWei.toString(),
            syncedToBlock: syncedToBlock.toString(),
          },
        });
      }

      return {
        before: 0n,
        added: addedCredits,
        after,
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

    const updatedAfter = BigInt(updated.credits);
    if (addedCredits > 0n) {
      await writeCreditLedger(tx, {
        walletAddress: key,
        direction: "CREDIT",
        amount: addedCredits,
        balanceBefore: before,
        balanceAfter: updatedAfter,
        reason: "vault_sync",
        metadata: {
          depositedWei: safeDeposited.toString(),
          creditPriceWei: creditPriceWei.toString(),
          syncedToBlock: syncedToBlock.toString(),
          previousLastSyncedBlock: existing.lastSyncedBlock.toString(),
        },
      });
    }

    return {
      before,
      added: addedCredits,
      after: updatedAfter,
      lastSyncedBlock: updated.lastSyncedBlock,
    };
  });
};

export type ConsumeUserCreditsOptions = {
  reason?: string;
  service?: string;
  nonce?: string;
  requestId?: string;
  metadata?: Prisma.InputJsonValue | null;
};

export const consumeUserCredits = async (
  userAddress: Address,
  cost: bigint,
  options?: ConsumeUserCreditsOptions,
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
    await writeCreditLedger(tx, {
      walletAddress: key,
      direction: "DEBIT",
      amount: cost,
      balanceBefore: before,
      balanceAfter: after,
      reason: options?.reason ?? "credit_consume",
      service: options?.service ?? null,
      nonce: options?.nonce ?? null,
      requestId: options?.requestId ?? null,
      metadata: options?.metadata ?? null,
    });

    return { before, after };
  });
};

export type ConsumeGateCreditsOptions = {
  service: string;
  nonce: string;
  payloadTimestamp: bigint;
  signature?: `0x${string}` | string | null;
  requestId?: string;
  enforceNonceUniqueness?: boolean;
};

export type ConsumeGateCreditsResult =
  | { status: "ok"; before: bigint; after: bigint; nonceAccepted: boolean }
  | { status: "insufficient_credits" }
  | { status: "replay" };

export const consumeUserCreditsForGate = async (
  userAddress: Address,
  cost: bigint,
  options: ConsumeGateCreditsOptions,
): Promise<ConsumeGateCreditsResult> => {
  if (cost <= 0n) {
    return { status: "insufficient_credits" };
  }

  const key = normalizeAddressKey(userAddress);
  const debit = toPrismaInt(cost, "cost");

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.creditBalance.findUnique({
        where: { walletAddress: key },
        select: { credits: true },
      });

      const before = BigInt(existing?.credits ?? 0);
      if (before < cost) {
        return { status: "insufficient_credits" } as const;
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
        return { status: "insufficient_credits" } as const;
      }

      const updated = await tx.creditBalance.findUnique({
        where: { walletAddress: key },
        select: { credits: true },
      });
      if (!updated) {
        return { status: "insufficient_credits" } as const;
      }

      const nonceResult = await persistAccessNonce(tx, {
        signer: normalizeSignerKey(userAddress),
        service: options.service,
        nonce: options.nonce,
        payloadTimestamp: options.payloadTimestamp,
        signature: options.signature ?? null,
        enforceUnique: options.enforceNonceUniqueness ?? false,
      });

      const after = BigInt(updated.credits);
      await writeCreditLedger(tx, {
        walletAddress: key,
        direction: "DEBIT",
        amount: cost,
        balanceBefore: before,
        balanceAfter: after,
        reason: "gate_debit",
        service: options.service,
        nonce: options.nonce,
        requestId: options.requestId ?? null,
        metadata: {
          payloadTimestamp: options.payloadTimestamp.toString(),
        },
      });

      return {
        status: "ok",
        before,
        after,
        nonceAccepted: nonceResult.accepted,
      } as const;
    });
  } catch (error) {
    if (error instanceof AccessNonceReplayError) {
      return { status: "replay" };
    }
    throw error;
  }
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

    await writeCreditLedger(tx, {
      walletAddress: key,
      direction: "CREDIT",
      amount,
      balanceBefore: before,
      balanceAfter: after,
      reason: "manual_credit_add",
      metadata: {
        source: "addUserCredits",
      },
    });

    return { before, after };
  });
};
