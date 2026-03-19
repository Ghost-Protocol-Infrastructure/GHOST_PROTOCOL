import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { parseJsonBodyWithLimit } from "@/lib/fulfillment-route";
import { prisma } from "@/lib/db";
import { normalizeMerchantGatewayAuthPayload } from "@/lib/agent-gateway-auth";
import { verifyMerchantGatewaySignedWrite } from "@/lib/agent-gateway-auth-server";
import { consumeX402SettlementRateLimit } from "@/lib/x402-rate-limit";
import {
  isRelatedPartyX402Traffic,
  isX402SettlementRankEligible,
  normalizeX402SettlementReport,
} from "@/lib/x402-reporting";

export const runtime = "nodejs";

const json = (body: unknown, status = 200, retryAfterSeconds?: number): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(typeof retryAfterSeconds === "number" ? { "retry-after": String(retryAfterSeconds) } : {}),
    },
  });

const isMissingX402SchemaError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (((error as { code?: string }).code === "P2021") || (error as { code?: string }).code === "P2022");

const isDuplicateReportError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsedJson = await parseJsonBodyWithLimit(request, {
    invalidJsonErrorCode: "INVALID_X402_SETTLEMENT_REPORT",
    payloadTooLargeErrorCode: "X402_SETTLEMENT_REPORT_TOO_LARGE",
  });
  if (!parsedJson.ok) {
    return json({ code: parsedJson.status, error: parsedJson.error, errorCode: parsedJson.errorCode }, parsedJson.status);
  }

  const report = normalizeX402SettlementReport(parsedJson.body);
  if (!report) {
    return json({ code: 400, error: "Invalid x402 settlement report body.", errorCode: "INVALID_X402_SETTLEMENT_REPORT" }, 400);
  }

  const normalizedAuthPayload = normalizeMerchantGatewayAuthPayload(report.auth.payload);
  if (!normalizedAuthPayload) {
    return json({ code: 400, error: "auth.payload is invalid.", errorCode: "BAD_AUTH_PAYLOAD" }, 400);
  }

  try {
    const config = await prisma.agentGatewayConfig.findUnique({
      where: { agentId: report.agentId },
      include: {
        agent: {
          select: {
            owner: true,
            creator: true,
          },
        },
        delegatedSigners: {
          where: { status: "ACTIVE" },
          select: { signerAddress: true },
        },
      },
    });

    if (!config) {
      return json({ code: 404, error: "Gateway config not found for agent.", errorCode: "GATEWAY_NOT_FOUND" }, 404);
    }

    const canonicalOwner = config.agent.owner.toLowerCase();
    if (config.ownerAddress.toLowerCase() !== canonicalOwner) {
      return json(
        {
          code: 409,
          error: "Gateway owner address does not match the indexed agent owner.",
          errorCode: "GATEWAY_OWNER_MISMATCH",
          expectedOwnerAddress: canonicalOwner,
        },
        409,
      );
    }

    if (report.serviceSlug !== config.serviceSlug) {
      return json(
        {
          code: 400,
          error: "serviceSlug does not match the configured gateway service slug.",
          errorCode: "SERVICE_MISMATCH",
          expectedServiceSlug: config.serviceSlug,
        },
        400,
      );
    }

    const authResult = await verifyMerchantGatewaySignedWrite({
      action: "x402_settlement_report",
      agentId: report.agentId,
      ownerAddress: canonicalOwner,
      actorAddress: normalizedAuthPayload.actorAddress,
      serviceSlug: report.serviceSlug,
      authPayload: report.auth.payload,
      authSignature: report.auth.signature,
      allowDelegatedSigner: true,
      gatewayConfigId: config.id,
    });
    if (!authResult.ok) {
      return json(
        {
          code: authResult.status,
          error: authResult.error,
          authCode: authResult.code ?? null,
        },
        authResult.status,
      );
    }

    const rateLimit = consumeX402SettlementRateLimit({
      request,
      signerAddress: authResult.signer,
      serviceSlug: report.serviceSlug,
      payerIdentity: report.payerIdentity,
    });
    if (!rateLimit.ok) {
      return json(
        { code: 429, error: rateLimit.error, errorCode: rateLimit.errorCode },
        429,
        rateLimit.retryAfterSeconds,
      );
    }

    const relatedParty = isRelatedPartyX402Traffic({
      payerIdentity: report.payerIdentity,
      payerAddress: report.payerAddress,
      ownerAddress: canonicalOwner,
      creatorAddress: config.agent.creator,
      delegatedSignerAddresses: config.delegatedSigners.map((row) => row.signerAddress),
    });
    const countedForRank = isX402SettlementRankEligible({
      scheme: report.scheme,
      asset: report.asset,
      success: report.success,
      relatedParty,
    });

    try {
      await prisma.x402SettlementEvent.create({
        data: {
          serviceSlug: report.serviceSlug,
          agentId: report.agentId,
          ownerAddress: canonicalOwner,
          reporterAddress: authResult.signer,
          requestId: report.requestId,
          paymentReference: report.paymentReference,
          payerIdentity: report.payerIdentity,
          payerAddress: report.payerAddress,
          scheme: report.scheme,
          network: report.network,
          chainId: report.chainId,
          asset: report.asset,
          amountAtomic: report.amountAtomic,
          decimals: report.decimals,
          success: report.success,
          statusCode: report.statusCode,
          latencyMs: report.latencyMs,
          relatedParty,
          countedForRank,
          occurredAt: report.occurredAt,
          metadata: (report.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
        },
      });

      return json(
        {
          ok: true,
          accepted: true,
          duplicate: false,
          countedForRank,
          relatedParty,
        },
        200,
      );
    } catch (error) {
      if (!isDuplicateReportError(error)) throw error;

      const existing = await prisma.x402SettlementEvent.findFirst({
        where: {
          serviceSlug: report.serviceSlug,
          OR: [
            { paymentReference: report.paymentReference },
            {
              requestId: report.requestId,
              reporterAddress: authResult.signer,
            },
          ],
        },
        select: {
          countedForRank: true,
          relatedParty: true,
        },
      });

      return json(
        {
          ok: true,
          accepted: true,
          duplicate: true,
          countedForRank: existing?.countedForRank ?? countedForRank,
          relatedParty: existing?.relatedParty ?? relatedParty,
        },
        200,
      );
    }
  } catch (error) {
    if (isMissingX402SchemaError(error)) {
      return json(
        {
          code: 503,
          error: "x402 settlement schema is not available in this environment yet.",
          errorCode: "X402_SCHEMA_UNAVAILABLE",
        },
        503,
      );
    }

    console.error("Failed to persist x402 settlement report.", error);
    return json({ code: 500, error: "Failed to persist x402 settlement report." }, 500);
  }
}
