import { NextRequest, NextResponse } from "next/server";
import { type AgentGatewayCanaryMethod, type AgentGatewayReadinessStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  deriveAgentServiceSlug,
  normalizeAgentId,
  normalizeCanaryMethod,
  normalizeCanaryPath,
  normalizeMerchantEndpointUrl,
  normalizeOwnerAddress,
  normalizeServiceSlug,
} from "@/lib/agent-gateway";
import { verifyMerchantGatewaySignedWrite } from "@/lib/agent-gateway-auth-server";
import { consumeAgentGatewayRateLimit } from "@/lib/agent-gateway-rate-limit";

export const runtime = "nodejs";
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 50;

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

type GatewayConfigResponse = {
  agentId: string;
  ownerAddress: string;
  serviceSlug: string;
  endpointUrl: string | null;
  canaryPath: string | null;
  canaryMethod: AgentGatewayCanaryMethod | null;
  readinessStatus: AgentGatewayReadinessStatus;
  lastCanaryCheckedAt: string | null;
  lastCanaryPassedAt: string | null;
  lastCanaryStatusCode: number | null;
  lastCanaryLatencyMs: number | null;
  lastCanaryError: string | null;
  canaryHistory?: GatewayCanaryHistoryEntryResponse[];
};

type GatewayCanaryHistoryEntryResponse = {
  id: string;
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
};

type GatewayCanaryHistoryRow = {
  id: string;
  checkedAt: Date;
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
};

const toGatewayConfigResponse = (config: {
  agentId: string;
  ownerAddress: string;
  serviceSlug: string;
  endpointUrl: string;
  canaryPath: string;
  canaryMethod: AgentGatewayCanaryMethod;
  readinessStatus: AgentGatewayReadinessStatus;
  lastCanaryCheckedAt: Date | null;
  lastCanaryPassedAt: Date | null;
  lastCanaryStatusCode: number | null;
  lastCanaryLatencyMs: number | null;
  lastCanaryError: string | null;
}): GatewayConfigResponse => ({
  agentId: config.agentId,
  ownerAddress: config.ownerAddress,
  serviceSlug: config.serviceSlug,
  endpointUrl: config.endpointUrl,
  canaryPath: config.canaryPath,
  canaryMethod: config.canaryMethod,
  readinessStatus: config.readinessStatus,
  lastCanaryCheckedAt: config.lastCanaryCheckedAt?.toISOString() ?? null,
  lastCanaryPassedAt: config.lastCanaryPassedAt?.toISOString() ?? null,
  lastCanaryStatusCode: config.lastCanaryStatusCode,
  lastCanaryLatencyMs: config.lastCanaryLatencyMs,
  lastCanaryError: config.lastCanaryError,
});

const parseActorAddress = (value: unknown): string | null => {
  if (value == null) return null;
  return normalizeOwnerAddress(value);
};

