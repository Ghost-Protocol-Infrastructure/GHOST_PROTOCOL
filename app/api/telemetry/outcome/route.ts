import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  deriveApiKeyFields,
  isSchemaUnavailableError,
  normalizeOptionalStatusCode,
  normalizeOptionalString,
  TELEMETRY_NO_STORE_HEADERS,
} from "@/lib/telemetry";

export const runtime = "nodejs";

type OutcomeBody = {
  apiKey?: unknown;
  agentId?: unknown;
  serviceSlug?: unknown;
  success?: unknown;
  statusCode?: unknown;
  metadata?: unknown;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: OutcomeBody = {};
  try {
    body = (await request.json()) as OutcomeBody;
  } catch {
    body = {};
  }

  const { apiKeyHash, apiKeyPrefix } = deriveApiKeyFields(body.apiKey);
  const agentId = normalizeOptionalString(body.agentId, 64);
  const serviceSlug = normalizeOptionalString(body.serviceSlug, 128);
  const statusCode = normalizeOptionalStatusCode(body.statusCode);
  const success = Boolean(body.success);
  const userAgent = normalizeOptionalString(request.headers.get("user-agent"), 512);

  if (apiKeyHash || agentId || serviceSlug) {
    try {
      await prisma.telemetryOutcomeEvent.create({
        data: {
          apiKeyHash,
          apiKeyPrefix,
          agentId,
          serviceSlug,
          success,
          statusCode,
          metadata: {
            userAgent,
            source: "sdk_outcome",
          },
        },
      });
    } catch (error) {
      if (!isSchemaUnavailableError(error)) {
        console.error("Failed to persist telemetry outcome event.", error);
      }
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      timestamp: Date.now(),
    },
    {
      status: 200,
      headers: TELEMETRY_NO_STORE_HEADERS,
    },
  );
}
