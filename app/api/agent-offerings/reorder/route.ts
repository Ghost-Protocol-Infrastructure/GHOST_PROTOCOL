import { NextRequest, NextResponse } from "next/server";
import { normalizeAgentId, normalizeOwnerAddress } from "@/lib/agent-gateway";
import { agentOfferingsAuth, getAgentOfferingMutationContext, validateOfferingReorder } from "@/lib/agent-offerings";
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
  const orderedIds =
    Array.isArray(payload.orderedIds) && payload.orderedIds.every((value) => typeof value === "string")
      ? (payload.orderedIds as string[])
      : null;

  if (!agentId) return json({ code: 400, error: "agentId is required." }, 400);
  if (!ownerAddress) return json({ code: 400, error: "ownerAddress must be a valid 0x address." }, 400);
  if (!actorAddress) return json({ code: 400, error: "actorAddress must be a valid 0x address." }, 400);
  if (!authSignature) return json({ code: 400, error: "authSignature is required." }, 400);
  if (!orderedIds) return json({ code: 400, error: "orderedIds must be an array of offering IDs." }, 400);

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

    const existing = await prisma.agentOffering.findMany({
      where: { agentId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });

    const reorderValidation = validateOfferingReorder({
      existingIds: existing.map((row) => row.id),
      orderedIds,
    });
    if (!reorderValidation.ok) {
      return json({ code: reorderValidation.status, error: reorderValidation.error }, reorderValidation.status);
    }

    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.agentOffering.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    return json({ ok: true, apiVersion: 1 });
  } catch (error) {
    console.error("Failed to reorder agent offerings.", error);
    return json({ code: 500, error: "Failed to reorder agent offerings." }, 500);
  }
}
