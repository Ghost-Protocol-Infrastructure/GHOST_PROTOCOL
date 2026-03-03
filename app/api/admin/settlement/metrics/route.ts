import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { parsePositiveIntBounded } from "@/lib/fulfillment-route";
import { GHOST_CREDIT_PRICE_WEI, GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "@/lib/constants";
import { getMerchantSettlementSummary, prisma } from "@/lib/db";
import { createSettlementPublicClient } from "@/lib/merchant-settlement-chain";
import { settlementJson, isSettlementSupportAuthorized } from "@/lib/merchant-settlement-route";

export const runtime = "nodejs";

const DEFAULT_WINDOW_MINUTES = 24 * 60;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;

const countByKey = <T extends string | null>(
  rows: Array<{ key: T; count: number }>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.key == null || row.key === "" ? "UNKNOWN" : row.key;
    out[key] = (out[key] ?? 0) + row.count;
  }
  return out;
};

export async function GET(request: NextRequest) {
  if (!isSettlementSupportAuthorized(request)) {
    return settlementJson(
      { code: 401, error: "Unauthorized settlement support request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const serviceSlugRaw = request.nextUrl.searchParams.get("serviceSlug")?.trim();
  const serviceSlug = serviceSlugRaw ? serviceSlugRaw : null;
  const windowMinutes = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("windowMinutes"),
    fallback: DEFAULT_WINDOW_MINUTES,
    max: MAX_WINDOW_MINUTES,
  });
  const since = new Date(Date.now() - windowMinutes * 60_000);

  try {
    const [summary, batchCounts, oldestOpenBatch, oldestSubmittedBatch, failedByCode, vaultSnapshot] = await Promise.all([
      getMerchantSettlementSummary({
        serviceSlug,
        createdAtGte: since,
      }),
      prisma.merchantSettlementBatch.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.merchantSettlementBatch.findFirst({
        where: { status: "OPEN" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.merchantSettlementBatch.findFirst({
        where: { status: "SUBMITTED" },
        orderBy: { submittedAt: "asc" },
        select: { submittedAt: true, createdAt: true },
      }),
      prisma.merchantEarning.groupBy({
        by: ["failureCode"],
        where: {
          status: "FAILED",
          ...(serviceSlug ? { serviceSlug } : {}),
          createdAt: { gte: since },
        },
        _count: { _all: true },
      }),
      (async () => {
        const client = createSettlementPublicClient();
        try {
          const [creditPriceWei, totalLiability, accruedFees] = await Promise.all([
            client.readContract({
              address: GHOST_VAULT_ADDRESS,
              abi: GHOST_VAULT_ABI,
              functionName: "creditPriceWei",
            }),
            client.readContract({
              address: GHOST_VAULT_ADDRESS,
              abi: GHOST_VAULT_ABI,
              functionName: "totalLiability",
            }),
            client.readContract({
              address: GHOST_VAULT_ADDRESS,
              abi: GHOST_VAULT_ABI,
              functionName: "accruedFees",
            }),
          ]);

          return {
            readable: true,
            creditPriceWei,
            totalLiability,
            accruedFees,
            error: null,
          };
        } catch (error) {
          return {
            readable: false,
            creditPriceWei: null,
            totalLiability: null,
            accruedFees: null,
            error: error instanceof Error ? error.message : "Failed to read GhostVault settlement metrics.",
          };
        }
      })(),
    ]);

    const batchesByStatus = countByKey(batchCounts.map((row) => ({ key: row.status, count: row._count._all })));
    const failuresByCode = countByKey(failedByCode.map((row) => ({ key: row.failureCode, count: row._count._all })));
    const pendingAgeMinutes = summary.pending.oldestCreatedAt
      ? Math.max(0, Math.round((Date.now() - summary.pending.oldestCreatedAt.getTime()) / 60_000))
      : null;
    const submittedAgeMinutes = oldestSubmittedBatch?.submittedAt
      ? Math.max(0, Math.round((Date.now() - oldestSubmittedBatch.submittedAt.getTime()) / 60_000))
      : oldestSubmittedBatch?.createdAt
        ? Math.max(0, Math.round((Date.now() - oldestSubmittedBatch.createdAt.getTime()) / 60_000))
        : null;
    const unsettledNetWei = summary.pending.netWei + summary.submitted.netWei;

    return settlementJson(
      {
        ok: true,
        authMode: "bearer-secret",
        window: {
          minutes: windowMinutes,
          since: since.toISOString(),
          now: new Date().toISOString(),
        },
        filter: {
          serviceSlug,
        },
        earnings: {
          pending: {
            count: summary.pending.count,
            grossWei: summary.pending.grossWei.toString(),
            feeWei: summary.pending.feeWei.toString(),
            netWei: summary.pending.netWei.toString(),
            oldestCreatedAt: summary.pending.oldestCreatedAt?.toISOString() ?? null,
            backlogAgeMinutes: pendingAgeMinutes,
          },
          submitted: {
            count: summary.submitted.count,
            grossWei: summary.submitted.grossWei.toString(),
            feeWei: summary.submitted.feeWei.toString(),
            netWei: summary.submitted.netWei.toString(),
            oldestCreatedAt: summary.submitted.oldestCreatedAt?.toISOString() ?? null,
            backlogAgeMinutes: submittedAgeMinutes,
          },
          confirmed: {
            count: summary.confirmed.count,
            grossWei: summary.confirmed.grossWei.toString(),
            feeWei: summary.confirmed.feeWei.toString(),
            netWei: summary.confirmed.netWei.toString(),
          },
          failed: {
            count: summary.failed.count,
            grossWei: summary.failed.grossWei.toString(),
            feeWei: summary.failed.feeWei.toString(),
            netWei: summary.failed.netWei.toString(),
            byCode: failuresByCode,
          },
        },
        batches: {
          byStatus: batchesByStatus,
          oldestOpenCreatedAt: oldestOpenBatch?.createdAt?.toISOString() ?? null,
          oldestSubmittedAt:
            oldestSubmittedBatch?.submittedAt?.toISOString() ??
            oldestSubmittedBatch?.createdAt?.toISOString() ??
            null,
        },
        drift: {
          creditPriceWei: GHOST_CREDIT_PRICE_WEI.toString(),
          unsettledNetWei: unsettledNetWei.toString(),
          vault: {
            readable: vaultSnapshot.readable,
            creditPriceWei: vaultSnapshot.creditPriceWei?.toString() ?? null,
            totalLiabilityWei: vaultSnapshot.totalLiability?.toString() ?? null,
            accruedFeesWei: vaultSnapshot.accruedFees?.toString() ?? null,
            priceAligned:
              vaultSnapshot.readable && vaultSnapshot.creditPriceWei != null
                ? vaultSnapshot.creditPriceWei === GHOST_CREDIT_PRICE_WEI
                : null,
            error: vaultSnapshot.error,
          },
        },
      },
      200,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022")) {
      return settlementJson(
        {
          code: 503,
          error: "Settlement schema is not available in this environment yet.",
          errorCode: "SETTLEMENT_SCHEMA_UNAVAILABLE",
        },
        503,
      );
    }

    return settlementJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to load settlement metrics.",
        errorCode: "SETTLEMENT_METRICS_FAILED",
      },
      500,
    );
  }
}
