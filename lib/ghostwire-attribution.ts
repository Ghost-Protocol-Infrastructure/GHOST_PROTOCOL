import { prisma } from "@/lib/db";

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeAddressLower = (value: string): string => value.trim().toLowerCase();

const deriveAgentIdFromServiceSlug = (serviceSlug: string | null): string | null => {
  if (!serviceSlug) return null;
  const match = /^agent-(.+)$/i.exec(serviceSlug);
  return match ? match[1] : null;
};

export class GhostWireProviderAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhostWireProviderAttributionError";
  }
}

type AgentIdentity = {
  agentId: string;
  owner: string;
};

type GatewayIdentity = {
  agentId: string;
  ownerAddress: string;
  serviceSlug: string;
};

export type GhostWireProviderAttribution = {
  providerAgentId: string | null;
  providerServiceSlug: string | null;
  source: "explicit_agent" | "explicit_service_slug" | "owner_wallet" | "none";
};

type ProviderAttributionLookup = {
  findAgentByAgentId: (agentId: string) => Promise<AgentIdentity | null>;
  findAgentsByOwnerAddress: (ownerAddress: string) => Promise<AgentIdentity[]>;
  findGatewayConfigsByOwnerAddress: (ownerAddress: string) => Promise<GatewayIdentity[]>;
  findGatewayConfigsByServiceSlug: (serviceSlug: string) => Promise<GatewayIdentity[]>;
};

const defaultLookup: ProviderAttributionLookup = {
  findAgentByAgentId: async (agentId) =>
    prisma.agent.findUnique({
      where: { agentId },
      select: { agentId: true, owner: true },
    }),
  findAgentsByOwnerAddress: async (ownerAddress) =>
    prisma.agent.findMany({
      where: {
        owner: {
          equals: ownerAddress,
          mode: "insensitive",
        },
      },
      select: { agentId: true, owner: true },
      orderBy: { agentId: "asc" },
      take: 2,
    }),
  findGatewayConfigsByOwnerAddress: async (ownerAddress) =>
    prisma.agentGatewayConfig.findMany({
      where: {
        ownerAddress: {
          equals: ownerAddress,
          mode: "insensitive",
        },
      },
      select: { agentId: true, ownerAddress: true, serviceSlug: true },
      orderBy: { agentId: "asc" },
      take: 2,
    }),
  findGatewayConfigsByServiceSlug: async (serviceSlug) =>
    prisma.agentGatewayConfig.findMany({
      where: {
        serviceSlug: {
          equals: serviceSlug,
          mode: "insensitive",
        },
      },
      select: { agentId: true, ownerAddress: true, serviceSlug: true },
      orderBy: { agentId: "asc" },
      take: 2,
    }),
};

const ensureProviderOwnsAgent = (providerAddress: string, ownerAddress: string, message: string): void => {
  if (normalizeAddressLower(providerAddress) !== normalizeAddressLower(ownerAddress)) {
    throw new GhostWireProviderAttributionError(message);
  }
};

export const resolveGhostWireProviderAttributionWithLookup = async (
  lookup: ProviderAttributionLookup,
  input: {
    providerAddress: string;
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
  },
): Promise<GhostWireProviderAttribution> => {
  const providerAddress = normalizeAddressLower(input.providerAddress);
  const explicitAgentId = normalizeOptionalString(input.providerAgentId);
  const explicitServiceSlug = normalizeOptionalString(input.providerServiceSlug);
  const derivedAgentIdFromSlug = deriveAgentIdFromServiceSlug(explicitServiceSlug);

  if (explicitAgentId && derivedAgentIdFromSlug && derivedAgentIdFromSlug !== explicitAgentId) {
    throw new GhostWireProviderAttributionError("providerServiceSlug does not match providerAgentId.");
  }

  if (explicitAgentId) {
    const agent = await lookup.findAgentByAgentId(explicitAgentId);
    if (!agent) {
      throw new GhostWireProviderAttributionError("providerAgentId does not match a known agent.");
    }
    ensureProviderOwnsAgent(
      providerAddress,
      agent.owner,
      "providerAgentId does not belong to the supplied provider wallet.",
    );

    return {
      providerAgentId: agent.agentId,
      providerServiceSlug: explicitServiceSlug ?? `agent-${agent.agentId}`,
      source: "explicit_agent",
    };
  }

  if (explicitServiceSlug) {
    if (derivedAgentIdFromSlug) {
      const agent = await lookup.findAgentByAgentId(derivedAgentIdFromSlug);
      if (agent) {
        ensureProviderOwnsAgent(
          providerAddress,
          agent.owner,
          "providerServiceSlug does not belong to the supplied provider wallet.",
        );
        return {
          providerAgentId: agent.agentId,
          providerServiceSlug: explicitServiceSlug,
          source: "explicit_service_slug",
        };
      }
    }

    const gatewayConfigs = await lookup.findGatewayConfigsByServiceSlug(explicitServiceSlug);
    const matchingConfigs = gatewayConfigs.filter(
      (config) => normalizeAddressLower(config.ownerAddress) === providerAddress,
    );
    if (matchingConfigs.length === 1) {
      return {
        providerAgentId: matchingConfigs[0]!.agentId,
        providerServiceSlug: matchingConfigs[0]!.serviceSlug,
        source: "explicit_service_slug",
      };
    }
    if (matchingConfigs.length > 1) {
      return {
        providerAgentId: null,
        providerServiceSlug: null,
        source: "none",
      };
    }

    throw new GhostWireProviderAttributionError("providerServiceSlug does not belong to the supplied provider wallet.");
  }

  const ownerMatchedAgents = await lookup.findAgentsByOwnerAddress(providerAddress);
  if (ownerMatchedAgents.length === 1) {
    return {
      providerAgentId: ownerMatchedAgents[0]!.agentId,
      providerServiceSlug: `agent-${ownerMatchedAgents[0]!.agentId}`,
      source: "owner_wallet",
    };
  }
  if (ownerMatchedAgents.length > 1) {
    return {
      providerAgentId: null,
      providerServiceSlug: null,
      source: "none",
    };
  }

  const ownerMatchedConfigs = await lookup.findGatewayConfigsByOwnerAddress(providerAddress);
  if (ownerMatchedConfigs.length === 1) {
    return {
      providerAgentId: ownerMatchedConfigs[0]!.agentId,
      providerServiceSlug: ownerMatchedConfigs[0]!.serviceSlug,
      source: "owner_wallet",
    };
  }

  return {
    providerAgentId: null,
    providerServiceSlug: null,
    source: "none",
  };
};

export const resolveGhostWireProviderAttribution = async (input: {
  providerAddress: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
}): Promise<GhostWireProviderAttribution> =>
  resolveGhostWireProviderAttributionWithLookup(defaultLookup, input);
