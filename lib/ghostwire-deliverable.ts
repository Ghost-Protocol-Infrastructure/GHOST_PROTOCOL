import { prisma } from "@/lib/db";

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeAddressLower = (value: string | null | undefined): string | null => {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.toLowerCase() : null;
};

export type GhostWireDeliverableMode = "merchant_locator" | "gateway_standard" | "ipfs_gateway" | "none";

export type GhostWireDeliverableSummary = {
  available: boolean;
  locatorUrl: string | null;
  mode: GhostWireDeliverableMode;
  state: "READY" | "PENDING" | "UNCONFIGURED";
};

type GhostWireDeliverableGatewayLookup = {
  findGatewayEndpointUrl: (input: {
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
    providerAddress?: string | null;
  }) => Promise<string | null>;
};

const defaultGatewayLookup: GhostWireDeliverableGatewayLookup = {
  findGatewayEndpointUrl: async (input) => {
    const providerAgentId = normalizeOptionalString(input.providerAgentId);
    const providerServiceSlug = normalizeOptionalString(input.providerServiceSlug);
    const providerAddress = normalizeAddressLower(input.providerAddress);

    if (providerAgentId) {
      const byAgent = await prisma.agentGatewayConfig.findUnique({
        where: { agentId: providerAgentId },
        select: { endpointUrl: true },
      });
      if (byAgent?.endpointUrl) {
        return byAgent.endpointUrl;
      }
    }

    if (providerServiceSlug) {
      const byServiceSlug = await prisma.agentGatewayConfig.findFirst({
        where: {
          serviceSlug: {
            equals: providerServiceSlug,
            mode: "insensitive",
          },
        },
        select: { endpointUrl: true },
      });
      if (byServiceSlug?.endpointUrl) {
        return byServiceSlug.endpointUrl;
      }
    }

    if (!providerAddress) {
      return null;
    }

    const byOwner = await prisma.agentGatewayConfig.findMany({
      where: {
        ownerAddress: {
          equals: providerAddress,
          mode: "insensitive",
        },
      },
      select: { endpointUrl: true },
      take: 2,
      orderBy: { agentId: "asc" },
    });

    return byOwner.length === 1 ? byOwner[0]!.endpointUrl : null;
  },
};

const normalizeHttpLocator = (value: string | null | undefined): string | null => {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeIpfsLocator = (value: string | null | undefined): string | null => {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !trimmed.toLowerCase().startsWith("ipfs://")) {
    return null;
  }

  const suffix = trimmed.slice("ipfs://".length).replace(/^ipfs\//i, "").replace(/^\/+/, "");
  if (!suffix) return null;

  return `https://ipfs.io/ipfs/${suffix}`;
};

const buildMerchantTargetUrl = (endpointUrl: string, path: string): string => {
  const base = new URL(`${endpointUrl.replace(/\/+$/, "")}/`);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  const target = path.trim();
  const targetUrl = new URL(target.startsWith("/") ? target : `/${target}`, "https://ghostwire.local");

  base.pathname = `${basePath}${targetUrl.pathname}`.replace(/\/{2,}/g, "/") || "/";
  base.search = targetUrl.search;
  base.hash = targetUrl.hash;
  return base.toString();
};

const buildStandardDeliverableLocator = (input: {
  endpointUrl: string;
  jobId: string;
  contractAddress: string | null | undefined;
  contractJobId: string | null | undefined;
}): string | null => {
  const contractAddress = normalizeOptionalString(input.contractAddress);
  const contractJobId = normalizeOptionalString(input.contractJobId);
  if (!contractAddress || !contractJobId) {
    return null;
  }

  const locatorUrl = new URL(buildMerchantTargetUrl(input.endpointUrl, "/wire/deliverable"));
  locatorUrl.searchParams.set("contract", contractAddress);
  locatorUrl.searchParams.set("job", contractJobId);
  locatorUrl.searchParams.set("jobId", input.jobId);
  return locatorUrl.toString();
};

const resolveRelativeMerchantLocator = (endpointUrl: string, metadataUri: string): string | null => {
  const trimmed = normalizeOptionalString(metadataUri);
  if (!trimmed || !trimmed.startsWith("/")) {
    return null;
  }
  return buildMerchantTargetUrl(endpointUrl, trimmed);
};

export const resolveGhostWireDeliverableLocatorWithLookup = async (
  lookup: GhostWireDeliverableGatewayLookup,
  input: {
    jobId: string;
    metadataUri: string | null | undefined;
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
    providerAddress?: string | null;
    contractAddress?: string | null;
    contractJobId?: string | null;
  },
): Promise<{
  locatorUrl: string | null;
  mode: GhostWireDeliverableMode;
}> => {
  const explicitHttpLocator = normalizeHttpLocator(input.metadataUri);
  if (explicitHttpLocator) {
    return {
      locatorUrl: explicitHttpLocator,
      mode: "merchant_locator",
    };
  }

  const explicitIpfsLocator = normalizeIpfsLocator(input.metadataUri);
  if (explicitIpfsLocator) {
    return {
      locatorUrl: explicitIpfsLocator,
      mode: "ipfs_gateway",
    };
  }

  const gatewayEndpointUrl = await lookup.findGatewayEndpointUrl({
    providerAgentId: input.providerAgentId,
    providerServiceSlug: input.providerServiceSlug,
    providerAddress: input.providerAddress,
  });
  if (!gatewayEndpointUrl) {
    return {
      locatorUrl: null,
      mode: "none",
    };
  }

  const relativeMerchantLocator =
    input.metadataUri != null ? resolveRelativeMerchantLocator(gatewayEndpointUrl, input.metadataUri) : null;
  if (relativeMerchantLocator) {
    return {
      locatorUrl: relativeMerchantLocator,
      mode: "merchant_locator",
    };
  }

  const standardLocator = buildStandardDeliverableLocator({
    endpointUrl: gatewayEndpointUrl,
    jobId: input.jobId,
    contractAddress: input.contractAddress,
    contractJobId: input.contractJobId,
  });

  return {
    locatorUrl: standardLocator,
    mode: standardLocator ? "gateway_standard" : "none",
  };
};

export const buildGhostWireDeliverableSummaryWithLookup = async (
  lookup: GhostWireDeliverableGatewayLookup,
  input: {
    jobId: string;
    metadataUri: string | null | undefined;
    contractState: string;
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
    providerAddress?: string | null;
    contractAddress?: string | null;
    contractJobId?: string | null;
  },
): Promise<GhostWireDeliverableSummary> => {
  const resolved = await resolveGhostWireDeliverableLocatorWithLookup(lookup, input);
  const completed = input.contractState === "COMPLETED";

  return {
    available: Boolean(resolved.locatorUrl && completed),
    locatorUrl: resolved.locatorUrl,
    mode: resolved.mode,
    state: completed && resolved.locatorUrl ? "READY" : resolved.locatorUrl ? "PENDING" : "UNCONFIGURED",
  };
};

export const buildGhostWireDeliverableSummary = async (input: {
  jobId: string;
  metadataUri: string | null | undefined;
  contractState: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  providerAddress?: string | null;
  contractAddress?: string | null;
  contractJobId?: string | null;
}): Promise<GhostWireDeliverableSummary> =>
  buildGhostWireDeliverableSummaryWithLookup(defaultGatewayLookup, input);
