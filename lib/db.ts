import { config as loadEnv } from "dotenv";
import { PrismaClient, type GateAccessOutcome, Prisma } from "@prisma/client";
import { getAddress, type Address } from "viem";

if (!process.env.POSTGRES_PRISMA_URL) {
  loadEnv({ path: ".env", quiet: true });
  loadEnv({ path: ".env.local", override: true, quiet: true });
}

const MAX_PRISMA_INT = 2_147_483_647n;
const MIN_PRISMA_INT = -2_147_483_648n;
const CREDIT_LEDGER_ENABLED = process.env.GHOST_CREDIT_LEDGER_ENABLED === "true";
const GATE_NONCE_STORE_ENABLED = process.env.GHOST_GATE_NONCE_STORE_ENABLED === "true";
const GATE_ACCESS_EVENT_LOG_ENABLED = process.env.GHOST_GATE_ACCESS_EVENT_LOG_ENABLED !== "false";
let gateAccessEventTableAvailable: boolean | null = null;

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

const toPrismaSignedInt = (value: bigint, field: string): number => {
  if (value < MIN_PRISMA_INT || value > MAX_PRISMA_INT) {
    throw new Error(`${field} exceeds Int column capacity.`);
  }
  return Number(value);
};

const toPrismaOptionalInt = (value: bigint | null | undefined): number | null => {
  if (value == null) return null;
  if (value < 0n || value > MAX_PRISMA_INT) return null;
  return Number(value);
};

const normalizeSignerForLog = (signer: Address | string | null | undefined): string | null => {
  if (!signer) return null;
  try {
    return normalizeSignerKey(signer);
  } catch {
    return null;
  }
};

const toJsDate = (value: Date | string, field: string): Date => {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date value.`);
  }
  return parsed;
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
  heldCredits: number;
  lastSyncedBlock: bigint;
  updatedAt: Date;
};

const mapCreditBalance = (record: CreditBalanceRecord) => ({
  walletAddress: record.walletAddress,
  credits: BigInt(record.credits),
  heldCredits: BigInt(record.heldCredits),
  lastSyncedBlock: record.lastSyncedBlock,
  updatedAt: record.updatedAt,
});

export type CreditBalanceState = ReturnType<typeof mapCreditBalance>;

export type GateAccessEventInput = {
  service: string;
  outcome: GateAccessOutcome;
  signer?: Address | string | null;
  nonce?: string | null;
  requestId?: string | null;
  cost?: bigint | null;
  remainingCredits?: bigint | null;
  metadata?: unknown;
};

type CreditLedgerWriteInput = {
  walletAddress: string;
  direction: "CREDIT" | "DEBIT" | "ADJUSTMENT";
  amount: bigint;
  availableCreditsDelta?: bigint | null;
  heldCreditsDelta?: bigint | null;
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
      availableCreditsDelta:
        input.availableCreditsDelta == null ? null : toPrismaSignedInt(input.availableCreditsDelta, "availableCreditsDelta"),
      heldCreditsDelta:
        input.heldCreditsDelta == null ? null : toPrismaSignedInt(input.heldCreditsDelta, "heldCreditsDelta"),
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

  const created = await tx.accessNonce.createMany({
    data: [data],
    skipDuplicates: true,
  });

  if (input.enforceUnique && created.count === 0) {
    throw new AccessNonceReplayError();
  }

  return { accepted: created.count > 0 };
};

const resolveGateAccessEventTableAvailability = async (): Promise<boolean> => {
  if (gateAccessEventTableAvailable != null) {
    return gateAccessEventTableAvailable;
  }

  try {
    const tableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
      SELECT to_regclass('public."GateAccessEvent"')::text AS relation
    `);
    gateAccessEventTableAvailable = Boolean(tableCheck[0]?.relation);
  } catch {
    gateAccessEventTableAvailable = false;
  }

  return gateAccessEventTableAvailable;
};

