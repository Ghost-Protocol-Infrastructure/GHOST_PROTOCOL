import { NextRequest } from "next/server";
import { parseBooleanFlag, parsePositiveIntBounded } from "@/lib/fulfillment-route";
import {
  claimNextMerchantSettlementBatch,
  previewNextMerchantSettlementBatch,
  resolveMerchantSettlementAllocatorConfig,
  submitMerchantSettlementBatch,
} from "@/lib/merchant-settlement-allocator";
import { settlementJson, isSettlementOperatorAuthorized } from "@/lib/merchant-settlement-route";

export const runtime = "nodejs";

const MAX_BATCH_OVERRIDE = 200;

const parseBody = async (request: NextRequest): Promise<{ dryRun?: boolean; maxBatchSize?: number } | null> => {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return null;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;

    const parsed: { dryRun?: boolean; maxBatchSize?: number } = {};
    if (typeof body.dryRun === "boolean") parsed.dryRun = body.dryRun;
    if (typeof body.maxBatchSize === "number" && Number.isInteger(body.maxBatchSize) && body.maxBatchSize > 0) {
      parsed.maxBatchSize = Math.min(body.maxBatchSize, MAX_BATCH_OVERRIDE);
    }
    return parsed;
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
  const dryRun = body?.dryRun ?? parseBooleanFlag(request.nextUrl.searchParams.get("dryRun"));
  const maxBatchSizeOverride =
    body?.maxBatchSize ??
    parsePositiveIntBounded({
      value: request.nextUrl.searchParams.get("maxBatchSize"),
      fallback: 0,
      max: MAX_BATCH_OVERRIDE,
    });

  const config = resolveMerchantSettlementAllocatorConfig();
  if (maxBatchSizeOverride > 0) {
    config.maxBatchSize = maxBatchSizeOverride;
  }

  if (dryRun) {
    const preview = await previewNextMerchantSettlementBatch(config);
    return settlementJson(
      {
        ok: true,
        dryRun: true,
        authMode: "bearer-secret",
        selectionLimit: preview.selectionLimit,
        selectedCount: preview.selectedCount,
        config: {
          maxBatchSize: config.maxBatchSize,
          gasBudgetPerRun: config.gasBudgetPerRun.toString(),
          gasEstimatePerSettlement: config.gasEstimatePerSettlement.toString(),
          cooldownMs: config.cooldownMs,
          maxGasPriceWei: config.maxGasPriceWei.toString(),
          minConfirmations: config.minConfirmations,
        },
      },
      200,
    );
  }

  const claimed = await claimNextMerchantSettlementBatch(config);
  if (claimed.status === "noop") {
    return settlementJson(
      {
        ok: true,
        status: claimed.status,
        reason: claimed.reason,
        selectedCount: 0,
      },
      200,
    );
  }

  if (claimed.status === "cooldown") {
    return settlementJson(
      {
        ok: true,
        status: claimed.status,
        reason: claimed.reason,
        batchId: claimed.batchId,
        selectedCount: 0,
      },
      200,
    );
  }

  try {
    const submitted = await submitMerchantSettlementBatch({
      batchId: claimed.batch.id,
      earnings: claimed.earnings,
      config: claimed.config,
    });

    return settlementJson(
      {
        ok: true,
        status: submitted.status,
        batchId: claimed.batch.id,
        txHash: submitted.status === "submitted" ? submitted.txHash : null,
        gasPriceWei: submitted.status === "submitted" ? submitted.gasPriceWei.toString() : null,
        reason: "reason" in submitted ? submitted.reason : null,
        selectedCount: claimed.earnings.length,
        submittedCount: submitted.status === "submitted" ? claimed.earnings.length : 0,
        authMode: "bearer-secret",
      },
      200,
    );
  } catch (error) {
    return settlementJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to submit settlement batch.",
        errorCode: "SETTLEMENT_ALLOCATE_FAILED",
      },
      500,
    );
  }
}
