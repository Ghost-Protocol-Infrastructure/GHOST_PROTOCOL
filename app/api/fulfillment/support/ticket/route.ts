import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FULFILLMENT_API_VERSION } from "@/lib/fulfillment-types";
import {
  fulfillmentJson,
  isFulfillmentSupportAuthorized,
  normalizeHex32Lower,
  parsePositiveIntBounded,
} from "@/lib/fulfillment-route";

export const runtime = "nodejs";

const DEFAULT_ATTEMPTS_LIMIT = 50;
const MAX_ATTEMPTS_LIMIT = 200;
const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

const isSchemaUnavailableError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022");

const toIso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const countBy = (values: Array<string | null | undefined>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value?.trim() || "UNKNOWN";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isFulfillmentSupportAuthorized(request)) {
    return fulfillmentJson(
      { code: 401, error: "Unauthorized fulfillment support request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const ticketId = normalizeHex32Lower(request.nextUrl.searchParams.get("ticketId"));
  if (!ticketId) {
    return fulfillmentJson(
      { code: 400, error: "ticketId is required as bytes32 hex.", errorCode: "INVALID_TICKET_ID" },
      400,
    );
  }

  const attemptsLimit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("attemptsLimit"),
    fallback: DEFAULT_ATTEMPTS_LIMIT,
    max: MAX_ATTEMPTS_LIMIT,
  });
  const ledgerLimit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("ledgerLimit"),
    fallback: DEFAULT_LEDGER_LIMIT,
    max: MAX_LEDGER_LIMIT,
  });

  try {
    const hold = await prisma.fulfillmentHold.findUnique({
      where: { ticketId },
      select: {
        id: true,
        ticketId: true,
        walletAddress: true,
        serviceSlug: true,
        agentId: true,
        gatewayConfigId: true,
        merchantOwnerAddress: true,
        requestMethod: true,
        requestPath: true,
        queryHash: true,
        bodyHash: true,
        cost: true,
        state: true,
        issuedAt: true,
        expiresAt: true,
        capturedAt: true,
        releasedAt: true,
        releaseReason: true,
        captureDeliveryProofId: true,
        captureStatusCode: true,
        captureLatencyMs: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!hold) {
      return fulfillmentJson(
        {
          code: 404,
          error: "Fulfillment hold not found for ticketId.",
          errorCode: "FULFILLMENT_HOLD_NOT_FOUND",
          ticketId,
        },
        404,
      );
    }

    const [attemptsTotal, attempts, ledgerTotal, ledgerEntries, balance] = await Promise.all([
      prisma.fulfillmentCaptureAttempt.count({ where: { ticketId } }),
      prisma.fulfillmentCaptureAttempt.findMany({
        where: { ticketId },
        orderBy: { receivedAt: "asc" },
        take: attemptsLimit,
        select: {
          id: true,
          holdId: true,
          ticketId: true,
          deliveryProofId: true,
          merchantSigner: true,
          receivedAt: true,
          success: true,
          httpStatus: true,
          captureDisposition: true,
          errorCode: true,
          errorMessage: true,
          rawMeta: true,
        },
      }),
      prisma.creditLedger.count({
        where: { metadata: { path: ["ticketId"], equals: ticketId } },
      }),
      prisma.creditLedger.findMany({
        where: { metadata: { path: ["ticketId"], equals: ticketId } },
        orderBy: { createdAt: "asc" },
        take: ledgerLimit,
        select: {
          id: true,
          walletAddress: true,
          direction: true,
          amount: true,
          availableCreditsDelta: true,
          heldCreditsDelta: true,
          balanceBefore: true,
          balanceAfter: true,
          reason: true,
          service: true,
          requestId: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.creditBalance.findUnique({
        where: { walletAddress: hold.walletAddress },
        select: {
          walletAddress: true,
          credits: true,
          heldCredits: true,
          updatedAt: true,
        },
      }),
    ]);

    return fulfillmentJson(
      {
        ok: true,
        apiVersion: FULFILLMENT_API_VERSION,
        ticketId,
        hold: {
          ...hold,
          issuedAt: hold.issuedAt.toISOString(),
          expiresAt: hold.expiresAt.toISOString(),
          capturedAt: toIso(hold.capturedAt),
          releasedAt: toIso(hold.releasedAt),
          createdAt: hold.createdAt.toISOString(),
          updatedAt: hold.updatedAt.toISOString(),
        },
        balance: balance
          ? {
              walletAddress: balance.walletAddress,
              credits: balance.credits.toString(),
              heldCredits: balance.heldCredits.toString(),
              updatedAt: balance.updatedAt.toISOString(),
            }
          : null,
        attempts: {
          total: attemptsTotal,
          returned: attempts.length,
          truncated: attemptsTotal > attempts.length,
          rows: attempts.map((row) => ({
            ...row,
            receivedAt: row.receivedAt.toISOString(),
          })),
          dispositions: countBy(attempts.map((row) => row.captureDisposition)),
          errorCodes: countBy(attempts.map((row) => row.errorCode)),
        },
        ledger: {
          total: ledgerTotal,
          returned: ledgerEntries.length,
          truncated: ledgerTotal > ledgerEntries.length,
          rows: ledgerEntries.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
          reasons: countBy(ledgerEntries.map((row) => row.reason)),
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
    console.error("Fulfillment support ticket lookup failed.", error);
    return fulfillmentJson(
      {
        code: 500,
        error: "Fulfillment support ticket lookup failed.",
        errorCode: "FULFILLMENT_SUPPORT_LOOKUP_FAILED",
      },
      500,
    );
  }
}
