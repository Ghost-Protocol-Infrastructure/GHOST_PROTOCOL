import { privateKeyToAccount } from "viem/accounts";
import { NextRequest, NextResponse } from "next/server";
import { GhostFulfillmentMerchant } from "@/sdks/node/fulfillment";

export const runtime = "nodejs";

const BOOSKI_SERVICE_SLUG = "agent-18755";
const BOOSKI_BOUND_PATH = "/ask";

type AskBody = {
  prompt?: unknown;
};

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseProtocolSignerAddresses = (): string[] => {
  const explicit = process.env.GHOST_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES?.trim();
  if (explicit) {
    const values = explicit
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }

  const protocolSignerPk = process.env.GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY?.trim();
  if (protocolSignerPk && /^0x[a-fA-F0-9]{64}$/.test(protocolSignerPk)) {
    return [privateKeyToAccount(protocolSignerPk as `0x${string}`).address.toLowerCase()];
  }

  return [];
};

const mapTicketError = (error: unknown): { status: number; code: string; error: string } => {
  const message = error instanceof Error ? error.message : "Invalid fulfillment ticket.";
  const lower = message.toLowerCase();

  if (lower.includes("missing or invalid fulfillment ticket headers")) {
    return { status: 401, code: "FULFILLMENT_TICKET_MISSING", error: message };
  }
  if (lower.includes("expired")) {
    return { status: 409, code: "FULFILLMENT_TICKET_EXPIRED", error: message };
  }
  if (lower.includes("signer") || lower.includes("signature")) {
    return { status: 401, code: "INVALID_FULFILLMENT_TICKET", error: message };
  }
  if (lower.includes("mismatch")) {
    return { status: 400, code: "FULFILLMENT_TICKET_BINDING_MISMATCH", error: message };
  }
  return { status: 400, code: "INVALID_FULFILLMENT_TICKET", error: message };
};

const buildMerchant = (request: NextRequest): GhostFulfillmentMerchant => {
  const delegatedPrivateKey =
    process.env.GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY?.trim() ||
    process.env.PHASE7_MERCHANT_DELEGATED_PRIVATE_KEY?.trim() ||
    null;
  const protocolSignerAddresses = parseProtocolSignerAddresses();
  if (!delegatedPrivateKey) {
    throw new Error("Missing delegated merchant signer private key.");
  }
  if (protocolSignerAddresses.length === 0) {
    throw new Error("Missing protocol signer address configuration.");
  }

  return new GhostFulfillmentMerchant({
    baseUrl: request.nextUrl.origin,
    delegatedPrivateKey: delegatedPrivateKey as `0x${string}`,
    protocolSignerAddresses,
  });
};

const parseAskBody = async (request: NextRequest): Promise<AskBody | null> => {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body == null || Array.isArray(body)) return null;
    return body as AskBody;
  } catch {
    return null;
  }
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  let merchant: GhostFulfillmentMerchant;
  try {
    merchant = buildMerchant(request);
  } catch (error) {
    return json(
      {
        code: 500,
        error: "Local fulfillment alpha merchant endpoint is not configured.",
        errorCode: "FULFILLMENT_ALPHA_NOT_CONFIGURED",
        details: error instanceof Error ? error.message : "Unknown merchant config error.",
      },
      500,
    );
  }

  const body = await parseAskBody(request);
  if (!body) {
    return json(
      { code: 400, error: "Invalid JSON body.", errorCode: "INVALID_ALPHA_ASK_BODY" },
      400,
    );
  }

  let verifiedTicket;
  try {
    verifiedTicket = await merchant.requireFulfillmentTicket({
      headers: request.headers,
      expected: {
        serviceSlug: BOOSKI_SERVICE_SLUG,
        method: "POST",
        path: BOOSKI_BOUND_PATH,
        query: request.nextUrl.search,
        body,
      },
    });
  } catch (error) {
    const mapped = mapTicketError(error);
    return json(
      {
        code: mapped.status,
        error: mapped.error,
        errorCode: mapped.code,
      },
      mapped.status,
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const startedAt = Date.now();
  const result = {
    ok: true,
    agent: "Booski",
    service: BOOSKI_SERVICE_SLUG,
    message: prompt ? `Booski echo: ${prompt}` : "Booski test endpoint is live.",
    ticketId: verifiedTicket.ticketId,
    timestamp: new Date().toISOString(),
  };
  const latencyMs = Math.max(0, Date.now() - startedAt);

  let captureResult;
  try {
    captureResult = await merchant.captureCompletion({
      ticketId: verifiedTicket.ticketId,
      serviceSlug: BOOSKI_SERVICE_SLUG,
      statusCode: 200,
      latencyMs,
      responseBodyJson: result,
    });
  } catch (error) {
    return json(
      {
        code: 500,
        error: "Failed to capture fulfillment completion.",
        errorCode: "FULFILLMENT_CAPTURE_HELPER_FAILED",
        details: error instanceof Error ? error.message : "Unknown capture helper failure.",
      },
      500,
    );
  }

  if (!captureResult.ok) {
    return json(
      {
        code: 502,
        error: "Fulfillment capture API rejected merchant completion.",
        errorCode: "FULFILLMENT_CAPTURE_REJECTED",
        captureStatus: captureResult.status,
        capturePayload: captureResult.payload,
      },
      502,
    );
  }

  return json(
    {
      ...result,
      fulfillment: {
        captureStatus: captureResult.status,
        capturePayload: captureResult.payload,
        debug: captureResult.debug,
      },
    },
    200,
  );
}
