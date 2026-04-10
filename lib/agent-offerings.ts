import { formatEther } from "viem";
import { GHOST_CREDIT_PRICE_WEI } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { verifyMerchantGatewaySignedWrite } from "@/lib/agent-gateway-auth-server";
import { resolveGhostExpressServiceCost } from "@/lib/ghost-express-pricing";
import {
  AGENT_OFFERING_RAILS,
  AGENT_OFFERING_TARGET_KINDS,
  describeAgentOfferingTarget,
  isAgentOfferingRail,
  isAgentOfferingTargetKind,
  type AgentOfferingRailValue,
  type AgentOfferingTargetKindValue,
  type CanonicalOfferingPrice,
  type SerializedAgentOffering,
} from "@/lib/agent-offerings-shared";

export {
  AGENT_OFFERING_RAILS,
  AGENT_OFFERING_TARGET_KINDS,
  describeAgentOfferingTarget,
  isAgentOfferingRail,
  isAgentOfferingTargetKind,
};
export type {
  AgentOfferingRailValue,
  AgentOfferingTargetKindValue,
  CanonicalOfferingPrice,
  SerializedAgentOffering,
};

export const MAX_AGENT_OFFERINGS = 20;
export const AGENT_OFFERING_TITLE_MAX_LENGTH = 120;
export const AGENT_OFFERING_DESCRIPTION_MAX_LENGTH = 1000;
export const AGENT_OFFERING_COMMAND_MAX_LENGTH = 500;
export const AGENT_OFFERING_TARGET_REF_MAX_LENGTH = 160;
export const AGENT_OFFERING_PRICE_HINT_MAX_LENGTH = 64;
export const AGENT_OFFERING_ETA_HINT_MAX_LENGTH = 64;

export type AgentOfferingRecord = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  consumerCommand: string;
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  priceHint: string | null;
  etaHint: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentOfferingMutationInput = {
  title: string;
  description: string;
  consumerCommand: string;
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  priceHint: string | null;
  etaHint: string | null;
  isActive: boolean;
};

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; field?: string };

const normalizeRequiredString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
};

const normalizeOptionalString = (value: unknown, maxLength: number): string | null => {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) return null;
  return normalized;
};

const formatCreditLabel = (credits: bigint): string => `${credits.toString()} ${credits === 1n ? "credit" : "credits"}`;

const formatEstimatedEthLabel = (credits: bigint): string => {
  const estimatedWei = credits * GHOST_CREDIT_PRICE_WEI;
  return `${formatEther(estimatedWei)} ETH`;
};

export const resolveCanonicalOfferingPrice = async (input: {
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
}): Promise<CanonicalOfferingPrice | null> => {
  if (input.rail !== "EXPRESS" || input.targetKind !== "SERVICE_SLUG") {
    return null;
  }

  const { cost: creditCost } = await resolveGhostExpressServiceCost(input.targetRef);

  const estimatedEthWei = creditCost * GHOST_CREDIT_PRICE_WEI;
  const creditsLabel = formatCreditLabel(creditCost);
  const estimatedEthLabel = `${formatEther(estimatedEthWei)} ETH`;

  return {
    credits: creditCost.toString(),
    estimatedEthWei: estimatedEthWei.toString(),
    creditsLabel,
    estimatedEthLabel,
    primaryDisplay: `${creditsLabel} (~${estimatedEthLabel})`,
    source: "service_pricing",
  };
};

export const serializeAgentOffering = async (offering: AgentOfferingRecord): Promise<SerializedAgentOffering> => {
  const target = describeAgentOfferingTarget(offering.targetKind, offering.targetRef);
  const canonicalPricing = await resolveCanonicalOfferingPrice({
    rail: offering.rail,
    targetKind: offering.targetKind,
    targetRef: offering.targetRef,
  });

  return {
    id: offering.id,
    agentId: offering.agentId,
    title: offering.title,
    description: offering.description,
    consumerCommand: offering.consumerCommand,
    rail: offering.rail,
    targetKind: offering.targetKind,
    targetRef: offering.targetRef,
    targetLabel: target.label,
    targetDescription: target.description,
    priceHint: offering.priceHint,
    etaHint: offering.etaHint,
    isActive: offering.isActive,
    sortOrder: offering.sortOrder,
    canonicalPricing,
    createdAt: offering.createdAt.toISOString(),
    updatedAt: offering.updatedAt.toISOString(),
  };
};

