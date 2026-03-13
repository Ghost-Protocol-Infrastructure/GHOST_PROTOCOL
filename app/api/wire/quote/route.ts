import { NextRequest } from "next/server";
import { GhostWireProviderAttributionError, resolveGhostWireProviderAttribution } from "@/lib/ghostwire-attribution";
import {
  createWireQuote,
} from "@/lib/ghostwire-store";
import {
  GHOSTWIRE_QUOTE_TTL_SECONDS,
  GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
  isGhostWireSupportedChainId,
} from "@/lib/ghostwire-config";
import {
  ghostWireJson,
  isRecord,
  parseAddressString,
  parseAtomicAmountString,
  parseGhostWireJsonBody,
  parseOptionalString,
} from "@/lib/ghostwire-route";

export const runtime = "nodejs";

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
      { code: 400, error: "Invalid wire quote request shape.", errorCode: "INVALID_WIRE_QUOTE_REQUEST" },
      400,
    );
  }

  const provider = parseAddressString(parsed.body.provider);
  const evaluator = parseAddressString(parsed.body.evaluator);
  const client = parseAddressString(parsed.body.client);
  const principalAmount = parseAtomicAmountString(parsed.body.principalAmount);
  const settlementAsset = typeof parsed.body.settlementAsset === "string" ? parsed.body.settlementAsset.trim() : null;
  const providerAgentId = parseOptionalString(parsed.body.providerAgentId);
  const providerServiceSlug = parseOptionalString(parsed.body.providerServiceSlug);
  const chainIdRaw = parsed.body.chainId;
  const chainId =
    typeof chainIdRaw === "number" && Number.isInteger(chainIdRaw)
      ? chainIdRaw
      : typeof chainIdRaw === "string" && /^\d+$/.test(chainIdRaw.trim())
        ? Number.parseInt(chainIdRaw.trim(), 10)
        : null;

  if (!provider || !evaluator || principalAmount == null || !chainId || !isGhostWireSupportedChainId(chainId)) {
    return ghostWireJson(
      {
        code: 400,
        error: "provider, evaluator, principalAmount, and supported chainId are required.",
        errorCode: "INVALID_WIRE_QUOTE_PARAMS",
      },
      400,
    );
  }

  if (settlementAsset !== GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET) {
    return ghostWireJson(
      {
        code: 400,
        error: `Unsupported settlement asset. Expected ${GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET}.`,
        errorCode: "UNSUPPORTED_WIRE_SETTLEMENT_ASSET",
      },
      400,
    );
  }

  try {
    const attribution = await resolveGhostWireProviderAttribution({
      providerAddress: provider,
      providerAgentId,
      providerServiceSlug,
    });

    const quote = await createWireQuote({
      clientAddress: client,
      providerAddress: provider,
      providerAgentId: attribution.providerAgentId,
      providerServiceSlug: attribution.providerServiceSlug,
      evaluatorAddress: evaluator,
      chainId,
      principalAmount,
      ttlSeconds: GHOSTWIRE_QUOTE_TTL_SECONDS,
    });

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      pricing: quote.pricing,
      confirmations: quote.confirmations,
    });
  } catch (error) {
    if (error instanceof GhostWireProviderAttributionError) {
      return ghostWireJson(
        { code: 409, error: error.message, errorCode: "WIRE_PROVIDER_ATTRIBUTION_MISMATCH" },
        409,
      );
    }
    console.error("Failed to create GhostWire quote.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to create GhostWire quote.", errorCode: "WIRE_QUOTE_CREATE_FAILED" },
      500,
    );
  }
}
