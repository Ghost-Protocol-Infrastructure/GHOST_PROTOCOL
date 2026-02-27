import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  deriveApiKeyFields,
  isSchemaUnavailableError,
  normalizeOptionalString,
  TELEMETRY_NO_STORE_HEADERS,
} from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      status: "alive",
      timestamp: Date.now(),
    },
    {
      headers: TELEMETRY_NO_STORE_HEADERS,
    },
  );
}

type PulseBody = {
  apiKey?: unknown;
  agentId?: unknown;
  serviceSlug?: unknown;
  metadata?: unknown;
};

export async function POST(request: NextRequest) {
  let body: PulseBody = {};
  try {
    body = (await request.json()) as PulseBody;
  } catch {
    body = {};
  }

  const { apiKeyHash, apiKeyPrefix } = deriveApiKeyFields(body.apiKey);
  const agentId = normalizeOptionalString(body.agentId, 64);
  const serviceSlug = normalizeOptionalString(body.serviceSlug, 128);
  const userAgent = normalizeOptionalString(request.headers.get("user-agent"), 512);

  if (apiKeyHash || agentId || serviceSlug) {
    try {
      await prisma.telemetryPulseEvent.create({
        data: {
          apiKeyHash,
          apiKeyPrefix,
          agentId,
          serviceSlug,
          metadata: {
            userAgent,
            source: "sdk_pulse",
          },
        },
      });
    } catch (error) {
      if (!isSchemaUnavailableError(error)) {
        console.error("Failed to persist telemetry pulse event.", error);
      }
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      timestamp: Date.now(),
    },
    {
      headers: TELEMETRY_NO_STORE_HEADERS,
    },
  );
}
