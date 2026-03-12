import { NextRequest } from "next/server";
import { type WireContractState } from "@prisma/client";
import { parsePositiveIntBounded } from "@/lib/fulfillment-route";
import { prisma } from "@/lib/db";
import {
  isGhostWireExecAuthorized,
  isGhostWireExecSecretConfigured,
} from "@/lib/ghostwire-exec-auth";
import { evaluateGhostWireExecutionPolicy } from "@/lib/ghostwire-exec-policy";
import {
  createWireJobFromQuote,
  listWireJobs,
  WireQuoteConsumedError,
  WireQuoteExpiredError,
  WireQuoteMismatchError,
  WireQuoteNotFoundError,
} from "@/lib/ghostwire-store";
import {
  ghostWireJson,
  isRecord,
  parseAddressString,
  parseHttpUrlString,
  parseGhostWireJsonBody,
  parseHex32String,
  parseOptionalString,
  parseRequiredString,
} from "@/lib/ghostwire-route";

export const runtime = "nodejs";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const WIRE_STATES = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const satisfies readonly WireContractState[];

export async function GET(request: NextRequest) {
  const limit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("limit"),
    fallback: DEFAULT_LIST_LIMIT,
    max: MAX_LIST_LIMIT,
  });
  const cursor = parseRequiredString(request.nextUrl.searchParams.get("cursor"));
  const participant = parseAddressString(request.nextUrl.searchParams.get("participant"));
  const stateRaw = parseRequiredString(request.nextUrl.searchParams.get("state"));
  const state = stateRaw && WIRE_STATES.includes(stateRaw as WireContractState) ? (stateRaw as WireContractState) : null;

  if (stateRaw && !state) {
    return ghostWireJson(
      { code: 400, error: "Unsupported wire job state filter.", errorCode: "INVALID_WIRE_JOB_STATE" },
      400,
    );
  }

  try {
    const jobs = await listWireJobs({
      limit,
      cursor,
      participantAddress: participant,
      state,
    });

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      items: jobs.items,
      nextCursor: jobs.nextCursor,
    });
  } catch (error) {
    console.error("Failed to list GhostWire jobs.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to list GhostWire jobs.", errorCode: "WIRE_JOB_LIST_FAILED" },
      500,
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isGhostWireExecSecretConfigured()) {
    return ghostWireJson(
      {
        code: 503,
        error: "GhostWire execution secret is not configured.",
        errorCode: "GHOSTWIRE_EXEC_NOT_CONFIGURED",
      },
      503,
    );
  }

  if (!isGhostWireExecAuthorized(request)) {
    return ghostWireJson(
      {
        code: 401,
        error: "Unauthorized GhostWire execution request.",
        errorCode: "UNAUTHORIZED_GHOSTWIRE_EXEC",
      },
      401,
    );
  }

  const parsed = await parseGhostWireJsonBody(request);
  if (!parsed.ok) {
    return ghostWireJson(
      { code: parsed.status, error: parsed.error, errorCode: parsed.errorCode },
      parsed.status,
    );
  }

  if (!isRecord(parsed.body)) {
    return ghostWireJson(
      { code: 400, error: "Invalid wire job create request shape.", errorCode: "INVALID_WIRE_JOB_REQUEST" },
      400,
    );
  }

  const quoteId = parseRequiredString(parsed.body.quoteId);
  const client = parseAddressString(parsed.body.client);
  const provider = parseAddressString(parsed.body.provider);
  const evaluator = parseAddressString(parsed.body.evaluator);
  const specHash = parseHex32String(parsed.body.specHash);
  const metadataUri = parseOptionalString(parsed.body.metadataUri);
  const webhookTargetUrl = parseHttpUrlString(parsed.body.webhookUrl);
  const webhookSecret = parseOptionalString(parsed.body.webhookSecret);

  if (!quoteId || !client || !provider || !evaluator || !specHash) {
    return ghostWireJson(
      {
        code: 400,
        error: "quoteId, client, provider, evaluator, and specHash are required.",
        errorCode: "INVALID_WIRE_JOB_PARAMS",
      },
      400,
    );
  }

  const hasWebhookUrlInput = parsed.body.webhookUrl != null;
  const hasWebhookSecretInput = parsed.body.webhookSecret != null;
  if (hasWebhookUrlInput !== hasWebhookSecretInput || (hasWebhookUrlInput && (!webhookTargetUrl || !webhookSecret))) {
    return ghostWireJson(
      {
        code: 400,
        error: "webhookUrl and webhookSecret must both be provided together when configuring GhostWire webhooks.",
        errorCode: "INVALID_WIRE_WEBHOOK_CONFIG",
      },
      400,
    );
  }

  try {
    const quote = await prisma.wireQuote.findUnique({
      where: { quoteId },
      select: {
        quoteId: true,
        principalAmount: true,
      },
    });
    if (!quote) {
      return ghostWireJson({ code: 404, error: "Wire quote not found.", errorCode: "WIRE_QUOTE_NOT_FOUND" }, 404);
    }

    const policyCheck = await evaluateGhostWireExecutionPolicy({
      clientAddress: client,
      providerAddress: provider,
      evaluatorAddress: evaluator,
      principalAmountAtomic: quote.principalAmount,
    });
    if (!policyCheck.ok) {
      return ghostWireJson(
        {
          code: policyCheck.failure.status,
          error: policyCheck.failure.error,
          errorCode: policyCheck.failure.errorCode,
          details: policyCheck.failure.details,
        },
        policyCheck.failure.status,
      );
    }
  } catch (error) {
    console.error("Failed to evaluate GhostWire execution policy.", error);
    return ghostWireJson(
      {
        code: 500,
        error: "Failed to evaluate GhostWire execution policy.",
        errorCode: "GHOSTWIRE_EXEC_POLICY_EVALUATION_FAILED",
      },
      500,
    );
  }

  try {
    const job = await createWireJobFromQuote({
      quoteId,
      clientAddress: client,
      providerAddress: provider,
      evaluatorAddress: evaluator,
      specHash,
      metadataUri,
      webhookTargetUrl,
      webhookSecret,
    });

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      jobId: job.jobId,
      quoteId: job.quoteId,
      chainId: job.chainId,
      state: job.state,
      contractState: job.contractState,
      pricing: job.pricing,
      operator: job.operator,
    });
  } catch (error) {
    if (error instanceof WireQuoteNotFoundError) {
      return ghostWireJson({ code: 404, error: error.message, errorCode: "WIRE_QUOTE_NOT_FOUND" }, 404);
    }
    if (error instanceof WireQuoteExpiredError) {
      return ghostWireJson({ code: 409, error: error.message, errorCode: "WIRE_QUOTE_EXPIRED" }, 409);
    }
    if (error instanceof WireQuoteConsumedError) {
      return ghostWireJson({ code: 409, error: error.message, errorCode: "WIRE_QUOTE_CONSUMED" }, 409);
    }
    if (error instanceof WireQuoteMismatchError) {
      return ghostWireJson({ code: 409, error: error.message, errorCode: "WIRE_QUOTE_MISMATCH" }, 409);
    }

    console.error("Failed to create GhostWire job.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to create GhostWire job.", errorCode: "WIRE_JOB_CREATE_FAILED" },
      500,
    );
  }
}