export const logGateAccessEvent = async (input: GateAccessEventInput): Promise<void> => {
  if (!GATE_ACCESS_EVENT_LOG_ENABLED) return;

  const hasTable = await resolveGateAccessEventTableAvailability();
  if (!hasTable) return;

  try {
    await prisma.gateAccessEvent.create({
      data: {
        service: input.service,
        outcome: input.outcome,
        signer: normalizeSignerForLog(input.signer),
        nonce: input.nonce ?? null,
        requestId: input.requestId ?? null,
        cost: toPrismaOptionalInt(input.cost),
        remainingCredits: toPrismaOptionalInt(input.remainingCredits),
        metadata: (input.metadata as Prisma.InputJsonValue | null | undefined) ?? undefined,
      },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      gateAccessEventTableAvailable = false;
      return;
    }

    console.error("Failed to log gate access event.", error);
  }
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

export type SyncDepositsOptions = {
  expectedLastSyncedBlock?: bigint | null;
};

export type CreateFulfillmentHoldInput = {
  walletAddress: Address;
  serviceSlug: string;
  agentId?: string | null;
  gatewayConfigId?: string | null;
  merchantOwnerAddress: Address | string;
  requestMethod: string;
  requestPath: string;
  queryHash: `0x${string}` | string;
  bodyHash: `0x${string}` | string;
  cost: bigint;
  ticketId: `0x${string}` | string;
  issuedAt: Date;
  expiresAt: Date;
  requestNonce: string;
  requestAuthIssuedAtSeconds: bigint;
  requestAuthSignature?: `0x${string}` | string | null;
  requestId?: string | null;
  clientRequestId?: string | null;
  walletHoldCap: number;
};

export type CreateFulfillmentHoldResult =
  | {
      status: "ok";
      holdId: string;
      ticketId: string;
      walletAddress: string;
      serviceSlug: string;
      cost: bigint;
      creditsBefore: bigint;
      creditsAfter: bigint;
      heldCreditsBefore: bigint;
      heldCreditsAfter: bigint;
    }
  | { status: "insufficient_credits"; balance: bigint; required: bigint }
  | { status: "wallet_hold_cap_exceeded"; activeWalletHolds: number; walletHoldCap: number }
  | { status: "wallet_service_hold_exists" }
  | { status: "replay" };

export type CaptureFulfillmentHoldInput = {
  ticketId: `0x${string}` | string;
  deliveryProofId: `0x${string}` | string;
  merchantSigner: Address | string;
  serviceSlug: string;
  completedAt: Date;
  statusCode: bigint;
  latencyMs: bigint;
  responseHash?: `0x${string}` | string | null;
  proofTypedHash?: `0x${string}` | string | null;
  rawMeta?: Prisma.InputJsonValue | null;
};

export type CaptureFulfillmentHoldResult =
  | {
      status: "captured";
      holdId: string;
      ticketId: string;
      deliveryProofId: string;
      captureDisposition: "CAPTURED";
      serviceSlug: string;
      walletAddress: string;
      merchantSigner: string;
      state: "CAPTURED";
      capturedAt: Date;
      cost: bigint;
      creditsBefore: bigint;
      creditsAfter: bigint;
      heldCreditsBefore: bigint;
      heldCreditsAfter: bigint;
    }
  | {
      status: "idempotent_replay";
      holdId: string;
      ticketId: string;
      deliveryProofId: string;
      captureDisposition: "IDEMPOTENT_REPLAY";
      serviceSlug: string;
      walletAddress: string;
      merchantSigner: string;
      state: "CAPTURED";
      capturedAt: Date;
    }
  | { status: "hold_not_found" }
  | { status: "unauthorized_signer"; ticketId: string; holdId: string; gatewayConfigId: string | null }
  | { status: "service_mismatch"; ticketId: string; holdId: string; expectedServiceSlug: string; providedServiceSlug: string }
  | { status: "expired_due"; ticketId: string; holdId: string; expiresAt: Date }
  | { status: "terminal"; ticketId: string; holdId: string; state: "RELEASED" | "EXPIRED"; deliveryProofId: string | null }
  | { status: "capture_conflict"; ticketId: string; holdId: string; existingDeliveryProofId: string | null; state: "CAPTURED" };

export type FulfillmentExpireSweepCandidate = {
  id: string;
  ticketId: string;
  walletAddress: string;
  serviceSlug: string;
  cost: bigint;
  state: "HELD" | "CAPTURED" | "RELEASED" | "EXPIRED";
  expiresAt: Date;
};

export type FulfillmentExpireSweepItemResult =
  | {
      holdId: string;
      ticketId: string;
      status: "expired";
      walletAddress: string;
      serviceSlug: string;
      cost: bigint;
      creditsBefore: bigint;
      creditsAfter: bigint;
      heldCreditsBefore: bigint;
      heldCreditsAfter: bigint;
    }
  | {
      holdId: string;
      ticketId: string;
      status: "skipped_terminal" | "skipped_not_due";
      state: "HELD" | "CAPTURED" | "RELEASED" | "EXPIRED";
      expiresAt: Date;
    };

export type FulfillmentExpireSweepResult = {
  selected: number;
  processed: number;
  released: number;
  skippedTerminal: number;
  skippedNotDue: number;
  errors: number;
  results: FulfillmentExpireSweepItemResult[];
};

export type SyncDepositsResult = {
  before: bigint;
  added: bigint;
  after: bigint;
  lastSyncedBlock: bigint;
  applied: boolean;
  conflict: boolean;
};

export const syncDeposits = async (
  userAddress: Address,
  depositedWei: bigint,
  creditPriceWei: bigint,
  syncedToBlock: bigint,
  options?: SyncDepositsOptions,
): Promise<SyncDepositsResult> => {
  if (creditPriceWei <= 0n) {
    throw new Error("creditPriceWei must be greater than zero.");
  }
  if (syncedToBlock < 0n) {
    throw new Error("syncedToBlock must be non-negative.");
  }
  if (options?.expectedLastSyncedBlock != null && options.expectedLastSyncedBlock < 0n) {
    throw new Error("expectedLastSyncedBlock must be non-negative.");
  }

  const safeDeposited = depositedWei > 0n ? depositedWei : 0n;
  const addedCredits = safeDeposited / creditPriceWei;
  const key = normalizeAddressKey(userAddress);
  const expectedLastSyncedBlock = options?.expectedLastSyncedBlock ?? null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
    });

    const actualLastSyncedBlock = existing?.lastSyncedBlock ?? 0n;
    if (expectedLastSyncedBlock != null && actualLastSyncedBlock !== expectedLastSyncedBlock) {
      const currentCredits = BigInt(existing?.credits ?? 0);
      return {
        before: currentCredits,
        added: 0n,
        after: currentCredits,
        lastSyncedBlock: actualLastSyncedBlock,
        applied: false,
        conflict: true,
      };
    }

    if (!existing) {
      let created;
      try {
        created = await tx.creditBalance.create({
          data: {
            walletAddress: key,
            credits: toPrismaInt(addedCredits, "added credits"),
            lastSyncedBlock: syncedToBlock,
          },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          const current = await tx.creditBalance.findUnique({
            where: { walletAddress: key },
          });
          const currentCredits = BigInt(current?.credits ?? 0);
          return {
            before: currentCredits,
            added: 0n,
            after: currentCredits,
            lastSyncedBlock: current?.lastSyncedBlock ?? 0n,
            applied: false,
            conflict: true,
          };
        }

        throw error;
      }

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
        applied: true,
        conflict: false,
      };
    }

    const before = BigInt(existing.credits);
    const after = before + addedCredits;
    const nextLastSyncedBlock =
      syncedToBlock > existing.lastSyncedBlock ? syncedToBlock : existing.lastSyncedBlock;

    const casUpdated = await tx.creditBalance.updateMany({
      where: {
        walletAddress: key,
        lastSyncedBlock: existing.lastSyncedBlock,
      },
      data: {
        credits: toPrismaInt(after, "credits"),
        lastSyncedBlock: nextLastSyncedBlock,
      },
    });

    if (casUpdated.count === 0) {
      const current = await tx.creditBalance.findUnique({
        where: { walletAddress: key },
      });
      const currentCredits = BigInt(current?.credits ?? 0);
      return {
        before: currentCredits,
        added: 0n,
        after: currentCredits,
        lastSyncedBlock: current?.lastSyncedBlock ?? 0n,
        applied: false,
        conflict: true,
      };
    }

    const updated = await tx.creditBalance.findUnique({
      where: { walletAddress: key },
    });
    if (!updated) {
      throw new Error("Credit balance row disappeared during sync.");
    }

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
      applied: true,
      conflict: false,
    };
  });
};

