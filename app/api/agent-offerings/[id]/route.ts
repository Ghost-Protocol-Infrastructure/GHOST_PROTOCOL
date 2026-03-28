import { NextRequest, NextResponse } from "next/server";
import { normalizeAgentId, normalizeOwnerAddress } from "@/lib/agent-gateway";
import {
  agentOfferingsAuth,
  getAgentOfferingMutationContext,
  mapAgentOfferingRow,
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

const parseActorAddress = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  return normalizeOwnerAddress(value);
};

const loadOfferingForMutation = async (id: string) =>
  prisma.agentOffering.findUnique({
    where: { id },
  });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
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
  const ownerAddress = normalizeOwnerAddress(payload.ownerAddress);
  const actorAddress = parseActorAddress(payload.actorAddress);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";
  const requestedAgentId = payload.agentId == null ? null : normalizeAgentId(payload.agentId);

  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (!actorAddress) return json({ code: 400, error: "actorAddress must be a valid 0x address." }, 400);
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);

  const parsed = parseAgentOfferingInput(payload, { partial: true });
  if (!parsed.ok) {
    return json({ code: parsed.status, error: parsed.error, field: parsed.field ?? null }, parsed.status);
  }

  try {
    const existing = await loadOfferingForMutation(id);
    if (!existing) {
      return json({ code: 404, error: "Agent offering not found." }, 404);
    }

    if (requestedAgentId && requestedAgentId !== existing.agentId) {
      return json({ code: 400, error: "agentId does not match the target offering." }, 400);
    }

    const gatewayConfig = await getAgentOfferingMutationContext(existing.agentId);
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

    const merged = {
      rail: (parsed.value.rail ?? existing.rail) as "X402" | "EXPRESS" | "GHOSTWIRE",
      targetKind: (parsed.value.targetKind ?? existing.targetKind) as
        | "SERVICE_SLUG"
        | "MCP_TOOL"
        | "GHOSTWIRE_INTENT",
      targetRef: parsed.value.targetRef ?? existing.targetRef,
    };

    const targetValidation = validateAgentOfferingTargetBinding({
      rail: merged.rail,
      targetKind: merged.targetKind,
      targetRef: merged.targetRef,
      serviceSlug: gatewayConfig.serviceSlug,
    });
    if (!targetValidation.ok) {
      return json(
        { code: targetValidation.status, error: targetValidation.error, field: targetValidation.field ?? null },
        targetValidation.status,
      );
    }

    const updated = await prisma.agentOffering.update({
      where: { id: existing.id },
      data: {
        ...(parsed.value.title != null ? { title: parsed.value.title } : {}),
        ...(parsed.value.description != null ? { description: parsed.value.description } : {}),
        ...(parsed.value.consumerCommand != null ? { consumerCommand: parsed.value.consumerCommand } : {}),
        ...(parsed.value.rail != null ? { rail: parsed.value.rail } : {}),
        ...(parsed.value.targetKind != null ? { targetKind: parsed.value.targetKind } : {}),
        ...(parsed.value.targetRef != null ? { targetRef: parsed.value.targetRef } : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed.value, "priceHint") ? { priceHint: parsed.value.priceHint ?? null } : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed.value, "etaHint") ? { etaHint: parsed.value.etaHint ?? null } : {}),
        ...(typeof parsed.value.isActive === "boolean" ? { isActive: parsed.value.isActive } : {}),
      },
    });

    return json({
      ok: true,
      apiVersion: 1,
      item: await mapAgentOfferingRow({
        id: updated.id,
        agentId: updated.agentId,
        title: updated.title,
        description: updated.description,
        consumerCommand: updated.consumerCommand,
        rail: updated.rail,
        targetKind: updated.targetKind,
        targetRef: updated.targetRef,
        priceHint: updated.priceHint,
        etaHint: updated.etaHint,
        isActive: updated.isActive,
        sortOrder: updated.sortOrder,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }),
    });
  } catch (error) {
    console.error("Failed to update agent offering.", error);
    return json({ code: 500, error: "Failed to update agent offering." }, 500);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ code: 400, error: "Request body must be an object." }, 400);
  }

  const payload = body as Record<string, unknown>;
  const ownerAddress = normalizeOwnerAddress(payload.ownerAddress);
  const actorAddress = parseActorAddress(payload.actorAddress);
  const authPayload = payload.authPayload;
  const authSignature = typeof payload.authSignature === "string" ? payload.authSignature.trim() : "";

  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (!actorAddress) return json({ code: 400, error: "actorAddress must be a valid 0x address." }, 400);
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);

  try {
    const existing = await loadOfferingForMutation(id);
    if (!existing) {
      return json({ code: 404, error: "Agent offering not found." }, 404);
    }

    const gatewayConfig = await getAgentOfferingMutationContext(existing.agentId);
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

    await prisma.agentOffering.delete({
      where: { id: existing.id },
    });

    return json({ ok: true, apiVersion: 1 });
  } catch (error) {
    console.error("Failed to delete agent offering.", error);
    return json({ code: 500, error: "Failed to delete agent offering." }, 500);
  }
}
