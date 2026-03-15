import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FULFILLMENT_API_VERSION } from "@/lib/fulfillment-types";
import { fulfillmentJson, isFulfillmentSupportAuthorized, parsePositiveIntBounded } from "@/lib/fulfillment-route";

export const runtime = "nodejs";

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 24 * 60;

const isSchemaUnavailableError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022");

const parseOptionalServiceSlug = (value: string | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed;
};

const countByKey = <T extends string | number | null>(
  rows: Array<{ key: T; count: number }>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.key == null || row.key === "" ? "UNKNOWN" : String(row.key);
    out[key] = (out[key] ?? 0) + row.count;
  }
  return out;
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
};

export async function GET(request: NextRequest) {
  if (!isFulfillmentSupportAuthorized(request)) {
    return fulfillmentJson(
      { code: 401, error: "Unauthorized fulfillment support request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const windowMinutes = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("windowMinutes"),
    fallback: DEFAULT_WINDOW_MINUTES,
    max: MAX_WINDOW_MINUTES,
  });
  const serviceSlug = parseOptionalServiceSlug(request.nextUrl.searchParams.get("serviceSlug"));
  const now = new Date();
  const since = new Date(now.getTime() - windowMinutes * 60_000);

  const holdWhere: Prisma.FulfillmentHoldWhereInput = {
    ...(serviceSlug ? { serviceSlug } : {}),
  };
  const holdWindowWhere: Prisma.FulfillmentHoldWhereInput = {
    ...holdWhere,
    createdAt: { gte: since },
  };
  const attemptWhere: Prisma.FulfillmentCaptureAttemptWhereInput = {
    receivedAt: { gte: since },
    ...(serviceSlug ? { hold: { serviceSlug } } : {}),
  };
  const ledgerWhere: Prisma.CreditLedgerWhereInput = {
    createdAt: { gte: since },
    ...(serviceSlug ? { service: serviceSlug } : {}),
  };

  try {
    const [
      holdsByState,
      issuedInWindow,
      capturedInWindow,
      expiredInWindow,
      heldOverdueCount,
      attemptsTotal,
      attemptsSuccess,
      attemptsFailure,
      attemptsByDispositionRaw,
      attemptsByHttpStatusRaw,
      attemptsByErrorCodeRaw,
      captureLatencyRows,
      holdCreatedCount,
      holdExpiredCount,
      captureFinalizedCount,
    ] = await Promise.all([
      prisma.fulfillmentHold.groupBy({
        by: ["state"],
        where: holdWhere,
        _count: { _all: true },
      }),
      prisma.fulfillmentHold.count({
        where: holdWindowWhere,
      }),
      prisma.fulfillmentHold.count({
        where: {
          ...holdWhere,
          capturedAt: { gte: since },
        },
      }),
      prisma.fulfillmentHold.count({
        where: {
          ...holdWhere,
          state: "EXPIRED",
          releasedAt: { gte: since },
        },
      }),
      prisma.fulfillmentHold.count({
        where: {
          ...holdWhere,
          state: "HELD",
          expiresAt: { lte: now },
        },
      }),
      prisma.fulfillmentCaptureAttempt.count({ where: attemptWhere }),
      prisma.fulfillmentCaptureAttempt.count({
        where: { ...attemptWhere, success: true },
      }),
      prisma.fulfillmentCaptureAttempt.count({
        where: { ...attemptWhere, success: false },
      }),
      prisma.fulfillmentCaptureAttempt.groupBy({
        by: ["captureDisposition"],
        where: attemptWhere,
        _count: { _all: true },
      }),
      prisma.fulfillmentCaptureAttempt.groupBy({
        by: ["httpStatus"],
        where: attemptWhere,
        _count: { _all: true },
      }),
      prisma.fulfillmentCaptureAttempt.groupBy({
        by: ["errorCode"],
        where: { ...attemptWhere, success: false },
        _count: { _all: true },
      }),
      prisma.fulfillmentHold.findMany({
        where: {
          ...holdWhere,
          capturedAt: { gte: since },
          captureLatencyMs: { not: null },
        },
        select: { captureLatencyMs: true },
      }),
      prisma.creditLedger.count({
        where: { ...ledgerWhere, reason: "FULFILLMENT_HOLD_CREATED" },
      }),
      prisma.creditLedger.count({
        where: { ...ledgerWhere, reason: "FULFILLMENT_HOLD_EXPIRED" },
      }),
      prisma.creditLedger.count({
        where: { ...ledgerWhere, reason: "FULFILLMENT_CAPTURE_FINALIZED" },
      }),
    ]);

    const latencyValues = captureLatencyRows
      .map((row) => row.captureLatencyMs)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);

    const attemptsByDisposition = countByKey(
      attemptsByDispositionRaw.map((row) => ({ key: row.captureDisposition, count: row._count._all })),
    );
    const attemptsByHttpStatus = countByKey(
      attemptsByHttpStatusRaw.map((row) => ({ key: row.httpStatus, count: row._count._all })),
    );
    const attemptsByErrorCode = countByKey(
      attemptsByErrorCodeRaw.map((row) => ({ key: row.errorCode, count: row._count._all })),
    );
    const holdsByStateMap = countByKey(
      holdsByState.map((row) => ({ key: row.state, count: row._count._all })),
    );

    return fulfillmentJson(
      {
        ok: true,
        apiVersion: FULFILLMENT_API_VERSION,
        window: {
          minutes: windowMinutes,
          since: since.toISOString(),
          now: now.toISOString(),
        },
        filter: {
          serviceSlug,
        },
        holds: {
          byState: holdsByStateMap,
          issuedInWindow,
          capturedInWindow,
          expiredInWindow,
          heldOverdueCount,
        },
        captureAttempts: {
          total: attemptsTotal,
          success: attemptsSuccess,
          failure: attemptsFailure,
          byDisposition: attemptsByDisposition,
          byHttpStatus: attemptsByHttpStatus,
          byErrorCode: attemptsByErrorCode,
          latencyMs: {
            samples: latencyValues.length,
            p50: percentile(latencyValues, 50),
            p95: percentile(latencyValues, 95),
            max: latencyValues.length > 0 ? latencyValues[latencyValues.length - 1] : null,
          },
        },
        ledgerTransitions: {
          holdCreated: holdCreatedCount,
          holdExpired: holdExpiredCount,
          captureFinalized: captureFinalizedCount,
        },
      },
      200,
    );
  } catch (error) {
    if (isSchemaUnavailableError(error)) {
      return fulfillmentJson(
        {
          code: 503,
          error: "Fulfillment schema is not available in this environment yet.",
          errorCode: "PHASE_C_SCHEMA_UNAVAILABLE",
        },
        503,
      );
    }
    console.error("Fulfillment support metrics lookup failed.", error);
    return fulfillmentJson(
      {
        code: 500,
        error: "Fulfillment support metrics lookup failed.",
        errorCode: "FULFILLMENT_SUPPORT_METRICS_FAILED",
      },
      500,
    );
  }
}