const expireOverdueHeldFulfillmentHoldsForWallet = async (input: {
  tx: Prisma.TransactionClient;
  walletAddress: string;
  now: Date;
  creditsBefore: bigint;
  heldCreditsBefore: bigint;
}): Promise<{ credits: bigint; heldCredits: bigint }> => {
  const overdueHolds = await input.tx.$queryRaw<
    Array<{
      id: string;
      ticketId: string;
      walletAddress: string;
      serviceSlug: string;
      cost: number;
      state: "HELD" | "CAPTURED" | "RELEASED" | "EXPIRED";
      expiresAt: Date;
    }>
  >(Prisma.sql`
    SELECT "id", "ticketId", "walletAddress", "serviceSlug", "cost", "state", "expiresAt"
    FROM "FulfillmentHold"
    WHERE "walletAddress" = ${input.walletAddress}
      AND "state" = 'HELD'
      AND "expiresAt" <= ${input.now}
    ORDER BY "expiresAt" ASC, "createdAt" ASC
    FOR UPDATE
  `);

  let credits = input.creditsBefore;
  let heldCredits = input.heldCreditsBefore;

  for (const hold of overdueHolds) {
    const cost = BigInt(hold.cost);
    if (heldCredits < cost) {
      throw new Error(
        `heldCredits invariant violation for wallet ${hold.walletAddress}: held=${heldCredits} cost=${cost}`,
      );
    }

    await input.tx.fulfillmentHold.update({
      where: { id: hold.id },
      data: {
        state: "EXPIRED",
        releasedAt: input.now,
        releaseReason: "TTL_EXPIRED",
        lastError: null,
      },
    });

    const updatedBalance = await input.tx.creditBalance.update({
      where: { walletAddress: input.walletAddress },
      data: {
        credits: { increment: hold.cost },
        heldCredits: { decrement: hold.cost },
      },
    });

    const creditsAfter = BigInt(updatedBalance.credits);
    const heldCreditsAfter = BigInt(updatedBalance.heldCredits);

    await writeCreditLedger(input.tx, {
      walletAddress: hold.walletAddress,
      direction: "CREDIT",
      amount: cost,
      availableCreditsDelta: cost,
      heldCreditsDelta: -cost,
      balanceBefore: credits,
      balanceAfter: creditsAfter,
      reason: "FULFILLMENT_HOLD_EXPIRED",
      service: hold.serviceSlug,
      requestId: `${hold.ticketId}:expire`,
      metadata: {
        ticketId: hold.ticketId,
        holdId: hold.id,
        serviceSlug: hold.serviceSlug,
        releaseReason: "TTL_EXPIRED",
        expiredAt: input.now.toISOString(),
        expiredDuringTicketIssuance: true,
      },
    });

    credits = creditsAfter;
    heldCredits = heldCreditsAfter;
  }

  return { credits, heldCredits };
};

