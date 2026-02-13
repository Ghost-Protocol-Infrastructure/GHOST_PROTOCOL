export interface GhostAgent {
  rank: number;
  agentAddress: string;
  reputationScore: number;
  totalEarningsEth: string;
  uptimePct: number;
}

export interface GhostData {
  updatedAt: string;
  rpcUrl: string;
  chainId: number;
  serviceRegistry: {
    address: string;
  };
  topAgents: GhostAgent[];
}
