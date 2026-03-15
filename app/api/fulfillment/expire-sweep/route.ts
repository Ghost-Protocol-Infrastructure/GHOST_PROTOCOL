import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { expireFulfillmentHolds, listExpiredFulfillmentHoldCandidates } from "@/lib/db";
import { FULFILLMENT_API_VERSION } from "@/lib/fulfillment-types";
import {
  FULFILLMENT_EXPIRE_SWEEP_DEFAULT_LIMIT,
  FULFILLMENT_EXPIRE_SWEEP_MAX_LIMIT,
  fulfillmentJson,
  isFulfillmentExpireSweepAuthorized,
  parseBooleanFlag,
  parsePositiveIntBounded,
} from "@/lib/fulfillment-route";
import { consumeFulfillmentRateLimit } from "@/lib/fulfillment-rate-limit";
import { extractFulfillmentErrorCode, observeFulfillmentResponseEvent } from "@/lib/fulfillment-observability";

export const runtime = "nodejs";

const parseBodyOverrides = async (
  request: NextRequest,
): Promise<{ dryRun?: boolean; limit?: number } | null> => {
  if (request.method !== "POST") return null;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const out: { dryRun?: boolean; limit?: number } = {};
    if (typeof record.dryRun === "boolean") out.dryRun = record.dryRun;
    if (typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0) {
      out.limit = Math.min(record.limit, FULFILLMENT_EXPIRE_SWEEP_MAX_LIMIT);
    }
    return out;
  } catch {
    return null;
  }
};

const isSchemaUnavailableError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022");

const expireSweepResponse = (
  body: unknown,
  status = 200,
  options?: { retryAfterSeconds?: number; meta?: Record<string, unknown> },
): NextResponse => {
  observeFulfillmentResponseEvent({
    route: "expire_sweep",
    status,
    errorCode: extractFulfillmentErrorCode(body),
    meta: options?.meta,
  });
  if (typeof options?.retryAfterSeconds === "number") {
    return NextResponse.json(body, {
      status,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(options.retryAfterSeconds),
      },
    });
  }
  return fulfillmentJson(body, status);
};

async function handle(request: NextRequest): Promise<NextResponse> {
  const rateLimit = consumeFulfillmentRateLimit({ request, action: "expire_sweep", scopeKey: "internal" });
  if (!rateLimit.ok) {
    return expireSweepResponse(
      {
        code: 429,
        error: rateLimit.error,
        errorCode: rateLimit.errorCode,
      },
      429,
      {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        meta: { rateLimited: true },
      },
    );
  }

  if (!isFulfillmentExpireSweepAuthorized(request)) {
    return expireSweepResponse({ code: 401, error: "Unauthorized expire sweep request.", errorCode: "UNAUTHORIZED" }, 401);
  }

  const bodyOverrides = await parseBodyOverrides(request);

  let dryRun = parseBooleanFlag(request.nextUrl.searchParams.get("dryRun"));
  let limit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("limit"),
    fallback: FULFILLMENT_EXPIRE_SWEEP_DEFAULT_LIMIT,
    max: FULFILLMENT_EXPIRE_SWEEP_MAX_LIMIT,
  });
  if (typeof bodyOverrides?.dryRun === "boolean") dryRun = bodyOverrides.dryRun;
  if (typeof bodyOverrides?.limit === "number") limit = bodyOverrides.limit;

  const now = new Date();

  try {
    if (dryRun) {
      const candidates = await listExpiredFulfillmentHoldCandidates({ now, limit });
      return expireSweepResponse(
        {
          ok: true,
          apiVersion: FULFILLMENT_API_VERSION,
          dryRun: true,
          selected: candidates.length,
          processed: 0,
          released: 0,
          skippedTerminal: 0,
          skippedNotDue: 0,
          errors: 0,
          candidates: candidates.map((candidate) => ({
            holdId: candidate.id,
            ticketId: candidate.ticketId,
            walletAddress: candidate.walletAddress,
            serviceSlug: candidate.serviceSlug,
            cost: candidate.cost.toString(),
            state: candidate.state,
            expiresAt: candidate.expiresAt.toISOString(),
          })),
          authMode: "bearer-secret",
          limit,
          now: now.toISOString(),
        },
        200,
      );
    }

    const result = await expireFulfillmentHolds({ now, limit });
    return expireSweepResponse(
      {
        ok: true,
        apiVersion: FULFILLMENT_API_VERSION,
        dryRun: false,
        selected: result.selected,
        processed: result.processed,
        released: result.released,
        skippedTerminal: result.skippedTerminal,
        skippedNotDue: result.skippedNotDue,
        errors: result.errors,
        authMode: "bearer-secret",
        limit,
        now: now.toISOString(),
        results: result.results.map((entry) =>
          entry.status === "expired"
            ? {
                holdId: entry.holdId,
                ticketId: entry.ticketId,
                status: entry.status,
                walletAddress: entry.walletAddress,
                serviceSlug: entry.serviceSlug,
                cost: entry.cost.toString(),
                creditsBefore: entry.creditsBefore.toString(),
                creditsAfter: entry.creditsAfter.toString(),
                heldCreditsBefore: entry.heldCreditsBefore.toString(),
                heldCreditsAfter: entry.heldCreditsAfter.toString(),
              }
            : {
                holdId: entry.holdId,
                ticketId: entry.ticketId,
                status: entry.status,
                state: entry.state,
                expiresAt: entry.expiresAt.toISOString(),
              },
        ),
      },
      200,
    );
  } catch (error) {
    if (isSchemaUnavailableError(error)) {
      return expireSweepResponse(
        {
          code: 503,
          error: "Fulfillment schema is not available in this environment yet.",
          errorCode: "PHASE_C_SCHEMA_UNAVAILABLE",
        },
        503,
      );
    }
    console.error("Fulfillment expire sweep failed.", error);
    return expireSweepResponse(
      {
        code: 500,
        error: "Fulfillment expire sweep failed.",
        errorCode: "FULFILLMENT_EXPIRE_SWEEP_FAILED",
      },
      500,
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