export const createFulfillmentHold = async (
  input: CreateFulfillmentHoldInput,
): Promise<CreateFulfillmentHoldResult> => {
  if (input.cost <= 0n) {
    throw new Error("Fulfillment hold cost must be greater than zero.");
  }
  if (!Number.isInteger(input.walletHoldCap) || input.walletHoldCap <= 0) {
    throw new Error("walletHoldCap must be a positive integer.");
  }

  const walletKey = normalizeAddressKey(input.walletAddress);
  const merchantOwnerKey = normalizeSignerKey(input.merchantOwnerAddress);
  const ticketId = String(input.ticketId).trim().toLowerCase();
  const queryHash = String(input.queryHash).trim().toLowerCase();
  const bodyHash = String(input.bodyHash).trim().toLowerCase();
  const requestNonce = input.requestNonce.trim();
  const requestId = ticketId;
  const ledgerClientRequestId = input.clientRequestId?.trim() || null;
  const debit = toPrismaInt(input.cost, "fulfillment hold cost");

  try {
    return await prisma.$transaction(async (tx) => {
      const lockedBalanceRows = await tx.$queryRaw<Array<{ walletAddress: string; credits: number; heldCredits: number }>>(
        Prisma.sql`
          SELECT "walletAddress", "credits", "heldCredits"
          FROM "CreditBalance"
          WHERE "walletAddress" = ${walletKey}
          FOR UPDATE
        `,
      );

      const lockedBalance = lockedBalanceRows[0];
      let creditsBefore = BigInt(lockedBalance?.credits ?? 0);
      if (!lockedBalance) {
        return {
          status: "insufficient_credits",
          balance: creditsBefore,
          required: input.cost,
        } satisfies CreateFulfillmentHoldResult;
      }

      let heldCreditsBefore = BigInt(lockedBalance.heldCredits);
      const sweptBalance = await expireOverdueHeldFulfillmentHoldsForWallet({
        tx,
        walletAddress: walletKey,
        now: new Date(),
        creditsBefore,
        heldCreditsBefore,
      });
      creditsBefore = sweptBalance.credits;
      heldCreditsBefore = sweptBalance.heldCredits;

      if (creditsBefore < input.cost) {
        return {
          status: "insufficient_credits",
          balance: creditsBefore,
          required: input.cost,
        } satisfies CreateFulfillmentHoldResult;
      }

      const activeWalletHolds = await tx.fulfillmentHold.count({
        where: {
          walletAddress: walletKey,
          state: "HELD",
        },
      });
      if (activeWalletHolds >= input.walletHoldCap) {
        return {
          status: "wallet_hold_cap_exceeded",
          activeWalletHolds,
          walletHoldCap: input.walletHoldCap,
        } satisfies CreateFulfillmentHoldResult;
      }

      await persistAccessNonce(tx, {
        signer: normalizeSignerKey(input.walletAddress),
        service: `fulfillment_ticket:${input.serviceSlug}`,
        nonce: requestNonce,
        payloadTimestamp: input.requestAuthIssuedAtSeconds,
        signature: input.requestAuthSignature ?? null,
        enforceUnique: true,
      });

      const updatedBalance = await tx.creditBalance.update({
        where: { walletAddress: walletKey },
        data: {
          credits: { decrement: debit },
          heldCredits: { increment: debit },
        },
      });

      const creditsAfter = BigInt(updatedBalance.credits);
      const heldCreditsAfter = BigInt(updatedBalance.heldCredits);

      const hold = await tx.fulfillmentHold.create({
        data: {
          ticketId,
          walletAddress: walletKey,
          serviceSlug: input.serviceSlug,
          agentId: input.agentId ?? null,
          gatewayConfigId: input.gatewayConfigId ?? null,
          merchantOwnerAddress: merchantOwnerKey,
          requestMethod: input.requestMethod,
          requestPath: input.requestPath,
          queryHash,
          bodyHash,
          cost: debit,
          state: "HELD",
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
        },
      });

      await writeCreditLedger(tx, {
        walletAddress: walletKey,
        direction: "DEBIT",
        amount: input.cost,
        availableCreditsDelta: -input.cost,
        heldCreditsDelta: input.cost,
        balanceBefore: creditsBefore,
        balanceAfter: creditsAfter,
        reason: "FULFILLMENT_HOLD_CREATED",
        service: input.serviceSlug,
        nonce: requestNonce,
        requestId,
        metadata: {
          ticketId,
          holdId: hold.id,
          serviceSlug: input.serviceSlug,
          agentId: input.agentId ?? null,
          gatewayConfigId: input.gatewayConfigId ?? null,
          merchantOwnerAddress: merchantOwnerKey,
          cost: input.cost.toString(),
          request: {
            method: input.requestMethod,
            path: input.requestPath,
            queryHash,
            bodyHash,
          },
          clientRequestId: ledgerClientRequestId,
          issuedAt: input.issuedAt.toISOString(),
          expiresAt: input.expiresAt.toISOString(),
        },
      });

      return {
        status: "ok",
        holdId: hold.id,
        ticketId,
        walletAddress: walletKey,
        serviceSlug: input.serviceSlug,
        cost: input.cost,
        creditsBefore,
        creditsAfter,
        heldCreditsBefore,
        heldCreditsAfter,
      } satisfies CreateFulfillmentHoldResult;
    });
  } catch (error) {
    if (error instanceof AccessNonceReplayError) {
      return { status: "replay" };
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = (() => {
        const meta = error.meta as { target?: unknown } | undefined;
        if (Array.isArray(meta?.target)) return meta?.target.join(",");
        return typeof meta?.target === "string" ? meta.target : "";
      })();
      const normalizedTarget = target.toLowerCase();
      if (
        normalizedTarget.includes("fulfillmenthold_wallet_service_active_held_idx") ||
        error.message.includes("FulfillmentHold_wallet_service_active_held_idx") ||
        (normalizedTarget.includes("walletaddress") && normalizedTarget.includes("serviceslug"))
      ) {
        return { status: "wallet_service_hold_exists" };
      }
    }

    throw error;
  }
};

