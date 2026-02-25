import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  normalizeAgentId,
  normalizeOwnerAddress,
} from "@/lib/agent-gateway";
import { deriveAgentServiceSlug, normalizeServiceSlug } from "@/lib/agent-gateway";
import {
  isMissingAgentGatewayPhaseBTableError,
  persistAgentGatewayCanaryOutcome,
  runAgentGatewayCanaryCheck,
} from "@/lib/agent-gateway-canary";
import { verifyMerchantGatewaySignedWrite } from "@/lib/agent-gateway-auth-server";
import { consumeAgentGatewayRateLimit } from "@/lib/agent-gateway-rate-limit";

export const runtime = "nodejs";

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

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
  const actorAddress = payload.actorAddress == null ? null : normalizeOwnerAddress(payload.actorAddress);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";
  const serviceSlug = agentId ? normalizeServiceSlug(payload.serviceSlug, agentId) : null;

  if (!agentId) return json({ code: 400, error: "agentId is required." }, 400);
  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (payload.actorAddress != null && !actorAddress) {
    return json({ code: 400, error: "actorAddress must be a valid 0x address when provided." }, 400);
  }
  if (!actorAddress) return json({ code: 400, error: "actorAddress is required." }, 400);
  if (!serviceSlug) {
    return json(
      { code: 400, error: `serviceSlug must match the derived agent slug "${deriveAgentServiceSlug(agentId)}".` },
      400,
    );
  }
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);

  const rateLimit = consumeAgentGatewayRateLimit({
    request,
    action: "verify",
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
    const config = await prisma.agentGatewayConfig.findUnique({
      where: { agentId },
      include: {
        agent: {
          select: { owner: true },
        },
      },
    });

    if (!config) {
      return json({ code: 404, error: "Gateway config not found for agent. Register first." }, 404);
    }

    const canonicalOwner = config.agent.owner.toLowerCase();
    if (ownerAddress !== canonicalOwner || config.ownerAddress.toLowerCase() !== canonicalOwner) {
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
          error: "actorAddress must match the indexed agent owner for gateway verification.",
          expectedOwnerAddress: canonicalOwner,
        },
        403,
      );
    }

    const authResult = await verifyMerchantGatewaySignedWrite({
      action: "verify",
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

    const canaryResult = await runAgentGatewayCanaryCheck(config, {
      userAgent: "ghostprotocol-canary/manual-verify",
    });

    const persisted = await persistAgentGatewayCanaryOutcome({
      config,
      result: canaryResult,
    });

    if (!canaryResult.success) {
      return json(
        {
          ok: false,
          verified: false,
          canaryUrl: canaryResult.canaryUrl,
          serviceSlug: config.serviceSlug,
          readinessStatus: persisted.readinessStatus,
          statusCode: canaryResult.statusCode,
          latencyMs: canaryResult.latencyMs,
          error: canaryResult.error,
          historyRecorded: persisted.historyRecorded,
          authMode: "wallet-signature",
        },
        422,
      );
    }

    return json(
      {
        ok: true,
        verified: true,
        canaryUrl: canaryResult.canaryUrl,
        serviceSlug: config.serviceSlug,
        readinessStatus: persisted.readinessStatus,
        statusCode: canaryResult.statusCode,
        latencyMs: canaryResult.latencyMs,
        historyRecorded: persisted.historyRecorded,
        authMode: "wallet-signature",
      },
      200,
    );
  } catch (error) {
    if (isMissingAgentGatewayPhaseBTableError(error)) {
      return json(
        {
          code: 503,
          error:
            "Agent gateway readiness tables are not fully available. Apply the Prisma schema update before using this endpoint.",
        },
        503,
      );
    }

    return json({ code: 500, error: "Failed to verify gateway canary." }, 500);
  }
}