export const listAgentOfferings = async (input: {
  agentId: string;
  includeInactive?: boolean;
}): Promise<SerializedAgentOffering[]> => {
  const rows = await prisma.agentOffering.findMany({
    where: {
      agentId: input.agentId,
      ...(input.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return Promise.all(
    rows.map((row) =>
      serializeAgentOffering({
        id: row.id,
        agentId: row.agentId,
        title: row.title,
        description: row.description,
        consumerCommand: row.consumerCommand,
        rail: row.rail as AgentOfferingRailValue,
        targetKind: row.targetKind as AgentOfferingTargetKindValue,
        targetRef: row.targetRef,
        priceHint: row.priceHint,
        etaHint: row.etaHint,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
  );
};

export const getAgentOfferingMutationContext = async (agentId: string) => {
  return prisma.agentGatewayConfig.findUnique({
    where: { agentId },
    select: {
      id: true,
      agentId: true,
      ownerAddress: true,
      serviceSlug: true,
    },
  });
};

export const countAgentOfferings = async (agentId: string): Promise<number> =>
  prisma.agentOffering.count({
    where: { agentId },
  });

export const getNextAgentOfferingSortOrder = async (agentId: string): Promise<number> => {
  const row = await prisma.agentOffering.findFirst({
    where: { agentId },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
    select: { sortOrder: true },
  });
  return row ? row.sortOrder + 1 : 0;
};

export const validateAgentOfferingTargetBinding = (input: {
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  serviceSlug: string;
}): ValidationResult<true> => {
  if (input.rail === "GHOSTWIRE") {
    if (input.targetKind !== "GHOSTWIRE_INTENT") {
      return {
        ok: false,
        status: 400,
        field: "targetKind",
        error: "GHOSTWIRE offerings must use targetKind GHOSTWIRE_INTENT in V1.",
      };
    }
    return { ok: true, value: true };
  }

  if (input.targetKind === "GHOSTWIRE_INTENT") {
    return {
      ok: false,
      status: 400,
      field: "targetKind",
      error: "Only GHOSTWIRE offerings can use targetKind GHOSTWIRE_INTENT.",
    };
  }

  if (input.targetKind === "SERVICE_SLUG" && input.targetRef !== input.serviceSlug) {
    return {
      ok: false,
      status: 409,
      field: "targetRef",
      error: `SERVICE_SLUG offerings must target the configured service slug "${input.serviceSlug}".`,
    };
  }

  return { ok: true, value: true };
};

export const parseAgentOfferingInput = (
  payload: unknown,
  options: { partial?: boolean } = {},
): ValidationResult<Partial<AgentOfferingMutationInput>> => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, status: 400, error: "Request body must be an object." };
  }

  const record = payload as Record<string, unknown>;
  const partial = options.partial === true;
  const output: Partial<AgentOfferingMutationInput> = {};

  const assignRequiredString = (
    key: "title" | "description" | "consumerCommand" | "targetRef",
    maxLength: number,
  ): ValidationResult<true> => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return partial ? { ok: true, value: true } : { ok: false, status: 400, field: key, error: `${key} is required.` };
    }
    const value = normalizeRequiredString(record[key], maxLength);
    if (!value) {
      return { ok: false, status: 400, field: key, error: `${key} is required.` };
    }
    output[key] = value;
    return { ok: true, value: true };
  };

  for (const result of [
    assignRequiredString("title", AGENT_OFFERING_TITLE_MAX_LENGTH),
    assignRequiredString("description", AGENT_OFFERING_DESCRIPTION_MAX_LENGTH),
    assignRequiredString("consumerCommand", AGENT_OFFERING_COMMAND_MAX_LENGTH),
    assignRequiredString("targetRef", AGENT_OFFERING_TARGET_REF_MAX_LENGTH),
  ]) {
    if (!result.ok) return result;
  }

  if (Object.prototype.hasOwnProperty.call(record, "rail")) {
    if (!isAgentOfferingRail(record.rail)) {
      return { ok: false, status: 400, field: "rail", error: "rail is invalid." };
    }
    output.rail = record.rail;
  } else if (!partial) {
    return { ok: false, status: 400, field: "rail", error: "rail is required." };
  }

  if (Object.prototype.hasOwnProperty.call(record, "targetKind")) {
    if (!isAgentOfferingTargetKind(record.targetKind)) {
      return { ok: false, status: 400, field: "targetKind", error: "targetKind is invalid." };
    }
    output.targetKind = record.targetKind;
  } else if (!partial) {
    return { ok: false, status: 400, field: "targetKind", error: "targetKind is required." };
  }

  if (Object.prototype.hasOwnProperty.call(record, "priceHint")) {
    const value = normalizeOptionalString(record.priceHint, AGENT_OFFERING_PRICE_HINT_MAX_LENGTH);
    if (record.priceHint != null && typeof record.priceHint !== "string") {
      return { ok: false, status: 400, field: "priceHint", error: "priceHint must be a string when provided." };
    }
    output.priceHint = value;
  } else if (!partial) {
    output.priceHint = null;
  }

  if (Object.prototype.hasOwnProperty.call(record, "etaHint")) {
    const value = normalizeOptionalString(record.etaHint, AGENT_OFFERING_ETA_HINT_MAX_LENGTH);
    if (record.etaHint != null && typeof record.etaHint !== "string") {
      return { ok: false, status: 400, field: "etaHint", error: "etaHint must be a string when provided." };
    }
    output.etaHint = value;
  } else if (!partial) {
    output.etaHint = null;
  }

  if (Object.prototype.hasOwnProperty.call(record, "isActive")) {
    if (typeof record.isActive !== "boolean") {
      return { ok: false, status: 400, field: "isActive", error: "isActive must be a boolean." };
    }
    output.isActive = record.isActive;
  } else if (!partial) {
    output.isActive = true;
  }

  if (partial && Object.keys(output).length === 0) {
    return { ok: false, status: 400, error: "No offering fields provided for update." };
  }

  return { ok: true, value: output };
};

export const validateOfferingReorder = (input: {
  existingIds: string[];
  orderedIds: string[];
}): ValidationResult<true> => {
  const existing = [...input.existingIds].sort();
  const provided = [...input.orderedIds].sort();

  if (new Set(input.orderedIds).size !== input.orderedIds.length) {
    return { ok: false, status: 400, error: "orderedIds must contain each offering exactly once." };
  }

  if (existing.length !== provided.length) {
    return { ok: false, status: 400, error: "orderedIds must contain the complete set of offering IDs for this agent." };
  }

  for (let index = 0; index < existing.length; index += 1) {
    if (existing[index] !== provided[index]) {
      return { ok: false, status: 400, error: "orderedIds must contain the complete set of offering IDs for this agent." };
    }
  }

  return { ok: true, value: true };
};

export const mapAgentOfferingRow = (row: AgentOfferingRecord): SerializedAgentOffering | Promise<SerializedAgentOffering> =>
  serializeAgentOffering(row);

export const toPrismaSortOrder = (sortOrder: number): number => {
  if (!Number.isInteger(sortOrder)) {
    throw new Error("sortOrder must be an integer.");
  }
  return sortOrder;
};

export const buildAgentOfferingOrderUpdates = (orderedIds: string[]) =>
  orderedIds.map((id, index) =>
    prisma.agentOffering.update({
      where: { id },
      data: { sortOrder: index },
    }),
  );

export const agentOfferingsAuth = {
  verifyMerchantGatewaySignedWrite,
};
