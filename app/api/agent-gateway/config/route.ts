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

export const runtime = "nodejs";

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const agentId = normalizeAgentId(request.nextUrl.searchParams.get("agentId"));
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

    const config = await prisma.agentGatewayConfig.findUnique({
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

    return json({ configured: true, config: toGatewayConfigResponse(config) }, 200);
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
