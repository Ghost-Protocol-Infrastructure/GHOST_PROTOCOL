import { NextRequest } from "next/server";
import { parsePositiveIntBounded } from "@/lib/fulfillment-route";
import { resolveMerchantSettlementAllocatorConfig } from "@/lib/merchant-settlement-allocator";
import { reconcileMerchantSettlementRows } from "@/lib/merchant-settlement-reconcile";
import { settlementJson, isSettlementOperatorAuthorized } from "@/lib/merchant-settlement-route";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const parseBody = async (request: NextRequest): Promise<{
  batchId?: string | null;
  settlementId?: string | null;
  limit?: number;
} | null> => {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return null;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;

    return {
      batchId: typeof body.batchId === "string" ? body.batchId.trim() || null : null,
      settlementId: typeof body.settlementId === "string" ? body.settlementId.trim() || null : null,
      limit: typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, MAX_LIMIT) : undefined,
    };
  } catch {
    return null;
  }
};

export async function POST(request: NextRequest) {
  if (!isSettlementOperatorAuthorized(request)) {
    return settlementJson(
      { code: 401, error: "Unauthorized settlement operator request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const body = await parseBody(request);
  const batchId = body?.batchId ?? request.nextUrl.searchParams.get("batchId");
  const settlementId = body?.settlementId ?? request.nextUrl.searchParams.get("settlementId");
  const limit =
    body?.limit ??
    parsePositiveIntBounded({
      value: request.nextUrl.searchParams.get("limit"),
      fallback: DEFAULT_LIMIT,
      max: MAX_LIMIT,
    });

  try {
    const config = resolveMerchantSettlementAllocatorConfig();
    const result = await reconcileMerchantSettlementRows({
      config: { minConfirmations: config.minConfirmations },
      batchId,
      settlementId,
      limit,
    });

    return settlementJson(
      {
        authMode: "bearer-secret",
        batchId: batchId ?? null,
        settlementId: settlementId ?? null,
        ...result,
      },
      200,
    );
  } catch (error) {
    return settlementJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to reconcile merchant settlements.",
        errorCode: "SETTLEMENT_RECONCILE_FAILED",
      },
      500,
    );
  }
}
