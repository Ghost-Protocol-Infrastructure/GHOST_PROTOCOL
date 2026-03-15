import { config as loadEnv } from "dotenv";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

type LatestLedgerRow = {
  walletAddress: string;
  balanceAfter: number;
  createdAt: Date;
};

type CreditBalanceRow = {
  walletAddress: string;
  credits: number;
  heldCredits?: number;
  lastSyncedBlock: bigint;
  updatedAt: Date;
};

type HeldAggregateRow = {
  walletAddress: string;
  heldCostSum: bigint | number | string | null;
};

const failOnMismatch = process.env.CREDIT_RECONCILE_FAIL_ON_MISMATCH === "true";

const toBigIntValue = (value: bigint | number | string | null | undefined): bigint => {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
};

const run = async (): Promise<void> => {
  const tableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass('public."CreditLedger"')::text AS relation
  `);
  if (!tableCheck[0]?.relation) {
    console.warn('Credit reconcile skipped: table "CreditLedger" does not exist yet. Run migrations first.');
    return;
  }

  const heldCreditsColumnCheck = await prisma.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'CreditBalance'
        AND column_name = 'heldCredits'
    ) AS present
  `);
  const hasHeldCreditsColumn = Boolean(heldCreditsColumnCheck[0]?.present);

  const fulfillmentHoldTableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass('public."FulfillmentHold"')::text AS relation
  `);
  const hasFulfillmentHoldTable = Boolean(fulfillmentHoldTableCheck[0]?.relation);

  const balances: CreditBalanceRow[] = hasHeldCreditsColumn
    ? await prisma.creditBalance.findMany({
        select: {
          walletAddress: true,
          credits: true,
          heldCredits: true,
          lastSyncedBlock: true,
          updatedAt: true,
        },
      })
    : await prisma.creditBalance.findMany({
        select: {
          walletAddress: true,
          credits: true,
          lastSyncedBlock: true,
          updatedAt: true,
        },
      });

  const latestLedgerRows = await prisma.$queryRaw<LatestLedgerRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("walletAddress")
      "walletAddress",
      "balanceAfter",
      "createdAt"
    FROM "CreditLedger"
    ORDER BY "walletAddress", "createdAt" DESC
  `);

  const latestByWallet = new Map<string, LatestLedgerRow>();
  for (const row of latestLedgerRows) {
    latestByWallet.set(row.walletAddress, row);
  }

  const missingLedger: string[] = [];
  const drift: Array<{ walletAddress: string; balance: number; ledgerBalanceAfter: number }> = [];
  const heldDrift: Array<{ walletAddress: string; heldCredits: bigint; heldFromActiveHolds: bigint }> = [];

  for (const balance of balances) {
    const latest = latestByWallet.get(balance.walletAddress);
    if (!latest) {
      missingLedger.push(balance.walletAddress);
      continue;
    }

    if (latest.balanceAfter !== balance.credits) {
      drift.push({
        walletAddress: balance.walletAddress,
        balance: balance.credits,
        ledgerBalanceAfter: latest.balanceAfter,
      });
    }
  }

  if (hasHeldCreditsColumn && hasFulfillmentHoldTable) {
    const heldAggregates = await prisma.$queryRaw<HeldAggregateRow[]>(Prisma.sql`
      SELECT
        "walletAddress",
        COALESCE(SUM("cost"), 0)::bigint AS "heldCostSum"
      FROM "FulfillmentHold"
      WHERE "state" = 'HELD'
      GROUP BY "walletAddress"
    `);

    const heldByWallet = new Map<string, bigint>();
    for (const row of heldAggregates) {
      heldByWallet.set(row.walletAddress, toBigIntValue(row.heldCostSum));
    }

    for (const balance of balances) {
      const heldCredits = BigInt(balance.heldCredits ?? 0);
      const heldFromActiveHolds = heldByWallet.get(balance.walletAddress) ?? 0n;
      if (heldCredits !== heldFromActiveHolds) {
        heldDrift.push({
          walletAddress: balance.walletAddress,
          heldCredits,
          heldFromActiveHolds,
        });
      }
    }
  }

  const creditAggregate = await prisma.creditLedger.aggregate({
    where: { direction: "CREDIT" },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const debitAggregate = await prisma.creditLedger.aggregate({
    where: { direction: "DEBIT" },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const totalBalanceCredits = balances.reduce((sum, row) => sum + BigInt(row.credits), 0n);
  const ledgerCredits = BigInt(creditAggregate._sum.amount ?? 0);
  const ledgerDebits = BigInt(debitAggregate._sum.amount ?? 0);
  const netLedgerFlow = ledgerCredits - ledgerDebits;

  console.log(
    [
      `Credit reconcile summary:`,
      `wallet_balances=${balances.length}`,
      `ledger_rows=${latestLedgerRows.length}`,
      `credit_entries=${creditAggregate._count._all}`,
      `debit_entries=${debitAggregate._count._all}`,
      `missing_ledger=${missingLedger.length}`,
      `drift=${drift.length}`,
      `held_drift=${heldDrift.length}`,
      `total_balance_credits=${totalBalanceCredits.toString()}`,
      `net_ledger_flow=${netLedgerFlow.toString()}`,
    ].join(" "),
  );

  if (missingLedger.length > 0) {
    console.warn(
      `Credit reconcile warning: ${missingLedger.length} wallets have balances without ledger rows (expected during legacy backfill).`,
    );
  }

  if (drift.length > 0) {
    const sample = drift.slice(0, 10);
    console.warn(`Credit reconcile warning: found ${drift.length} wallet balance drift rows.`);
    console.warn(
      "Drift sample:",
      sample.map((row) => ({
        walletAddress: row.walletAddress,
        balance: row.balance,
        ledgerBalanceAfter: row.ledgerBalanceAfter,
      })),
    );
  }

  if (!hasHeldCreditsColumn) {
    console.warn('Held-credit reconcile skipped: column "CreditBalance.heldCredits" does not exist yet. Run the fulfillment schema migration first.');
  } else if (!hasFulfillmentHoldTable) {
    console.warn('Held-credit reconcile skipped: table "FulfillmentHold" does not exist yet. Run the fulfillment schema migration first.');
  } else if (heldDrift.length > 0) {
    const sample = heldDrift.slice(0, 10);
    console.warn(`Held-credit reconcile warning: found ${heldDrift.length} heldCredits drift rows.`);
    console.warn(
      "Held drift sample:",
      sample.map((row) => ({
        walletAddress: row.walletAddress,
        heldCredits: row.heldCredits.toString(),
        heldFromActiveHolds: row.heldFromActiveHolds.toString(),
      })),
    );
  }

  if (failOnMismatch && (drift.length > 0 || heldDrift.length > 0)) {
    throw new Error(
      `Credit reconciliation failed with ${drift.length} balance drift rows and ${heldDrift.length} held drift rows.`,
    );
  }
};

run()
  .catch((error) => {
    console.error("Credit reconciliation failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