const parseBoolean = (value: string | null): boolean =>
  value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const parseHistoryLimit = (value: string | null): number => {
  if (!value) return DEFAULT_HISTORY_LIMIT;
  if (!/^\d+$/.test(value.trim())) return DEFAULT_HISTORY_LIMIT;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(parsed, MAX_HISTORY_LIMIT);
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const agentId = normalizeAgentId(request.nextUrl.searchParams.get("agentId"));
  const includeHistory = parseBoolean(request.nextUrl.searchParams.get("includeHistory"));
  const historyLimit = parseHistoryLimit(request.nextUrl.searchParams.get("historyLimit"));
  if (!agentId) {
    return json({ code: 400, error: "agentId is required." }, 400);
  }

  try {
    const agent = await prisma.agent.findUnique({
      where: { agentId },
      select: { agentId: true, owner: true },
    });

    if (!agent) {
      return json({ code: 404, error: "Agent not found." }, 404);
    }

    const config = includeHistory
      ? await prisma.agentGatewayConfig.findUnique({
          where: { agentId },
          include: {
            canaryChecks: {
              orderBy: { checkedAt: "desc" },
              take: historyLimit,
              select: {
                id: true,
                checkedAt: true,
                success: true,
                statusCode: true,
                latencyMs: true,
                error: true,
              },
            },
          },
        })
      : await prisma.agentGatewayConfig.findUnique({
          where: { agentId },
        });

    if (!config) {
      return json(
        {
          configured: false,
          config: {
            agentId: agent.agentId,
            ownerAddress: agent.owner.toLowerCase(),
            serviceSlug: deriveAgentServiceSlug(agent.agentId),
            endpointUrl: null,
            canaryPath: null,
            canaryMethod: null,
            readinessStatus: "UNCONFIGURED",
            lastCanaryCheckedAt: null,
            lastCanaryPassedAt: null,
            lastCanaryStatusCode: null,
            lastCanaryLatencyMs: null,
            lastCanaryError: null,
          } satisfies GatewayConfigResponse,
        },
        200,
      );
    }

    return json(
      {
        configured: true,
        config: ({
          ...toGatewayConfigResponse(config),
          ...(includeHistory && "canaryChecks" in config
            ? {
                canaryHistory: (config.canaryChecks as GatewayCanaryHistoryRow[]).map((row) => ({
                  id: row.id,
                  checkedAt: row.checkedAt.toISOString(),
                  success: row.success,
                  statusCode: row.statusCode,
                  latencyMs: row.latencyMs,
                  error: row.error,
                })),
              }
            : {}),
        }) satisfies GatewayConfigResponse,
      },
      200,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return json(
        {
          code: 503,
          error: "AgentGatewayConfig table is not available. Apply the Prisma schema update before using this endpoint.",
        },
        503,
      );
    }
    return json({ code: 500, error: "Failed to load gateway config." }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, error: "Invalid JSON body." }, 400);
  }

  const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (!payload) {
    return json({ code: 400, error: "Request body must be an object." }, 400);
  }

  const agentId = normalizeAgentId(payload.agentId);
  const ownerAddress = normalizeOwnerAddress(payload.ownerAddress);
  const actorAddress = parseActorAddress(payload.actorAddress);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";
  const endpoint = normalizeMerchantEndpointUrl(payload.endpointUrl);

  if (!agentId) return json({ code: 400, error: "agentId is required." }, 400);
  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (payload.actorAddress != null && !actorAddress) {
    return json({ code: 400, error: "actorAddress must be a valid 0x address when provided." }, 400);
  }
  if (!actorAddress) {
    return json({ code: 400, error: "actorAddress is required." }, 400);
  }
  if (!authSignature) {
    return json({ code: 400, error: "authSignature is required." }, 400);
  }
  if (!endpoint) {
    return json(
      {
        code: 400,
        error:
          "endpointUrl is invalid. Use https in production; localhost/http is allowed in development only.",
      },
      400,
    );
  }

  const canaryPath = normalizeCanaryPath(payload.canaryPath);
  if (!canaryPath) return json({ code: 400, error: "canaryPath must be a relative path starting with '/'." }, 400);

  const canaryMethod = normalizeCanaryMethod(payload.canaryMethod);
  if (!canaryMethod) return json({ code: 400, error: "Only HTTP GET canaryMethod is supported in Phase A." }, 400);

  const serviceSlug = normalizeServiceSlug(payload.serviceSlug, agentId);
  if (!serviceSlug) {
    return json(
      {
        code: 400,
        error: `serviceSlug must match the derived agent slug "${deriveAgentServiceSlug(agentId)}".`,
      },
      400,
    );
  }

  const rateLimit = consumeAgentGatewayRateLimit({
    request,
    action: "config",
    actorAddress,
    agentId,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      { code: 429, error: rateLimit.error },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  try {
    const agent = await prisma.agent.findUnique({
      where: { agentId },
      select: { agentId: true, owner: true },
    });

    if (!agent) {
      return json({ code: 404, error: "Agent not found." }, 404);
    }

    const canonicalOwner = agent.owner.toLowerCase();
    if (canonicalOwner !== ownerAddress) {
      return json(
        {
          code: 403,
          error: "ownerAddress does not match the indexed agent owner.",
          expectedOwnerAddress: canonicalOwner,
        },
        403,
      );
    }

    if (actorAddress !== canonicalOwner) {
      return json(
        {
          code: 403,
          error: "actorAddress must match the indexed agent owner for gateway registration.",
          expectedOwnerAddress: canonicalOwner,
        },
        403,
      );
    }

    const authResult = await verifyMerchantGatewaySignedWrite({
      action: "config",
      agentId,
      ownerAddress: canonicalOwner,
      actorAddress,
      serviceSlug,
      authPayload,
      authSignature,
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

    const config = await prisma.agentGatewayConfig.upsert({
      where: { agentId },
      create: {
        agentId,
        ownerAddress: canonicalOwner,
        serviceSlug,
        endpointUrl: endpoint.normalizedUrl,
        canaryPath,
        canaryMethod,
        readinessStatus: "CONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
        lastCanaryStatusCode: null,
        lastCanaryLatencyMs: null,
        lastCanaryError: null,
      },
      update: {
        ownerAddress: canonicalOwner,
        serviceSlug,
        endpointUrl: endpoint.normalizedUrl,
        canaryPath,
        canaryMethod,
        readinessStatus: "CONFIGURED",
        lastCanaryCheckedAt: null,
        lastCanaryPassedAt: null,
        lastCanaryStatusCode: null,
        lastCanaryLatencyMs: null,
        lastCanaryError: null,
      },
    });

    return json(
      {
        ok: true,
        nextAction: "VERIFY_GW_CANARY",
        authMode: "wallet-signature",
        config: toGatewayConfigResponse(config),
      },
      200,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return json(
        {
          code: 503,
          error: "AgentGatewayConfig table is not available. Apply the Prisma schema update before using this endpoint.",
        },
        503,
      );
    }

    return json({ code: 500, error: "Failed to save gateway config." }, 500);
  }
}
