import { NextRequest, NextResponse } from "next/server";
import { type AgentGatewayDelegatedSigner } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeAgentId, normalizeOwnerAddress, normalizeServiceSlug } from "@/lib/agent-gateway";
import { verifyMerchantGatewaySignedWrite } from "@/lib/agent-gateway-auth-server";
import { consumeAgentGatewayRateLimit } from "@/lib/agent-gateway-rate-limit";
import {
  AGENT_GATEWAY_MAX_ACTIVE_DELEGATED_SIGNERS,
  toDelegatedSignerResponse,
} from "@/lib/agent-gateway-delegated-signers";

export const runtime = "nodejs";

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const isMissingDelegatedSignerTableError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ((error as { code?: string }).code === "P2021" || (error as { code?: string }).code === "P2022");

type ListedSigner = Pick<
  AgentGatewayDelegatedSigner,
  "id" | "signerAddress" | "status" | "label" | "createdAt" | "revokedAt"
>;

const loadGatewaySigners = async (gatewayConfigId: string): Promise<ListedSigner[]> =>
  prisma.agentGatewayDelegatedSigner.findMany({
    where: { gatewayConfigId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      signerAddress: true,
      status: true,
      label: true,
      createdAt: true,
      revokedAt: true,
    },
  });

const normalizeDelegatedSignerId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return trimmed;
};

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
  const delegatedSignerId = normalizeDelegatedSignerId(payload.delegatedSignerId);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";
  const serviceSlug = agentId ? normalizeServiceSlug(payload.serviceSlug, agentId) : null;

  if (!agentId) return json({ code: 400, error: "agentId is required." }, 400);
  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (payload.actorAddress != null && !actorAddress) {
    return json({ code: 400, error: "actorAddress must be a valid 0x address when provided." }, 400);
  }
  if (!actorAddress) return json({ code: 400, error: "actorAddress is required." }, 400);
  if (!delegatedSignerId) return json({ code: 400, error: "delegatedSignerId is required." }, 400);
  if (!serviceSlug) {
    return json({ code: 400, error: `serviceSlug must match "agent-${agentId}".` }, 400);
  }
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);

  const rateLimit = consumeAgentGatewayRateLimit({
    request,
    action: "delegated_signer_revoke",
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
      include: { agent: { select: { owner: true } } },
    });

    if (!config) {
      return json({ code: 404, error: "Gateway config not found for agent. Register the gateway first." }, 404);
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
          error: "actorAddress must match the indexed agent owner for delegated signer revocation.",
          expectedOwnerAddress: canonicalOwner,
        },
        403,
      );
    }
    if (serviceSlug !== config.serviceSlug) {
      return json(
        {
          code: 400,
          error: "serviceSlug does not match the configured gateway service slug.",
          expectedServiceSlug: config.serviceSlug,
        },
        400,
      );
    }

    const authResult = await verifyMerchantGatewaySignedWrite({
      action: "delegated_signer_revoke",
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

    const signer = await prisma.agentGatewayDelegatedSigner.findUnique({
      where: { id: delegatedSignerId },
      select: {
        id: true,
        gatewayConfigId: true,
        signerAddress: true,
        status: true,
      },
    });

    if (!signer || signer.gatewayConfigId !== config.id) {
      return json({ code: 404, error: "Delegated signer not found for this agent gateway." }, 404);
    }

    let revoked = false;
    let alreadyRevoked = false;

    if (signer.status === "REVOKED") {
      alreadyRevoked = true;
    } else {
      await prisma.agentGatewayDelegatedSigner.update({
        where: { id: signer.id },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
        },
      });
      revoked = true;
    }

    const signers = await loadGatewaySigners(config.id);
    const activeSignerCount = signers.filter((row) => row.status === "ACTIVE").length;

    return json(
      {
        ok: true,
        revoked,
        alreadyRevoked,
        gatewayConfigId: config.id,
        agentId: config.agentId,
        ownerAddress: canonicalOwner,
        serviceSlug: config.serviceSlug,
        revokedSignerId: signer.id,
        revokedSignerAddress: signer.signerAddress.toLowerCase(),
        authMode: "wallet-signature",
        maxActiveSigners: AGENT_GATEWAY_MAX_ACTIVE_DELEGATED_SIGNERS,
        activeSignerCount,
        signers: signers.map(toDelegatedSignerResponse),
      },
      200,
    );
  } catch (error) {
    if (isMissingDelegatedSignerTableError(error)) {
      return json(
        {
          code: 503,
          error:
            "Delegated signer tables are not available. Apply the Prisma schema update before using this endpoint.",
        },
        503,
      );
    }
    return json({ code: 500, error: "Failed to revoke delegated signer." }, 500);
  }
}

