export const AGENT_OFFERING_RAILS = ["X402", "EXPRESS", "GHOSTWIRE"] as const;
export type AgentOfferingRailValue = (typeof AGENT_OFFERING_RAILS)[number];

export const AGENT_OFFERING_TARGET_KINDS = ["SERVICE_SLUG", "MCP_TOOL", "GHOSTWIRE_INTENT"] as const;
export type AgentOfferingTargetKindValue = (typeof AGENT_OFFERING_TARGET_KINDS)[number];

export type CanonicalOfferingPrice = {
  credits: string;
  estimatedEthWei: string;
  creditsLabel: string;
  estimatedEthLabel: string;
  primaryDisplay: string;
  source: "service_pricing";
};

export type SerializedAgentOffering = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  consumerCommand: string;
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  targetLabel: string;
  targetDescription: string;
  priceHint: string | null;
  etaHint: string | null;
  isActive: boolean;
  sortOrder: number;
  canonicalPricing: CanonicalOfferingPrice | null;
  createdAt: string;
  updatedAt: string;
};

export const isAgentOfferingRail = (value: unknown): value is AgentOfferingRailValue =>
  typeof value === "string" && (AGENT_OFFERING_RAILS as readonly string[]).includes(value);

export const isAgentOfferingTargetKind = (value: unknown): value is AgentOfferingTargetKindValue =>
  typeof value === "string" && (AGENT_OFFERING_TARGET_KINDS as readonly string[]).includes(value);

export const describeAgentOfferingTarget = (targetKind: AgentOfferingTargetKindValue, targetRef: string) => {
  switch (targetKind) {
    case "SERVICE_SLUG":
      return {
        label: "Service Target",
        description: targetRef,
      };
    case "MCP_TOOL":
      return {
        label: "MCP Tool",
        description: targetRef,
      };
    case "GHOSTWIRE_INTENT":
      return {
        label: "GhostWire Quote Intent",
        description: `${targetRef} // informational only in V1`,
      };
    default:
      return {
        label: "Target",
        description: targetRef,
      };
  }
};
