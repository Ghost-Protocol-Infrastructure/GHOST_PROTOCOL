import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeAgentId } from "@/lib/agent-gateway";
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const agentId = normalizeAgentId(request.nextUrl.searchParams.get("agentId"));
  if (!agentId) {
    return json({ code: 400, error: "agentId is required." }, 400);
  }

  try {
    const config = await prisma.agentGatewayConfig.findUnique({
      where: { agentId },
      include: {
        agent: { select: { owner: true } },
        delegatedSigners: {
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          select: {
            id: true,
            signerAddress: true,
            status: true,
            label: true,
            createdAt: true,
            revokedAt: true,
          },
        },
      },
    });

    if (!config) {
      const agent = await prisma.agent.findUnique({
        where: { agentId },
        select: { agentId: true, owner: true },
      });
      if (!agent) {
        return json({ code: 404, error: "Agent not found." }, 404);
      }
      return json(
        {
          code: 404,
          error: "Gateway config not found for agent. Register and verify the gateway before managing delegated signers.",
          agentId: agent.agentId,
          ownerAddress: agent.owner.toLowerCase(),
        },
        404,
      );
    }

    const signers = config.delegatedSigners.map(toDelegatedSignerResponse);
    const activeSignerCount = config.delegatedSigners.filter((row) => row.status === "ACTIVE").length;

    return json(
      {
        ok: true,
        agentId: config.agentId,
        ownerAddress: config.agent.owner.toLowerCase(),
        serviceSlug: config.serviceSlug,
        gatewayConfigId: config.id,
        authMode: "public-read",
        maxActiveSigners: AGENT_GATEWAY_MAX_ACTIVE_DELEGATED_SIGNERS,
        activeSignerCount,
        signers,
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
    return json({ code: 500, error: "Failed to load delegated signers." }, 500);
  }
}

