import { NextRequest } from "next/server";
import { parsePositiveIntBounded } from "@/lib/fulfillment-route";
import { ghostWireAdminJson, isGhostWireOperatorAuthorized } from "@/lib/ghostwire-admin-route";
import { ghostWireJson, isRecord, parseGhostWireJsonBody } from "@/lib/ghostwire-route";
import {
  GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT,
  GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT,
  GHOSTWIRE_OPERATOR_MAX_LIMIT,
  processGhostWireOperatorTick,
  resolveGhostWireOperatorSnapshot,
} from "@/lib/ghostwire-operator";

export const runtime = "nodejs";

const parseLimitValue = (value: unknown, fallback: number): number =>
  parsePositiveIntBounded({
    value:
      typeof value === "number"
        ? String(Math.trunc(value))
        : typeof value === "string"
          ? value
          : null,
    fallback,
    max: GHOSTWIRE_OPERATOR_MAX_LIMIT,
  });

export async function GET(request: NextRequest) {
  if (!isGhostWireOperatorAuthorized(request)) {
    return ghostWireAdminJson(
      { code: 401, error: "Unauthorized GhostWire operator request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const workflowLimit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("workflowLimit"),
    fallback: GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT,
    max: GHOSTWIRE_OPERATOR_MAX_LIMIT,
  });
  const webhookLimit = parsePositiveIntBounded({
    value: request.nextUrl.searchParams.get("webhookLimit"),
    fallback: GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT,
    max: GHOSTWIRE_OPERATOR_MAX_LIMIT,
  });

  try {
    const snapshot = await resolveGhostWireOperatorSnapshot({
      workflowLimit,
      webhookLimit,
    });

    return ghostWireAdminJson(
      {
        ok: true,
        authMode: "bearer-secret",
        operatorMode: "direct-artifact-reconcile-webhooks",
        ...snapshot,
      },
      200,
    );
  } catch (error) {
    return ghostWireAdminJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to inspect GhostWire operator backlog.",
        errorCode: "GHOSTWIRE_OPERATOR_INSPECT_FAILED",
      },
      500,
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isGhostWireOperatorAuthorized(request)) {
    return ghostWireAdminJson(
      { code: 401, error: "Unauthorized GhostWire operator request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const parsed = await parseGhostWireJsonBody(request);
  if (!parsed.ok) {
    return ghostWireJson(
      { code: parsed.status, error: parsed.error, errorCode: parsed.errorCode },
      parsed.status,
    );
  }

  if (!isRecord(parsed.body)) {
    return ghostWireJson(
      {
        code: 400,
        error: "Invalid GhostWire operator request shape.",
        errorCode: "INVALID_GHOSTWIRE_OPERATOR_REQUEST",
      },
      400,
    );
  }

  const workflowLimit = parseLimitValue(parsed.body.workflowLimit, GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT);
  const webhookLimit = parseLimitValue(parsed.body.webhookLimit, GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT);

  try {
    const tick = await processGhostWireOperatorTick({
      workflowLimit,
      webhookLimit,
    });

    return ghostWireAdminJson(
      {
        authMode: "bearer-secret",
        ...tick,
      },
      200,
    );
  } catch (error) {
    return ghostWireAdminJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to execute GhostWire operator tick.",
        errorCode: "GHOSTWIRE_OPERATOR_EXECUTE_FAILED",
      },
      500,
    );
  }
}
