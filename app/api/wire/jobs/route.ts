import { NextRequest } from "next/server";
import { type WireContractState } from "@prisma/client";
import { parsePositiveIntBounded } from "@/lib/fulfillment-route";
import { prisma } from "@/lib/db";
import { GhostWireProviderAttributionError, resolveGhostWireProviderAttribution } from "@/lib/ghostwire-attribution";
import { buildGhostWireDeliverableSummary } from "@/lib/ghostwire-deliverable";
import { evaluateGhostWireExecutionPolicy } from "@/lib/ghostwire-exec-policy";
import {
  prepareWireJobFromQuote,
  WireJobInsufficientBalanceError,
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
  parseWireApprovalMode,
  parseHex32String,
  parseOptionalString,
  parseRequiredString,
} from "@/lib/ghostwire-route";
import {
  hashGhostWireRequestPayload,
  normalizeGhostWireRequestPayload,
} from "@/lib/ghostwire-request";

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
    const items = await Promise.all(
      jobs.items.map(async (job) => ({
        ...job,
        deliverable: await buildGhostWireDeliverableSummary({
          jobId: job.jobId,
          metadataUri: job.metadataUri,
          contractState: job.contractState,
          providerAgentId: job.providerAgentId,
          providerServiceSlug: job.providerServiceSlug,
          providerAddress: job.providerAddress,
          contractAddress: job.contractAddress,
          contractJobId: job.contractJobId,
        }),
      })),
    );

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      items,
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
  const hasRequestInput = Object.prototype.hasOwnProperty.call(parsed.body, "request");
  const requestPayload = hasRequestInput ? normalizeGhostWireRequestPayload(parsed.body.request) : null;
  const metadataUri = parseOptionalString(parsed.body.metadataUri);
  const providerAgentId = parseOptionalString(parsed.body.providerAgentId);
  const providerServiceSlug = parseOptionalString(parsed.body.providerServiceSlug);
  const webhookTargetUrl = parseHttpUrlString(parsed.body.webhookUrl);
  const webhookSecret = parseOptionalString(parsed.body.webhookSecret);
  const approvalMode = parseWireApprovalMode(parsed.body.approvalMode) ?? "exact";

  if (hasRequestInput && !requestPayload) {
    return ghostWireJson(
      {
        code: 400,
        error: "request must be an object with a non-empty prompt and optional walletAddress/metadata fields.",
        errorCode: "INVALID_WIRE_REQUEST_PAYLOAD",
      },
      400,
    );
  }

  const derivedSpecHash = requestPayload ? hashGhostWireRequestPayload(requestPayload) : null;
  if (specHash && derivedSpecHash && specHash.toLowerCase() !== derivedSpecHash.toLowerCase()) {
    return ghostWireJson(
      {
        code: 409,
        error: "request does not match the supplied specHash.",
        errorCode: "WIRE_REQUEST_SPEC_HASH_MISMATCH",
      },
      409,
    );
  }
  const resolvedSpecHash = specHash ?? derivedSpecHash;

  if (!quoteId || !client || !provider || !evaluator || !resolvedSpecHash) {
    return ghostWireJson(
      {
        code: 400,
        error: "quoteId, client, provider, evaluator, and either specHash or request are required.",
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

  let attribution: Awaited<ReturnType<typeof resolveGhostWireProviderAttribution>>;

  try {
    attribution = await resolveGhostWireProviderAttribution({
      providerAddress: provider,
      providerAgentId,
      providerServiceSlug,
    });

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
    if (error instanceof GhostWireProviderAttributionError) {
      return ghostWireJson(
        { code: 409, error: error.message, errorCode: "WIRE_PROVIDER_ATTRIBUTION_MISMATCH" },
        409,
      );
    }
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
    const job = await prepareWireJobFromQuote({
      quoteId,
      clientAddress: client,
      providerAddress: provider,
      providerAgentId: attribution.providerAgentId,
      providerServiceSlug: attribution.providerServiceSlug,
      evaluatorAddress: evaluator,
      specHash: resolvedSpecHash,
      requestPayload,
      metadataUri,
      webhookTargetUrl,
      webhookSecret,
      approvalMode,
    });

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      jobId: job.jobId,
      quoteId: job.quoteId,
      chainId: job.chainId,
      jobExpiresAt: job.jobExpiresAt,
      state: job.state,
      contractState: job.contractState,
      pricing: job.pricing,
      operator: job.operator,
      direct: job.direct,
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
    if (error instanceof WireJobInsufficientBalanceError) {
      return ghostWireJson(
        { code: 409, error: error.message, errorCode: "WIRE_CLIENT_INSUFFICIENT_BALANCE" },
        409,
      );
    }
    if (error instanceof GhostWireProviderAttributionError) {
      return ghostWireJson(
        { code: 409, error: error.message, errorCode: "WIRE_PROVIDER_ATTRIBUTION_MISMATCH" },
        409,
      );
    }

    console.error("Failed to create GhostWire job.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to create GhostWire job.", errorCode: "WIRE_JOB_CREATE_FAILED" },
      500,
    );
  }
}
