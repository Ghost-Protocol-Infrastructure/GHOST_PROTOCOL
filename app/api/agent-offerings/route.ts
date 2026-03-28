import { NextRequest, NextResponse } from "next/server";
import { normalizeAgentId, normalizeOwnerAddress } from "@/lib/agent-gateway";
import {
  agentOfferingsAuth,
  countAgentOfferings,
  getAgentOfferingMutationContext,
  getNextAgentOfferingSortOrder,
  listAgentOfferings,
  mapAgentOfferingRow,
  MAX_AGENT_OFFERINGS,
  parseAgentOfferingInput,
  validateAgentOfferingTargetBinding,
} from "@/lib/agent-offerings";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseBoolean = (value: string | null): boolean =>
  value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const parseActorAddress = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  return normalizeOwnerAddress(value);
};

const parseAuthPayloadHeader = (value: string | null): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const agentId = normalizeAgentId(request.nextUrl.searchParams.get("agentId"));
  if (!agentId) {
    return json({ code: 400, error: "agentId is required." }, 400);
  }

  try {
    const includeInactive = parseBoolean(request.nextUrl.searchParams.get("includeInactive"));
    if (includeInactive) {
      const ownerAddress = normalizeOwnerAddress(request.headers.get("x-ghost-offerings-owner-address"));
      const actorAddress = parseActorAddress(request.headers.get("x-ghost-offerings-actor-address"));
      const authPayload = parseAuthPayloadHeader(request.headers.get("x-ghost-offerings-auth-payload"));
      const authSignature = request.headers.get("x-ghost-offerings-auth-signature")?.trim() ?? "";

      if (!ownerAddress || !actorAddress || !authPayload || !authSignature) {
        return json({ code: 401, error: "Draft offerings require merchant authorization." }, 401);
      }

      const gatewayConfig = await getAgentOfferingMutationContext(agentId);
      if (!gatewayConfig) {
        return json(
          { code: 409, error: "Activate GhostGate for this agent before reading draft offerings." },
          409,
        );
      }

      if (gatewayConfig.ownerAddress !== ownerAddress) {
        return json(
          {
            code: 403,
            error: "ownerAddress does not match the selected agent gateway owner.",
            expectedOwnerAddress: gatewayConfig.ownerAddress,
          },
          403,
        );
      }

      const authResult = await agentOfferingsAuth.verifyMerchantGatewaySignedWrite({
        action: "offerings_manage",
        agentId: gatewayConfig.agentId,
        ownerAddress: gatewayConfig.ownerAddress,
        actorAddress,
        serviceSlug: gatewayConfig.serviceSlug,
        authPayload,
        authSignature,
        consumeNonce: false,
      });
      if (!authResult.ok) {
        return json(
          { code: authResult.status, error: authResult.error, authCode: authResult.code ?? null },
          authResult.status,
        );
      }
    }

    const offerings = await listAgentOfferings({
      agentId,
      includeInactive,
    });
    return json({
      ok: true,
      apiVersion: 1,
      items: offerings,
    });
  } catch (error) {
    console.error("Failed to load agent offerings.", error);
    return json({ code: 500, error: "Failed to load agent offerings." }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, error: "Invalid JSON body." }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ code: 400, error: "Request body must be an object." }, 400);
  }

  const payload = body as Record<string, unknown>;
  const agentId = normalizeAgentId(payload.agentId);
  const ownerAddress = normalizeOwnerAddress(payload.ownerAddress);
  const actorAddress = parseActorAddress(payload.actorAddress);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";

  if (!agentId) return json({ code: 400, error: "agentId is required." }, 400);
  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (!actorAddress) return json({ code: 400, error: "actorAddress must be a valid 0x address." }, 400);
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);

  const parsed = parseAgentOfferingInput(payload);
  if (!parsed.ok) {
    return json({ code: parsed.status, error: parsed.error, field: parsed.field ?? null }, parsed.status);
  }

  try {
    const gatewayConfig = await getAgentOfferingMutationContext(agentId);
    if (!gatewayConfig) {
      return json(
        { code: 409, error: "Activate GhostGate for this agent before managing public offerings." },
        409,
      );
    }

    if (gatewayConfig.ownerAddress !== ownerAddress) {
      return json(
        {
          code: 403,
          error: "ownerAddress does not match the selected agent gateway owner.",
          expectedOwnerAddress: gatewayConfig.ownerAddress,
        },
        403,
      );
    }

    const authResult = await agentOfferingsAuth.verifyMerchantGatewaySignedWrite({
      action: "offerings_manage",
      agentId: gatewayConfig.agentId,
      ownerAddress: gatewayConfig.ownerAddress,
      actorAddress,
      serviceSlug: gatewayConfig.serviceSlug,
      authPayload,
      authSignature,
    });
    if (!authResult.ok) {
      return json(
        { code: authResult.status, error: authResult.error, authCode: authResult.code ?? null },
        authResult.status,
      );
    }

    const targetValidation = validateAgentOfferingTargetBinding({
      rail: parsed.value.rail!,
      targetKind: parsed.value.targetKind!,
      targetRef: parsed.value.targetRef!,
      serviceSlug: gatewayConfig.serviceSlug,
    });
    if (!targetValidation.ok) {
      return json(
        { code: targetValidation.status, error: targetValidation.error, field: targetValidation.field ?? null },
        targetValidation.status,
      );
    }

    const offeringCount = await countAgentOfferings(agentId);
    if (offeringCount >= MAX_AGENT_OFFERINGS) {
      return json(
        { code: 409, error: `An agent can have at most ${MAX_AGENT_OFFERINGS} offerings.` },
        409,
      );
    }

    const sortOrder = await getNextAgentOfferingSortOrder(agentId);
    const created = await prisma.agentOffering.create({
      data: {
        agentId,
        title: parsed.value.title!,
        description: parsed.value.description!,
        consumerCommand: parsed.value.consumerCommand!,
        rail: parsed.value.rail!,
        targetKind: parsed.value.targetKind!,
        targetRef: parsed.value.targetRef!,
        priceHint: parsed.value.priceHint ?? null,
        etaHint: parsed.value.etaHint ?? null,
        isActive: parsed.value.isActive ?? true,
        sortOrder,
      },
    });

    return json({
      ok: true,
      apiVersion: 1,
      item: await mapAgentOfferingRow({
        id: created.id,
        agentId: created.agentId,
        title: created.title,
        description: created.description,
        consumerCommand: created.consumerCommand,
        rail: created.rail,
        targetKind: created.targetKind,
        targetRef: created.targetRef,
        priceHint: created.priceHint,
        etaHint: created.etaHint,
        isActive: created.isActive,
        sortOrder: created.sortOrder,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      }),
    });
  } catch (error) {
    console.error("Failed to create agent offering.", error);
    return json({ code: 500, error: "Failed to create agent offering." }, 500);
  }
}