export const captureFulfillmentHold = async (
  input: CaptureFulfillmentHoldInput,
): Promise<CaptureFulfillmentHoldResult> => {
  const ticketId = String(input.ticketId).trim().toLowerCase();
  const deliveryProofId = String(input.deliveryProofId).trim().toLowerCase();
  const merchantSigner = normalizeSignerKey(input.merchantSigner);
  const serviceSlug = input.serviceSlug.trim();
  if (!ticketId || !deliveryProofId || !serviceSlug) {
    throw new Error("captureFulfillmentHold requires ticketId, deliveryProofId, and serviceSlug.");
  }
  if (input.statusCode < 0n || input.latencyMs < 0n) {
    throw new Error("captureFulfillmentHold statusCode/latencyMs must be non-negative.");
  }

  const statusCodeInt = toPrismaOptionalInt(input.statusCode);
  const latencyMsInt = toPrismaOptionalInt(input.latencyMs);
  const responseHash = typeof input.responseHash === "string" ? input.responseHash.trim().toLowerCase() : null;

  return prisma.$transaction(async (tx) => {
    const lockedHoldRows = await tx.$queryRaw<
      Array<{
        id: string;
        ticketId: string;
        walletAddress: string;
        serviceSlug: string;
        gatewayConfigId: string | null;
        merchantOwnerAddress: string;
        cost: number;
        state: "HELD" | "CAPTURED" | "RELEASED" | "EXPIRED";
        expiresAt: Date | string;
        capturedAt: Date | string | null;
        captureDeliveryProofId: string | null;
      }>
    >(Prisma.sql`
      SELECT
        "id",
        "ticketId",
        "walletAddress",
        "serviceSlug",
        "gatewayConfigId",
        "merchantOwnerAddress",
        "cost",
        "state",
        "expiresAt",
        "capturedAt",
        "captureDeliveryProofId"
      FROM "FulfillmentHold"
      WHERE "ticketId" = ${ticketId}
      FOR UPDATE
    `);

    const hold = lockedHoldRows[0];
    if (!hold) {
      return { status: "hold_not_found" } satisfies CaptureFulfillmentHoldResult;
    }

    const createAttempt = async (args: {
      success: boolean;
      httpStatus: number;
      captureDisposition?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }): Promise<void> => {
      await tx.fulfillmentCaptureAttempt.create({
        data: {
          holdId: hold.id,
          ticketId: hold.ticketId,
          deliveryProofId,
          merchantSigner,
          success: args.success,
          httpStatus: args.httpStatus,
          captureDisposition: args.captureDisposition ?? null,
          errorCode: args.errorCode ?? null,
          errorMessage: args.errorMessage ?? null,
          rawMeta: input.rawMeta ?? undefined,
        },
      });
    };

    if (hold.serviceSlug !== serviceSlug) {
      await createAttempt({
        success: false,
        httpStatus: 409,
        errorCode: "SERVICE_MISMATCH",
        errorMessage: "delivery proof serviceSlug does not match held serviceSlug",
      });
      return {
        status: "service_mismatch",
        ticketId: hold.ticketId,
        holdId: hold.id,
        expectedServiceSlug: hold.serviceSlug,
        providedServiceSlug: serviceSlug,
      } satisfies CaptureFulfillmentHoldResult;
    }

    if (!hold.gatewayConfigId) {
      await createAttempt({
        success: false,
        httpStatus: 403,
        errorCode: "UNAUTHORIZED_DELEGATED_SIGNER",
        errorMessage: "hold has no gateway config bound",
      });
      return {
        status: "unauthorized_signer",
        ticketId: hold.ticketId,
        holdId: hold.id,
        gatewayConfigId: null,
      } satisfies CaptureFulfillmentHoldResult;
    }

    const activeSigner = await tx.agentGatewayDelegatedSigner.findFirst({
      where: {
        gatewayConfigId: hold.gatewayConfigId,
        signerAddress: merchantSigner,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!activeSigner) {
      await createAttempt({
        success: false,
        httpStatus: 403,
        errorCode: "UNAUTHORIZED_DELEGATED_SIGNER",
        errorMessage: "merchant signer is not active for gateway config",
      });
      return {
        status: "unauthorized_signer",
        ticketId: hold.ticketId,
        holdId: hold.id,
        gatewayConfigId: hold.gatewayConfigId,
      } satisfies CaptureFulfillmentHoldResult;
    }

    const holdExpiresAt = toJsDate(hold.expiresAt, "FulfillmentHold.expiresAt");
    const holdCapturedAt = hold.capturedAt == null ? null : toJsDate(hold.capturedAt, "FulfillmentHold.capturedAt");

    if (hold.state === "CAPTURED") {
      if (hold.captureDeliveryProofId && hold.captureDeliveryProofId === deliveryProofId && holdCapturedAt) {
        await createAttempt({
          success: true,
          httpStatus: 200,
          captureDisposition: "IDEMPOTENT_REPLAY",
        });
        return {
          status: "idempotent_replay",
          holdId: hold.id,
          ticketId: hold.ticketId,
          deliveryProofId,
          captureDisposition: "IDEMPOTENT_REPLAY",
          serviceSlug: hold.serviceSlug,
          walletAddress: hold.walletAddress,
          merchantSigner,
          state: "CAPTURED",
          capturedAt: holdCapturedAt,
        } satisfies CaptureFulfillmentHoldResult;
      }

      await createAttempt({
        success: false,
        httpStatus: 409,
        errorCode: "CAPTURE_CONFLICT",
        errorMessage: "ticket already captured with a different delivery proof",
      });
      return {
        status: "capture_conflict",
        ticketId: hold.ticketId,
        holdId: hold.id,
        existingDeliveryProofId: hold.captureDeliveryProofId,
        state: "CAPTURED",
      } satisfies CaptureFulfillmentHoldResult;
    }

    if (hold.state === "RELEASED" || hold.state === "EXPIRED") {
      await createAttempt({
        success: false,
        httpStatus: 409,
        errorCode: "HOLD_NOT_ACTIVE",
        errorMessage: `ticket hold is ${hold.state.toLowerCase()}`,
      });
      return {
        status: "terminal",
        ticketId: hold.ticketId,
        holdId: hold.id,
        state: hold.state,
        deliveryProofId: hold.captureDeliveryProofId,
      } satisfies CaptureFulfillmentHoldResult;
    }

    if (holdExpiresAt <= input.completedAt) {
      await createAttempt({
        success: false,
        httpStatus: 409,
        errorCode: "HOLD_EXPIRED",
        errorMessage: "ticket hold expired before capture completion",
      });
      return {
        status: "expired_due",
        ticketId: hold.ticketId,
        holdId: hold.id,
        expiresAt: holdExpiresAt,
      } satisfies CaptureFulfillmentHoldResult;
    }

    const lockedBalanceRows = await tx.$queryRaw<Array<{ walletAddress: string; credits: number; heldCredits: number }>>(
      Prisma.sql`
        SELECT "walletAddress", "credits", "heldCredits"
        FROM "CreditBalance"
        WHERE "walletAddress" = ${hold.walletAddress}
        FOR UPDATE
      `,
    );

    const balance = lockedBalanceRows[0];
    if (!balance) {
      throw new Error(`CreditBalance missing for fulfillment hold wallet ${hold.walletAddress}`);
    }

    const cost = BigInt(hold.cost);
    const creditsBefore = BigInt(balance.credits);
    const heldCreditsBefore = BigInt(balance.heldCredits);
    if (heldCreditsBefore < cost) {
      throw new Error(
        `heldCredits invariant violation for wallet ${hold.walletAddress}: held=${heldCreditsBefore} cost=${cost}`,
      );
    }

    await tx.fulfillmentHold.update({
      where: { id: hold.id },
      data: {
        state: "CAPTURED",
        capturedAt: input.completedAt,
        captureDeliveryProofId: deliveryProofId,
        captureStatusCode: statusCodeInt,
        captureLatencyMs: latencyMsInt,
        releasedAt: null,
        releaseReason: null,
        lastError: null,
      },
    });

    const updatedBalance = await tx.creditBalance.update({
      where: { walletAddress: hold.walletAddress },
      data: {
        heldCredits: { decrement: hold.cost },
      },
    });

    const creditsAfter = BigInt(updatedBalance.credits);
    const heldCreditsAfter = BigInt(updatedBalance.heldCredits);

    await writeCreditLedger(tx, {
      walletAddress: hold.walletAddress,
      direction: "DEBIT",
      amount: cost,
      availableCreditsDelta: 0n,
      heldCreditsDelta: -cost,
      balanceBefore: creditsBefore,
      balanceAfter: creditsAfter,
      reason: "FULFILLMENT_CAPTURE_FINALIZED",
      service: hold.serviceSlug,
      requestId: `${hold.ticketId}:capture`,
      metadata: {
        holdId: hold.id,
        ticketId: hold.ticketId,
        deliveryProofId,
        serviceSlug: hold.serviceSlug,
        merchantSigner,
        merchantOwnerAddress: hold.merchantOwnerAddress,
        completedAt: input.completedAt.toISOString(),
        statusCode: input.statusCode.toString(),
        latencyMs: input.latencyMs.toString(),
        responseHash,
        proofTypedHash: input.proofTypedHash ?? null,
      },
    });

    await createAttempt({
      success: true,
      httpStatus: 200,
      captureDisposition: "CAPTURED",
    });

    return {
      status: "captured",
      holdId: hold.id,
      ticketId: hold.ticketId,
      deliveryProofId,
      captureDisposition: "CAPTURED",
      serviceSlug: hold.serviceSlug,
      walletAddress: hold.walletAddress,
      merchantSigner,
      state: "CAPTURED",
      capturedAt: input.completedAt,
      cost,
      creditsBefore,
      creditsAfter,
      heldCreditsBefore,
      heldCreditsAfter,
    } satisfies CaptureFulfillmentHoldResult;
  });
};

export const listExpiredFulfillmentHoldCandidates = async (input: {
  now?: Date;
  limit: number;
}): Promise<FulfillmentExpireSweepCandidate[]> => {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("Fulfillment expire sweep limit must be a positive integer.");
  }

  const now = input.now ?? new Date();
  const rows = await prisma.fulfillmentHold.findMany({
    where: {
      state: "HELD",
      expiresAt: { lte: now },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    take: input.limit,
    select: {
      id: true,
      ticketId: true,
      walletAddress: true,
      serviceSlug: true,
      cost: true,
      state: true,
      expiresAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticketId,
    walletAddress: row.walletAddress,
    serviceSlug: row.serviceSlug,
    cost: BigInt(row.cost),
    state: row.state,
    expiresAt: row.expiresAt,
  }));
};

const expireFulfillmentHoldById = async (input: {
  holdId: string;
  now: Date;
}): Promise<FulfillmentExpireSweepItemResult> => {
  return prisma.$transaction(async (tx) => {
    const lockedHoldRows = await tx.$queryRaw<
      Array<{
        id: string;
        ticketId: string;
        walletAddress: string;
        serviceSlug: string;
        cost: number;
        state: "HELD" | "CAPTURED" | "RELEASED" | "EXPIRED";
        expiresAt: Date;
      }>
    >(Prisma.sql`
      SELECT "id", "ticketId", "walletAddress", "serviceSlug", "cost", "state", "expiresAt"
      FROM "FulfillmentHold"
      WHERE "id" = ${input.holdId}
      FOR UPDATE
    `);

    const hold = lockedHoldRows[0];
    if (!hold) {
      throw new Error(`Fulfillment hold not found during expire sweep: ${input.holdId}`);
    }

    if (hold.state !== "HELD") {
      return {
        holdId: hold.id,
        ticketId: hold.ticketId,
        status: "skipped_terminal",
        state: hold.state,
        expiresAt: hold.expiresAt,
      };
    }

    if (hold.expiresAt > input.now) {
      return {
        holdId: hold.id,
        ticketId: hold.ticketId,
        status: "skipped_not_due",
        state: hold.state,
        expiresAt: hold.expiresAt,
      };
    }

    const lockedBalanceRows = await tx.$queryRaw<Array<{ walletAddress: string; credits: number; heldCredits: number }>>(
      Prisma.sql`
        SELECT "walletAddress", "credits", "heldCredits"
        FROM "CreditBalance"
        WHERE "walletAddress" = ${hold.walletAddress}
        FOR UPDATE
      `,
    );
    const balance = lockedBalanceRows[0];
    if (!balance) {
      throw new Error(`CreditBalance missing for fulfillment hold wallet ${hold.walletAddress}`);
    }

    const cost = BigInt(hold.cost);
    const creditsBefore = BigInt(balance.credits);
    const heldCreditsBefore = BigInt(balance.heldCredits);
    if (heldCreditsBefore < cost) {
      throw new Error(
        `heldCredits invariant violation for wallet ${hold.walletAddress}: held=${heldCreditsBefore} cost=${cost}`,
      );
    }

    await tx.fulfillmentHold.update({
      where: { id: hold.id },
      data: {
        state: "EXPIRED",
        releasedAt: input.now,
        releaseReason: "TTL_EXPIRED",
        lastError: null,
      },
    });

    const updatedBalance = await tx.creditBalance.update({
      where: { walletAddress: hold.walletAddress },
      data: {
        credits: { increment: hold.cost },
        heldCredits: { decrement: hold.cost },
      },
    });

    const creditsAfter = BigInt(updatedBalance.credits);
    const heldCreditsAfter = BigInt(updatedBalance.heldCredits);

    await writeCreditLedger(tx, {
      walletAddress: hold.walletAddress,
      direction: "CREDIT",
      amount: cost,
      availableCreditsDelta: cost,
      heldCreditsDelta: -cost,
      balanceBefore: creditsBefore,
      balanceAfter: creditsAfter,
      reason: "FULFILLMENT_HOLD_EXPIRED",
      service: hold.serviceSlug,
      requestId: `${hold.ticketId}:expire`,
      metadata: {
        ticketId: hold.ticketId,
        holdId: hold.id,
        serviceSlug: hold.serviceSlug,
        releaseReason: "TTL_EXPIRED",
        expiredAt: input.now.toISOString(),
      },
    });

    return {
      holdId: hold.id,
      ticketId: hold.ticketId,
      status: "expired",
      walletAddress: hold.walletAddress,
      serviceSlug: hold.serviceSlug,
      cost,
      creditsBefore,
      creditsAfter,
      heldCreditsBefore,
      heldCreditsAfter,
    };
  });
};

export const expireFulfillmentHolds = async (input: {
  now?: Date;
  limit: number;
}): Promise<FulfillmentExpireSweepResult> => {
  const now = input.now ?? new Date();
  const candidates = await listExpiredFulfillmentHoldCandidates({ now, limit: input.limit });

  const results: FulfillmentExpireSweepItemResult[] = [];
  let released = 0;
  let skippedTerminal = 0;
  let skippedNotDue = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      const result = await expireFulfillmentHoldById({ holdId: candidate.id, now });
      results.push(result);
      if (result.status === "expired") released += 1;
      else if (result.status === "skipped_terminal") skippedTerminal += 1;
      else if (result.status === "skipped_not_due") skippedNotDue += 1;
    } catch (error) {
      errors += 1;
      console.error("Fulfillment expire sweep failed for hold.", {
        holdId: candidate.id,
        ticketId: candidate.ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    selected: candidates.length,
    processed: results.length,
    released,
    skippedTerminal,
    skippedNotDue,
    errors,
    results,
  };
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
