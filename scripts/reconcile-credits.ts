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

const failOnMismatch = process.env.CREDIT_RECONCILE_FAIL_ON_MISMATCH === "true";

const run = async (): Promise<void> => {
  const tableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass('public."CreditLedger"')::text AS relation
  `);
  if (!tableCheck[0]?.relation) {
    console.warn('Credit reconcile skipped: table "CreditLedger" does not exist yet. Run migrations first.');
    return;
  }

  const balances = await prisma.creditBalance.findMany({
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

  if (failOnMismatch && drift.length > 0) {
    throw new Error(`Credit reconciliation failed with ${drift.length} drift rows.`);
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
