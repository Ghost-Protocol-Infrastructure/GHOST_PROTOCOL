"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Code, Copy, Wallet } from "lucide-react";
import {
  useAccount,
  useReadContract,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatEther, getAddress, parseEther, type Address } from "viem";
import { base } from "viem/chains";
import {
  GHOST_VAULT_ABI,
  GHOST_VAULT_ADDRESS,
  PROTOCOL_TREASURY_FALLBACK_ADDRESS,
} from "@/lib/constants";
import { isClaimedAgent } from "@/lib/agent-claim";
import {
  buildMerchantGatewayAuthMessage,
  createMerchantGatewayAuthPayload,
} from "@/lib/agent-gateway-auth";
import TerminalHeader from "@/components/TerminalHeader";

const CREDIT_PRICE_WEI = parseEther("0.00001");
const SUPPORTED_CHAIN_IDS = new Set<number>([base.id]);
const PREFERRED_CHAIN_ID = base.id;

type CopyState = "idle" | "copied" | "error";
type CreditSyncState = "idle" | "syncing" | "synced" | "error";
type ConsumerSdk = "node" | "python";
type GatewayReadinessStatus = "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";

type AgentApiRow = {
  address: string;
  agentId?: string;
  creator: string;
  owner?: string;
  name: string;
  status: string;
  tier?: string;
  yield?: number;
  uptime?: number;
  gatewayReadinessStatus?: GatewayReadinessStatus;
  gatewayLastCanaryCheckedAt?: string | null;
  gatewayLastCanaryPassedAt?: string | null;
};

type AgentApiResponse = {
  agents: AgentApiRow[];
};

type OwnedAgent = {
  agentId: string;
  address: string;
  owner: string;
  name: string;
  status: string;
  tier?: string;
  isClaimed: boolean;
  gatewayReadinessStatus: GatewayReadinessStatus;
  gatewayLastCanaryCheckedAt?: string | null;
  gatewayLastCanaryPassedAt?: string | null;
};

type AgentGatewayConfigRecord = {
  agentId: string;
  ownerAddress: string;
  serviceSlug: string;
  endpointUrl: string | null;
  canaryPath: string | null;
  canaryMethod: "GET" | null;
  readinessStatus: GatewayReadinessStatus;
  lastCanaryCheckedAt: string | null;
  lastCanaryPassedAt: string | null;
  lastCanaryStatusCode: number | null;
  lastCanaryLatencyMs: number | null;
  lastCanaryError: string | null;
};

type AgentGatewayConfigResponse = {
  configured: boolean;
  config: AgentGatewayConfigRecord;
};

const isHexAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);
const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");
const APP_BASE_URL = normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL?.trim() || "https://ghostprotocol.cc");
const GITHUB_DOCS_BASE_URL = "https://github.com/Ghost-Protocol-Infrastructure/GHOST_PROTOCOL/blob/main/docs/developer-portal";
const NODE_QUICKSTART_DOC_URL = `${GITHUB_DOCS_BASE_URL}/quickstart-node.md`;
const SDK_REFERENCE_DOC_URL = `${GITHUB_DOCS_BASE_URL}/sdk-reference.md`;
const SDK_CONTEXT_KEY_PREVIEW_PLACEHOLDER = "sk_live_your_sdk_context_key";
const SDK_SECURITY_NOTICE =
  "Security Notice: Ghost Protocol gate access is authenticated with Web3 wallet signatures (EIP-712). Configure SDKs with a signer private key in a trusted backend/server/CLI environment only. Never expose private keys in frontend code or commit them to version control.";

const DEFAULT_CANARY_PATH = "/ghostgate/canary";

const isGatewayReadinessStatus = (value: unknown): value is GatewayReadinessStatus =>
  value === "UNCONFIGURED" || value === "CONFIGURED" || value === "LIVE" || value === "DEGRADED";

const normalizeGatewayReadinessStatus = (value: unknown): GatewayReadinessStatus =>
  isGatewayReadinessStatus(value) ? value : "UNCONFIGURED";

const isGatewayLive = (status: GatewayReadinessStatus | null | undefined): boolean => status === "LIVE";

const formatGatewayReadinessLabel = (status: GatewayReadinessStatus): string => {
  switch (status) {
    case "UNCONFIGURED":
      return "UNCONFIGURED";
    case "CONFIGURED":
      return "CONFIGURED // VERIFY REQUIRED";
    case "LIVE":
      return "SERVICE LIVE";
    case "DEGRADED":
      return "DEGRADED";
    default:
      return "UNCONFIGURED";
  }
};

const getGatewayReadinessTone = (status: GatewayReadinessStatus): { dot: string; text: string; border: string; bg: string } => {
  switch (status) {
    case "LIVE":
      return {
        dot: "bg-emerald-400",
        text: "text-emerald-300",
        border: "border-emerald-900/40",
        bg: "bg-emerald-950/10",
      };
    case "CONFIGURED":
      return {
        dot: "bg-amber-400",
        text: "text-amber-300",
        border: "border-amber-900/40",
        bg: "bg-amber-950/10",
      };
    case "DEGRADED":
      return {
        dot: "bg-rose-400",
        text: "text-rose-300",
        border: "border-rose-900/40",
        bg: "bg-rose-950/10",
      };
    case "UNCONFIGURED":
    default:
      return {
        dot: "bg-neutral-500",
        text: "text-neutral-400",
        border: "border-neutral-800",
        bg: "bg-neutral-900",
      };
  }
};

function SdkSecurityNoticeBanner() {
  return (
    <div className="border border-amber-800/40 bg-amber-950/10 p-4">
      <p className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-amber-300 font-bold">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{SDK_SECURITY_NOTICE}</span>
      </p>
    </div>
  );
}

function SdkDocsLinks() {
  return (
    <div className="mt-5 space-y-3">
      <p className="text-sm text-neutral-500">
        Use the docs for installation steps and required environment variables (including signer key setup).
      </p>
      <div className="flex flex-wrap gap-3">
        <a
          href={NODE_QUICKSTART_DOC_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
        >
          OPEN NODE QUICKSTART
        </a>
        <a
          href={SDK_REFERENCE_DOC_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
        >
          OPEN SDK REFERENCE
        </a>
      </div>
    </div>
  );
}

const deriveAgentId = (agent: Pick<AgentApiRow, "address" | "name">): string => {
  const fromAddress = agent.address.match(/(?:service|agent)[:_-](\d+)/i)?.[1];
  if (fromAddress) return fromAddress;

  const fromName = agent.name.match(/(?:agent|service)\s*#?\s*(\d+)/i)?.[1];
  if (fromName) return fromName;

  if (isHexAddress(agent.address)) return agent.address.slice(2, 8).toUpperCase();
  return agent.name.trim().slice(0, 12).toUpperCase() || "UNKNOWN";
};

const normalizeAddress = (rawAddress: string | null | undefined): Address | null => {
  if (!rawAddress) return null;
  try {
    return getAddress(rawAddress);
  } catch {
    return null;
  }
};

const parseInputWei = (value: string): bigint | null => {
  if (!value.trim()) return 0n;

  try {
    return parseEther(value);
  } catch {
    return null;
  }
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof shortMessage === "string" && shortMessage.length > 0) {
      return shortMessage;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
};

type SyncCreditsResponse = {
  userAddress: string;
  credits: string;
};

function DashboardPageContent() {
  const searchParams = useSearchParams();
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const {
    data: depositTxHash,
    error: depositWriteError,
    isPending: isDepositWriting,
    writeContract: writeDepositContract,
  } = useWriteContract();
  const { isLoading: isDepositConfirming, isSuccess: isDepositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });
  const {
    data: withdrawTxHash,
    error: withdrawWriteError,
    isPending: isWithdrawWriting,
    writeContract: writeWithdrawContract,
  } = useWriteContract();
  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });

  const [ethAmount, setEthAmount] = useState("0.0001");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [apiKeyCopyState, setApiKeyCopyState] = useState<CopyState>("idle");
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [creditSyncState, setCreditSyncState] = useState<CreditSyncState>("idle");
  const [creditSyncError, setCreditSyncError] = useState<string | null>(null);
  const [consumerSdk, setConsumerSdk] = useState<ConsumerSdk>("node");
  const [syncedCredits, setSyncedCredits] = useState<string | null>(null);
  const [ownedAgents, setOwnedAgents] = useState<OwnedAgent[]>([]);
  const [isLoadingOwnedAgents, setIsLoadingOwnedAgents] = useState(false);
  const [ownedAgentsError, setOwnedAgentsError] = useState<string | null>(null);
  const [lastWithdrawAgentId, setLastWithdrawAgentId] = useState<string | null>(null);
  const [merchantGatewayConfig, setMerchantGatewayConfig] = useState<AgentGatewayConfigRecord | null>(null);
  const [merchantGatewayEndpointUrl, setMerchantGatewayEndpointUrl] = useState("");
  const [merchantGatewayCanaryPath, setMerchantGatewayCanaryPath] = useState(DEFAULT_CANARY_PATH);
  const [isLoadingMerchantGatewayConfig, setIsLoadingMerchantGatewayConfig] = useState(false);
  const [isSavingMerchantGatewayConfig, setIsSavingMerchantGatewayConfig] = useState(false);
  const [isVerifyingMerchantGateway, setIsVerifyingMerchantGateway] = useState(false);
  const [merchantGatewayError, setMerchantGatewayError] = useState<string | null>(null);
  const [merchantGatewayNotice, setMerchantGatewayNotice] = useState<string | null>(null);
  const [consumerGatewayReadinessStatus, setConsumerGatewayReadinessStatus] = useState<GatewayReadinessStatus | null>(null);
  const [consumerGatewayReadinessError, setConsumerGatewayReadinessError] = useState<string | null>(null);
  const [isLoadingConsumerGatewayReadiness, setIsLoadingConsumerGatewayReadiness] = useState(false);
  const syncedHashesRef = useRef<Set<string>>(new Set());

  const amountWei = useMemo(() => parseInputWei(ethAmount), [ethAmount]);
  const estimatedCredits = useMemo(() => {
    if (amountWei == null) return null;
    return amountWei / CREDIT_PRICE_WEI;
  }, [amountWei]);

  const requestedAgentId = searchParams.get("agentId");
  const requestedOwner = searchParams.get("owner");
  const normalizedRequestedAgentId = useMemo(() => {
    const candidate = requestedAgentId?.trim();
    return candidate && candidate.length > 0 ? candidate : null;
  }, [requestedAgentId]);
  const consumerServiceSlug = normalizedRequestedAgentId
    ? `agent-${normalizedRequestedAgentId}`
    : "agent-your-agent-id";
  const requestedAgentAddress = useMemo(
    () => normalizeAddress(requestedOwner),
    [requestedOwner],
  );
  const targetAgentAddress = requestedAgentAddress ?? PROTOCOL_TREASURY_FALLBACK_ADDRESS;
  const usesFallbackAgentAddress = requestedAgentAddress == null;

  const isOnSupportedChain = chainId != null && SUPPORTED_CHAIN_IDS.has(chainId);
  const readChainId = isOnSupportedChain ? chainId : PREFERRED_CHAIN_ID;

  const {
    data: agentVaultBalance,
    error: readError,
    isPending: isBalancePending,
    refetch: refetchBalance,
  } = useReadContract({
    address: GHOST_VAULT_ADDRESS,
    chainId: readChainId,
    abi: GHOST_VAULT_ABI,
    functionName: "balances",
    args: [targetAgentAddress],
    query: {
      enabled: isOnSupportedChain,
    },
  });

  const readCreditsFromLedger = useCallback(async (userAddress: Address): Promise<string> => {
    const params = new URLSearchParams({ userAddress });
    const response = await fetch(`/api/sync-credits?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });

    const payload = (await response.json()) as Partial<SyncCreditsResponse> & {
      error?: string;
      details?: string;
    };

    if (!response.ok) {
      const message =
        typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : "Failed to sync credits.";
      throw new Error(message);
    }

    return typeof payload.credits === "string" ? payload.credits : "0";
  }, []);

  const fetchAgentGatewayConfig = useCallback(async (agentId: string): Promise<AgentGatewayConfigRecord> => {
    const params = new URLSearchParams({ agentId });
    const response = await fetch(`/api/agent-gateway/config?${params.toString()}`, {
      cache: "no-store",
      headers: {
        "cache-control": "no-cache",
      },
    });

    const payload = (await response.json()) as Partial<AgentGatewayConfigResponse> & { error?: string };
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load gateway config.");
    }

    const config = payload.config;
    if (!config || typeof config !== "object") {
      throw new Error("Gateway config response was missing config payload.");
    }

    return {
      agentId: String(config.agentId ?? agentId),
      ownerAddress: String(config.ownerAddress ?? ""),
      serviceSlug: String(config.serviceSlug ?? `agent-${agentId}`),
      endpointUrl: typeof config.endpointUrl === "string" ? config.endpointUrl : null,
      canaryPath: typeof config.canaryPath === "string" ? config.canaryPath : DEFAULT_CANARY_PATH,
      canaryMethod: config.canaryMethod === "GET" ? "GET" : "GET",
      readinessStatus: normalizeGatewayReadinessStatus(config.readinessStatus),
      lastCanaryCheckedAt:
        typeof config.lastCanaryCheckedAt === "string" || config.lastCanaryCheckedAt === null
          ? (config.lastCanaryCheckedAt ?? null)
          : null,
      lastCanaryPassedAt:
        typeof config.lastCanaryPassedAt === "string" || config.lastCanaryPassedAt === null
          ? (config.lastCanaryPassedAt ?? null)
          : null,
      lastCanaryStatusCode:
        typeof config.lastCanaryStatusCode === "number" ? config.lastCanaryStatusCode : null,
      lastCanaryLatencyMs:
        typeof config.lastCanaryLatencyMs === "number" ? config.lastCanaryLatencyMs : null,
      lastCanaryError: typeof config.lastCanaryError === "string" ? config.lastCanaryError : null,
    };
  }, []);

  const syncCreditsFromChain = useCallback(async (userAddress: Address, hash: string): Promise<void> => {
    setCreditSyncState("syncing");
    setCreditSyncError(null);

    try {
      const credits = await readCreditsFromLedger(userAddress);
      setSyncedCredits(credits);
      setCreditSyncState("synced");
    } catch (error) {
      syncedHashesRef.current.delete(hash);
      setCreditSyncState("error");
      setCreditSyncError(getErrorMessage(error, "Failed to sync credits."));
    }
  }, [readCreditsFromLedger]);

  const handleRetryCreditSync = async () => {
    if (!address || !depositTxHash || !isDepositConfirmed) return;
    await syncCreditsFromChain(address, depositTxHash);
  };

  useEffect(() => {
    if (!depositTxHash) {
      setCreditSyncState("idle");
      setCreditSyncError(null);
      setSyncedCredits(null);
      return;
    }

    setCreditSyncState("idle");
    setCreditSyncError(null);
  }, [depositTxHash]);

  useEffect(() => {
    if (!address) {
      setSyncedCredits(null);
      return;
    }

    const hydrateCredits = async () => {
      try {
        const credits = await readCreditsFromLedger(address);
        setSyncedCredits(credits);
      } catch {
        // Keep current value; tx-driven sync surface handles user-facing errors.
      }
    };

    void hydrateCredits();
  }, [address, readCreditsFromLedger]);

  useEffect(() => {
    if (!isDepositConfirmed || !address || !depositTxHash) return;
    if (syncedHashesRef.current.has(depositTxHash)) return;
    syncedHashesRef.current.add(depositTxHash);

    void refetchBalance();
    void syncCreditsFromChain(address, depositTxHash);
  }, [address, isDepositConfirmed, refetchBalance, syncCreditsFromChain, depositTxHash]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = setTimeout(() => setCopyState("idle"), 1600);
    return () => clearTimeout(timeout);
  }, [copyState]);

  useEffect(() => {
    if (apiKeyCopyState !== "copied") return;
    const timeout = setTimeout(() => setApiKeyCopyState("idle"), 1600);
    return () => clearTimeout(timeout);
  }, [apiKeyCopyState]);

  const nodeConsumerUsageExample = useMemo(
    () =>
      `import { GhostAgent } from "@ghost/sdk";

const sdk = new GhostAgent({
  baseUrl: "${APP_BASE_URL}",
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as \`0x\${string}\`,
  serviceSlug: "${consumerServiceSlug}",
  creditCost: 1,
});

const result = await sdk.connect(process.env.GHOST_API_KEY!);
console.log(result);`,
    [consumerServiceSlug],
  );

  const pythonConsumerUsageExample = useMemo(
    () =>
      `import json
import os
import time
import uuid

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data

# Trusted CLI/server environment only.
# Never expose this private key in frontend code.
private_key = os.environ["GHOST_SIGNER_PRIVATE_KEY"]
base_url = os.getenv("GHOST_GATE_BASE_URL", "${APP_BASE_URL}").rstrip("/")
service = "${consumerServiceSlug}"  # replace dynamically
credit_cost = 1
chain_id = 8453  # Base

payload = {
    "service": service,
    "timestamp": int(time.time()),
    "nonce": uuid.uuid4().hex,
}

typed_data = {
    "types": {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
        ],
        "Access": [
            {"name": "service", "type": "string"},
            {"name": "timestamp", "type": "uint256"},
            {"name": "nonce", "type": "string"},
        ],
    },
    "domain": {
        "name": "GhostGate",
        "version": "1",
        "chainId": chain_id,
    },
    "primaryType": "Access",
    "message": payload,
}

signable = encode_typed_data(full_message=typed_data)
signed = Account.sign_message(signable, private_key=private_key)

url = f"{base_url}/api/gate/{service}"
headers = {
    "x-ghost-sig": signed.signature.hex(),
    "x-ghost-payload": json.dumps(payload),
    "x-ghost-credit-cost": str(credit_cost),
    "accept": "application/json, text/plain;q=0.9, */*;q=0.8",
}

response = requests.post(url, headers=headers, timeout=10)
print("status:", response.status_code)
print("body:", response.text)`,
    [consumerServiceSlug],
  );

  const consumerUsageExample =
    consumerSdk === "node" ? nodeConsumerUsageExample : pythonConsumerUsageExample;

  useEffect(() => {
    if (!address) {
      setOwnedAgents([]);
      setOwnedAgentsError(null);
      setIsLoadingOwnedAgents(false);
      return;
    }

    let isActive = true;

    const loadOwnedAgents = async () => {
      setIsLoadingOwnedAgents(true);
      setOwnedAgentsError(null);

      try {
        const params = new URLSearchParams({
          owner: address,
          limit: "1000",
        });
        const response = await fetch(`/api/agents?${params.toString()}`, {
          cache: "no-store",
          headers: {
            "cache-control": "no-cache",
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to load owned agents (${response.status}).`);
        }

        const payload = (await response.json()) as AgentApiResponse;
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        const normalizedAgents: OwnedAgent[] = agents.map((agent) => {
          const ownerSource = agent.owner ?? agent.creator;
          const owner = isHexAddress(ownerSource) ? ownerSource.toLowerCase() : ownerSource;
          return {
            agentId: agent.agentId?.trim() || deriveAgentId(agent),
            address: agent.address,
            owner,
            name: agent.name,
            status: agent.status,
            tier: agent.tier,
            gatewayReadinessStatus: normalizeGatewayReadinessStatus(agent.gatewayReadinessStatus),
            gatewayLastCanaryCheckedAt:
              typeof agent.gatewayLastCanaryCheckedAt === "string" ? agent.gatewayLastCanaryCheckedAt : null,
            gatewayLastCanaryPassedAt:
              typeof agent.gatewayLastCanaryPassedAt === "string" ? agent.gatewayLastCanaryPassedAt : null,
            isClaimed: isClaimedAgent({
              status: agent.status,
              tier: agent.tier,
              yieldValue: agent.yield,
              uptimeValue: agent.uptime,
            }),
          };
        });

        if (!isActive) return;
        setOwnedAgents(normalizedAgents);
      } catch (error) {
        if (!isActive) return;
        setOwnedAgents([]);
        setOwnedAgentsError(getErrorMessage(error, "Failed to load merchant agents."));
      } finally {
        if (isActive) setIsLoadingOwnedAgents(false);
      }
    };

    void loadOwnedAgents();

    return () => {
      isActive = false;
    };
  }, [address]);

  const selectedOwnedAgent = useMemo(() => {
    if (!ownedAgents.length) return null;
    return ownedAgents.find((agent) => agent.agentId === selectedAgentId) ?? ownedAgents[0];
  }, [ownedAgents, selectedAgentId]);

  const requestedMode = searchParams.get("mode");
  const forceConsumerView = requestedMode === "consumer";
  const forceMerchantView = requestedMode === "merchant";
  const requestedAgentIsOwned = useMemo(() => {
    if (!normalizedRequestedAgentId) return false;
    return ownedAgents.some((agent) => agent.agentId === normalizedRequestedAgentId);
  }, [normalizedRequestedAgentId, ownedAgents]);
  const showMerchantView = useMemo(() => {
    if (forceConsumerView) return false;
    if (forceMerchantView) return ownedAgents.length > 0;
    if (normalizedRequestedAgentId) return requestedAgentIsOwned;
    return ownedAgents.length > 0;
  }, [
    forceConsumerView,
    forceMerchantView,
    normalizedRequestedAgentId,
    ownedAgents.length,
    requestedAgentIsOwned,
  ]);

  useEffect(() => {
    if (!ownedAgents.length) {
      setSelectedAgentId("");
      return;
    }

    const selectedIsOwned = ownedAgents.some((agent) => agent.agentId === selectedAgentId);

    // Only use URL agentId for initial/default selection.
    if (!selectedAgentId) {
      if (requestedAgentIsOwned && normalizedRequestedAgentId != null) {
        setSelectedAgentId(normalizedRequestedAgentId);
        return;
      }

      setSelectedAgentId(ownedAgents[0].agentId);
      return;
    }

    if (!selectedIsOwned) {
      setSelectedAgentId(ownedAgents[0].agentId);
    }
  }, [ownedAgents, normalizedRequestedAgentId, requestedAgentIsOwned, selectedAgentId]);

  const selectedOwnedAgentAddress = useMemo(
    () => normalizeAddress(selectedOwnedAgent?.owner ?? null),
    [selectedOwnedAgent],
  );

  const {
    data: merchantVaultBalance,
    error: merchantReadError,
    isPending: isMerchantBalancePending,
    refetch: refetchMerchantVaultBalance,
  } = useReadContract({
    address: GHOST_VAULT_ADDRESS,
    chainId: readChainId,
    abi: GHOST_VAULT_ABI,
    functionName: "balances",
    args: [selectedOwnedAgentAddress ?? PROTOCOL_TREASURY_FALLBACK_ADDRESS],
    query: {
      enabled: isOnSupportedChain && Boolean(selectedOwnedAgentAddress),
    },
  });

  const merchantApiKey = SDK_CONTEXT_KEY_PREVIEW_PLACEHOLDER;

  const selectedAgentProfileHref = selectedOwnedAgent
    ? `/agent/${encodeURIComponent(selectedOwnedAgent.agentId)}`
    : "/rank";
  const selectedAgentConsumerTerminalHref = selectedOwnedAgent
    ? `/dashboard?mode=consumer&agentId=${encodeURIComponent(selectedOwnedAgent.agentId)}&owner=${encodeURIComponent(selectedOwnedAgent.owner)}`
    : "/dashboard?mode=consumer";
  const merchantServiceSlug = selectedOwnedAgent ? `agent-${selectedOwnedAgent.agentId}` : "agent-your-agent-id";
  const patchOwnedAgentGatewayReadiness = useCallback(
    (
      agentId: string,
      readinessStatus: GatewayReadinessStatus,
      lastCanaryCheckedAt: string | null,
      lastCanaryPassedAt: string | null,
    ) => {
      setOwnedAgents((current) =>
        current.map((agent) =>
          agent.agentId === agentId
            ? {
                ...agent,
                gatewayReadinessStatus: readinessStatus,
                gatewayLastCanaryCheckedAt: lastCanaryCheckedAt ?? null,
                gatewayLastCanaryPassedAt: lastCanaryPassedAt ?? null,
              }
            : agent,
        ),
      );
    },
    [],
  );

  useEffect(() => {
    if (!showMerchantView || !selectedOwnedAgent) {
      setMerchantGatewayConfig(null);
      setMerchantGatewayEndpointUrl("");
      setMerchantGatewayCanaryPath(DEFAULT_CANARY_PATH);
      setMerchantGatewayError(null);
      setMerchantGatewayNotice(null);
      setIsLoadingMerchantGatewayConfig(false);
      return;
    }

    let active = true;

    const loadMerchantGatewayConfig = async () => {
      setIsLoadingMerchantGatewayConfig(true);
      setMerchantGatewayError(null);
      try {
        const config = await fetchAgentGatewayConfig(selectedOwnedAgent.agentId);
        if (!active) return;
        setMerchantGatewayConfig(config);
        setMerchantGatewayEndpointUrl(config.endpointUrl ?? "");
        setMerchantGatewayCanaryPath(config.canaryPath ?? DEFAULT_CANARY_PATH);
        patchOwnedAgentGatewayReadiness(
          selectedOwnedAgent.agentId,
          config.readinessStatus,
          config.lastCanaryCheckedAt,
          config.lastCanaryPassedAt,
        );
      } catch (error) {
        if (!active) return;
        setMerchantGatewayConfig(null);
        setMerchantGatewayError(getErrorMessage(error, "Failed to load gateway readiness state."));
      } finally {
        if (active) setIsLoadingMerchantGatewayConfig(false);
      }
    };

    void loadMerchantGatewayConfig();

    return () => {
      active = false;
    };
  }, [fetchAgentGatewayConfig, patchOwnedAgentGatewayReadiness, selectedOwnedAgent, showMerchantView]);

  useEffect(() => {
    if (!normalizedRequestedAgentId) {
      setConsumerGatewayReadinessStatus(null);
      setConsumerGatewayReadinessError(null);
      setIsLoadingConsumerGatewayReadiness(false);
      return;
    }

    let active = true;

    const loadConsumerGatewayReadiness = async () => {
      setIsLoadingConsumerGatewayReadiness(true);
      setConsumerGatewayReadinessError(null);
      try {
        const config = await fetchAgentGatewayConfig(normalizedRequestedAgentId);
        if (!active) return;
        setConsumerGatewayReadinessStatus(config.readinessStatus);
      } catch (error) {
        if (!active) return;
        setConsumerGatewayReadinessStatus(null);
        setConsumerGatewayReadinessError(getErrorMessage(error, "Failed to load agent gateway readiness."));
      } finally {
        if (active) setIsLoadingConsumerGatewayReadiness(false);
      }
    };

    void loadConsumerGatewayReadiness();

    return () => {
      active = false;
    };
  }, [fetchAgentGatewayConfig, normalizedRequestedAgentId]);

  const merchantGatewayReadinessStatus =
    merchantGatewayConfig?.readinessStatus ?? selectedOwnedAgent?.gatewayReadinessStatus ?? "UNCONFIGURED";
  const merchantGatewayReadinessTone = getGatewayReadinessTone(merchantGatewayReadinessStatus);
  const merchantGatewayLastCheckedAt =
    merchantGatewayConfig?.lastCanaryCheckedAt ?? selectedOwnedAgent?.gatewayLastCanaryCheckedAt ?? null;
  const merchantGatewayLastPassedAt =
    merchantGatewayConfig?.lastCanaryPassedAt ?? selectedOwnedAgent?.gatewayLastCanaryPassedAt ?? null;

  const consumerHasExplicitAgentTarget = Boolean(normalizedRequestedAgentId && !usesFallbackAgentAddress);
  const consumerEffectiveGatewayReadinessStatus = consumerHasExplicitAgentTarget
    ? normalizeGatewayReadinessStatus(consumerGatewayReadinessStatus)
    : null;
  const consumerGatewayReadinessTone = getGatewayReadinessTone(
    consumerEffectiveGatewayReadinessStatus ?? "UNCONFIGURED",
  );
  const consumerGatewayActivationBlocked = consumerHasExplicitAgentTarget
    ? isLoadingConsumerGatewayReadiness || !isGatewayLive(consumerEffectiveGatewayReadinessStatus)
    : false;

  const handleSaveMerchantGatewayConfig = async () => {
    if (!selectedOwnedAgent || !address) return;

    setMerchantGatewayError(null);
    setMerchantGatewayNotice(null);
    setIsSavingMerchantGatewayConfig(true);

    try {
      const authPayload = createMerchantGatewayAuthPayload({
        action: "config",
        agentId: selectedOwnedAgent.agentId,
        ownerAddress: selectedOwnedAgent.owner,
        actorAddress: address.toLowerCase(),
        serviceSlug: `agent-${selectedOwnedAgent.agentId}`,
        nonce: crypto.randomUUID().replace(/-/g, ""),
      });
      const authSignature = await signMessageAsync({
        message: buildMerchantGatewayAuthMessage(authPayload),
      });

      const response = await fetch("/api/agent-gateway/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          agentId: selectedOwnedAgent.agentId,
          ownerAddress: selectedOwnedAgent.owner,
          actorAddress: address.toLowerCase(),
          serviceSlug: `agent-${selectedOwnedAgent.agentId}`,
          endpointUrl: merchantGatewayEndpointUrl.trim(),
          canaryPath: merchantGatewayCanaryPath.trim() || DEFAULT_CANARY_PATH,
          canaryMethod: "GET",
          authPayload,
          authSignature,
        }),
      });

      const payload = (await response.json()) as { error?: string; config?: AgentGatewayConfigRecord };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to save gateway config.");
      }

      const config =
        payload.config && typeof payload.config === "object"
          ? {
              ...payload.config,
              readinessStatus: normalizeGatewayReadinessStatus(payload.config.readinessStatus),
            }
          : await fetchAgentGatewayConfig(selectedOwnedAgent.agentId);

      setMerchantGatewayConfig(config as AgentGatewayConfigRecord);
      setMerchantGatewayEndpointUrl((config as AgentGatewayConfigRecord).endpointUrl ?? "");
      setMerchantGatewayCanaryPath((config as AgentGatewayConfigRecord).canaryPath ?? DEFAULT_CANARY_PATH);
      patchOwnedAgentGatewayReadiness(
        selectedOwnedAgent.agentId,
        (config as AgentGatewayConfigRecord).readinessStatus,
        (config as AgentGatewayConfigRecord).lastCanaryCheckedAt,
        (config as AgentGatewayConfigRecord).lastCanaryPassedAt,
      );
      setMerchantGatewayNotice("Gateway config saved. Run verification to mark this agent as live.");
    } catch (error) {
      setMerchantGatewayError(getErrorMessage(error, "Failed to save gateway config."));
    } finally {
      setIsSavingMerchantGatewayConfig(false);
    }
  };

  const handleVerifyMerchantGateway = async () => {
    if (!selectedOwnedAgent || !address) return;

    setMerchantGatewayError(null);
    setMerchantGatewayNotice(null);
    setIsVerifyingMerchantGateway(true);

    try {
      const authPayload = createMerchantGatewayAuthPayload({
        action: "verify",
        agentId: selectedOwnedAgent.agentId,
        ownerAddress: selectedOwnedAgent.owner,
        actorAddress: address.toLowerCase(),
        serviceSlug: `agent-${selectedOwnedAgent.agentId}`,
        nonce: crypto.randomUUID().replace(/-/g, ""),
      });
      const authSignature = await signMessageAsync({
        message: buildMerchantGatewayAuthMessage(authPayload),
      });

      const response = await fetch("/api/agent-gateway/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          agentId: selectedOwnedAgent.agentId,
          ownerAddress: selectedOwnedAgent.owner,
          actorAddress: address.toLowerCase(),
          serviceSlug: `agent-${selectedOwnedAgent.agentId}`,
          authPayload,
          authSignature,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        verified?: boolean;
        latencyMs?: number | null;
        readinessStatus?: GatewayReadinessStatus;
      };

      const refreshed = await fetchAgentGatewayConfig(selectedOwnedAgent.agentId);
      setMerchantGatewayConfig(refreshed);
      setMerchantGatewayEndpointUrl(refreshed.endpointUrl ?? "");
      setMerchantGatewayCanaryPath(refreshed.canaryPath ?? DEFAULT_CANARY_PATH);
      patchOwnedAgentGatewayReadiness(
        selectedOwnedAgent.agentId,
        refreshed.readinessStatus,
        refreshed.lastCanaryCheckedAt,
        refreshed.lastCanaryPassedAt,
      );

      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Gateway canary verification failed.");
      }

      const latencyText =
        typeof payload.latencyMs === "number" && Number.isFinite(payload.latencyMs)
          ? ` (${Math.trunc(payload.latencyMs)} ms)`
          : "";
      setMerchantGatewayNotice(`Gateway verified // Service live${latencyText}`);
      if (normalizedRequestedAgentId === selectedOwnedAgent.agentId) {
        setConsumerGatewayReadinessStatus(refreshed.readinessStatus);
        setConsumerGatewayReadinessError(null);
      }
    } catch (error) {
      setMerchantGatewayError(getErrorMessage(error, "Gateway canary verification failed."));
      if (normalizedRequestedAgentId === selectedOwnedAgent.agentId) {
        setConsumerGatewayReadinessStatus(null);
      }
    } finally {
      setIsVerifyingMerchantGateway(false);
    }
  };

  const merchantSdkExample = useMemo(
    () =>
      `import os
from ghostgate import GhostGate

gate = GhostGate(
    # SDK context/telemetry key placeholder (not the EIP-712 signer secret)
    api_key="${merchantApiKey}",
    # Gate authorization is signature-based and requires a signer private key
    private_key=os.environ.get("GHOST_SIGNER_PRIVATE_KEY"),
    # For local testing: use http://localhost:3000
    base_url="https://ghostprotocol.cc",
)

# Agent ID: ${selectedOwnedAgent?.agentId ?? "YOUR_AGENT_ID"}

@app.route('/ask', methods=['POST'])
@gate.guard(cost=1, service="${merchantServiceSlug}", method="POST")
def my_agent():
    return "AI Response"`,
    [merchantApiKey, selectedOwnedAgent, merchantServiceSlug],
  );

  const canPurchase =
    Boolean(isConnected) &&
    isOnSupportedChain &&
    amountWei != null &&
    amountWei > 0n &&
    estimatedCredits != null &&
    estimatedCredits > 0n &&
    !consumerGatewayActivationBlocked &&
    !isDepositWriting &&
    !isDepositConfirming &&
    !isSwitchingChain;

  const vaultBalanceWei = typeof agentVaultBalance === "bigint" ? agentVaultBalance : 0n;
  const formattedVaultBalance = useMemo(() => {
    return `${Number.parseFloat(formatEther(vaultBalanceWei)).toFixed(4)} ETH`;
  }, [vaultBalanceWei]);

  const merchantVaultBalanceWei = typeof merchantVaultBalance === "bigint" ? merchantVaultBalance : 0n;
  const formattedMerchantVaultBalance = useMemo(() => {
    return `${Number.parseFloat(formatEther(merchantVaultBalanceWei)).toFixed(4)} ETH`;
  }, [merchantVaultBalanceWei]);

  const merchantOwnsSelectedAgent = Boolean(
    address &&
    selectedOwnedAgentAddress &&
    address.toLowerCase() === selectedOwnedAgentAddress.toLowerCase(),
  );

  const canWithdrawMerchantFunds =
    Boolean(isConnected) &&
    Boolean(selectedOwnedAgent) &&
    Boolean(selectedOwnedAgentAddress) &&
    merchantOwnsSelectedAgent &&
    isOnSupportedChain &&
    merchantVaultBalanceWei > 0n &&
    !isWithdrawWriting &&
    !isWithdrawConfirming &&
    !isSwitchingChain;

  const isWithdrawConfirmedForSelectedAgent =
    isWithdrawConfirmed && selectedOwnedAgent?.agentId === lastWithdrawAgentId;

  useEffect(() => {
    if (!isWithdrawConfirmed) return;
    void refetchMerchantVaultBalance();
  }, [isWithdrawConfirmed, refetchMerchantVaultBalance]);

  const handleSwitchToPreferredChain = async () => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: PREFERRED_CHAIN_ID });
    } catch (error) {
      setSwitchError(getErrorMessage(error, "Unable to switch network."));
    }
  };

  const handlePurchase = async () => {
    if (consumerGatewayActivationBlocked) return;
    if (!canPurchase || amountWei == null) return;
    setSwitchError(null);

    if (!isOnSupportedChain) {
      try {
        await switchChainAsync({ chainId: PREFERRED_CHAIN_ID });
      } catch (error) {
        setSwitchError(getErrorMessage(error, "Network switch was rejected."));
        return;
      }
    }

    writeDepositContract({
      address: GHOST_VAULT_ADDRESS,
      abi: GHOST_VAULT_ABI,
      functionName: "depositCredit",
      args: [targetAgentAddress],
      value: amountWei,
    });
  };

  const handleWithdrawMerchantFunds = async () => {
    if (!selectedOwnedAgent || !selectedOwnedAgentAddress || !merchantOwnsSelectedAgent) return;
    setSwitchError(null);

    if (!isOnSupportedChain) {
      try {
        await switchChainAsync({ chainId: PREFERRED_CHAIN_ID });
      } catch (error) {
        setSwitchError(getErrorMessage(error, "Network switch was rejected."));
        return;
      }
    }

    setLastWithdrawAgentId(selectedOwnedAgent.agentId);
    writeWithdrawContract({
      address: GHOST_VAULT_ADDRESS,
      abi: GHOST_VAULT_ABI,
      functionName: "withdraw",
    });
  };

  const handleCopy = async () => {
    if (consumerGatewayActivationBlocked) return;
    try {
      await navigator.clipboard.writeText(consumerUsageExample);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const handleCopyApiKey = async () => {
    try {
      await navigator.clipboard.writeText(merchantApiKey);
      setApiKeyCopyState("copied");
    } catch {
      setApiKeyCopyState("error");
    }
  };

  return (
    <main className="min-h-screen font-mono text-neutral-400 bg-neutral-950 [background-image:none]">
      <div className="w-full px-4 py-8 md:px-8">
        <TerminalHeader title="ghost_gate // SETTLEMENT TERMINAL" />

        {!isConnected && (
          <section className="mb-12 border border-neutral-800 bg-neutral-900/50 p-8 text-center">
            <p className="text-sm uppercase tracking-[0.2em] text-neutral-500 font-bold">
              Connect Wallet to Access Terminal
            </p>
          </section>
        )}

        {isConnected && !forceConsumerView && ownedAgentsError && (
          <section className="mb-6 border border-rose-500/40 bg-rose-950/10 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-rose-300">{ownedAgentsError}</p>
          </section>
        )}

        {showMerchantView ? (
          <section className="space-y-6">
            <div className="border border-neutral-900 bg-neutral-950 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <p className="text-sm uppercase tracking-[0.18em] text-neutral-100 font-bold">
                  {"// MERCHANT CONSOLE"}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-500 font-bold">Active Agent</span>
                  <select
                    value={selectedOwnedAgent?.agentId ?? ""}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    className="min-w-[156px] border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs uppercase tracking-[0.16em] text-neutral-300 outline-none focus:border-red-600 rounded-none font-bold"
                  >
                    {ownedAgents.map((agent) => (
                      <option key={`${agent.agentId}-${agent.owner}`} value={agent.agentId}>
                        AGENT #{agent.agentId} {agent.isClaimed ? "[RESERVED]" : "[UNCLAIMED]"}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <SdkSecurityNoticeBanner />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Code className="h-5 w-5 text-red-600" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">YOUR API GATEWAY</h2>
                </div>

                <div className="border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                    SDK CONTEXT KEY (PREVIEW PLACEHOLDER)
                  </p>
                  <code className="block break-all text-sm text-neutral-300 font-mono">{merchantApiKey}</code>
                  <p className="mt-2 text-xs text-neutral-600">
                    Preview only. Ghost Protocol dashboard does not issue SDK keys yet. See SDK docs for setup.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleCopyApiKey}
                  className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
                >
                  <Copy className="h-4 w-4" />
                  {apiKeyCopyState === "copied" ? "Preview Copied" : "COPY PREVIEW"}
                </button>

                {apiKeyCopyState === "error" && (
                  <p className="mt-2 text-xs text-red-500">Clipboard permission blocked. Copy manually.</p>
                )}

                <div className={`mt-5 border p-4 ${merchantGatewayReadinessTone.border} ${merchantGatewayReadinessTone.bg}`}>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Gateway Readiness</p>
                      <div className="inline-flex items-center gap-2 border border-neutral-800 bg-neutral-950 px-3 py-1.5">
                        <span className={`h-2 w-2 rounded-none ${merchantGatewayReadinessTone.dot}`} />
                        <span className={`text-xs uppercase tracking-[0.16em] font-bold ${merchantGatewayReadinessTone.text}`}>
                          {formatGatewayReadinessLabel(merchantGatewayReadinessStatus)}
                        </span>
                      </div>
                      {isLoadingMerchantGatewayConfig && (
                        <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-500 font-bold animate-pulse">
                          Loading...
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                        Merchant Endpoint URL
                        <input
                          value={merchantGatewayEndpointUrl}
                          onChange={(event) => setMerchantGatewayEndpointUrl(event.target.value)}
                          placeholder="https://merchant.example.com"
                          className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-white outline-none focus:border-red-600 rounded-none font-mono"
                        />
                      </label>

                      <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                        Canary Path (GET)
                        <input
                          value={merchantGatewayCanaryPath}
                          onChange={(event) => setMerchantGatewayCanaryPath(event.target.value)}
                          placeholder={DEFAULT_CANARY_PATH}
                          className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-white outline-none focus:border-red-600 rounded-none font-mono"
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={handleSaveMerchantGatewayConfig}
                        disabled={
                          !selectedOwnedAgent ||
                          !isConnected ||
                          !merchantOwnsSelectedAgent ||
                          isSavingMerchantGatewayConfig ||
                          isVerifyingMerchantGateway
                        }
                        className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingMerchantGatewayConfig ? "SAVING..." : "SAVE GATEWAY CONFIG"}
                      </button>
                      <button
                        type="button"
                        onClick={handleVerifyMerchantGateway}
                        disabled={
                          !selectedOwnedAgent ||
                          !isConnected ||
                          !merchantOwnsSelectedAgent ||
                          !merchantGatewayEndpointUrl.trim() ||
                          isSavingMerchantGatewayConfig ||
                          isVerifyingMerchantGateway
                        }
                        className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:border-red-600 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isVerifyingMerchantGateway ? "VERIFYING..." : "VERIFY GATEWAY"}
                      </button>
                    </div>

                    <p className="text-xs text-neutral-600">
                      Canary contract (Phase A): GET <span className="font-mono">{merchantGatewayCanaryPath || DEFAULT_CANARY_PATH}</span> must
                      return HTTP 200 with exact JSON:{" "}
                      <span className="font-mono">{`{"ghostgate":"ready","service":"${merchantServiceSlug}"}`}</span>
                    </p>

                    {(merchantGatewayLastCheckedAt || merchantGatewayLastPassedAt) && (
                      <div className="text-xs text-neutral-600">
                        {merchantGatewayLastCheckedAt && (
                          <p>Last checked: {new Date(merchantGatewayLastCheckedAt).toLocaleString()}</p>
                        )}
                        {merchantGatewayLastPassedAt && (
                          <p>Last passed: {new Date(merchantGatewayLastPassedAt).toLocaleString()}</p>
                        )}
                      </div>
                    )}

                    {merchantGatewayConfig?.lastCanaryError && merchantGatewayReadinessStatus !== "LIVE" && (
                      <p className="text-xs text-rose-400">
                        Last canary error: {merchantGatewayConfig.lastCanaryError}
                      </p>
                    )}

                    {merchantGatewayError && <p className="text-xs text-red-500">{merchantGatewayError}</p>}
                    {merchantGatewayNotice && <p className="text-xs text-neutral-400">{merchantGatewayNotice}</p>}
                  </div>
                </div>

                <div className="mt-5 border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">SDK Usage Preview</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
                    <code>{merchantSdkExample}</code>
                  </pre>
                </div>

                <SdkDocsLinks />
              </article>

              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Wallet className="h-5 w-5 text-neutral-500" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">AGENT VAULT REVENUE</h2>
                </div>

                <div className="border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-1 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Withdrawable Balance</p>
                  <p className={`text-3xl font-mono ${merchantVaultBalanceWei > 0n ? "text-neutral-200" : "text-neutral-500"}`}>
                    {isConnected
                      ? isMerchantBalancePending
                        ? "..."
                        : formattedMerchantVaultBalance
                      : "0.0000 ETH"}
                  </p>
                </div>

                <div className="mt-4 border border-neutral-900 bg-neutral-900 p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Vault Owner (Selected Agent)</p>
                  <p className="mt-1 break-all text-sm text-neutral-400 font-mono">
                    {selectedOwnedAgentAddress ?? "--"}
                  </p>
                </div>

                <div className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-1.5">
                  <span
                    className={`h-2 w-2 rounded-none ${isWithdrawConfirming
                      ? "bg-red-500 animate-pulse"
                      : isWithdrawConfirmedForSelectedAgent
                        ? "bg-neutral-400"
                        : merchantVaultBalanceWei > 0n
                          ? "bg-neutral-400"
                          : "bg-neutral-600"
                      }`}
                  />
                  <span className={`text-xs uppercase tracking-[0.16em] font-bold ${isWithdrawConfirming
                    ? "text-red-400"
                    : isWithdrawConfirmedForSelectedAgent
                      ? "text-neutral-300"
                      : merchantVaultBalanceWei > 0n
                        ? "text-neutral-300"
                        : "text-neutral-500"
                    }`}>
                    {isWithdrawConfirming
                      ? "WITHDRAWAL PENDING"
                      : isWithdrawConfirmedForSelectedAgent
                        ? "WITHDRAWAL CONFIRMED"
                        : merchantVaultBalanceWei > 0n
                          ? "WITHDRAW READY"
                          : "NO WITHDRAWABLE BALANCE"}
                  </span>
                </div>

                {merchantReadError && (
                  <p className="mt-3 text-xs text-red-500">
                    {getErrorMessage(merchantReadError, "Failed to read merchant vault balance.")}
                  </p>
                )}
              </article>
            </div>

            <div className="flex flex-col gap-3 border border-neutral-900 bg-neutral-950 p-5 sm:flex-row">
              <a
                href={selectedAgentProfileHref}
                className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-200"
              >
                OPEN PUBLIC PROFILE
              </a>
              <a
                href={selectedAgentConsumerTerminalHref}
                className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-200"
              >
                OPEN CONSUMER TERMINAL
              </a>
              <div className="inline-flex flex-col items-start">
                <button
                  type="button"
                  onClick={handleWithdrawMerchantFunds}
                  disabled={!canWithdrawMerchantFunds}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-400 transition hover:border-red-600 hover:bg-red-600 hover:text-neutral-100 disabled:cursor-not-allowed disabled:bg-neutral-900 disabled:text-neutral-600 disabled:hover:border-neutral-800 disabled:hover:bg-neutral-900 disabled:hover:text-neutral-600"
                >
                  {isWithdrawWriting
                    ? "SUBMITTING_WITHDRAWAL"
                    : isWithdrawConfirming
                      ? "CONFIRMING_WITHDRAWAL"
                      : "WITHDRAW_FUNDS"}
                </button>
                <p className="mt-1 text-[10px] text-neutral-600">
                  {!isConnected
                    ? "Connect wallet to withdraw merchant funds."
                    : !selectedOwnedAgent
                      ? "Select an owned agent to load balance."
                      : !merchantOwnsSelectedAgent
                        ? "Connected wallet does not match selected agent owner."
                        : !isOnSupportedChain
                          ? "Switch to Base Mainnet to withdraw."
                          : merchantVaultBalanceWei <= 0n
                            ? "No withdrawable GhostVault balance for the selected agent owner."
                            : "Withdraws the selected owner balance from GhostVault to the connected owner wallet."}
                </p>
                {withdrawWriteError && (
                  <p className="mt-1 text-xs text-red-500">
                    {getErrorMessage(withdrawWriteError, "Withdrawal transaction failed.")}
                  </p>
                )}
                {switchError && (
                  <p className="mt-1 text-xs text-red-500">{switchError}</p>
                )}
              </div>
            </div>
          </section>
        ) : isConnected && !forceConsumerView && isLoadingOwnedAgents ? (
          <section className="border border-neutral-800 bg-neutral-900/50 p-4 text-center">
            <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 animate-pulse font-bold">
              Loading owned agents from live Postgres index...
            </p>
          </section>
        ) : (
          <section className="space-y-6">
            <SdkSecurityNoticeBanner />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Wallet className="h-5 w-5 text-neutral-500" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">Agent Vault</h2>
                </div>

                {isDepositConfirmed && (
                  <div className="mb-5 flex items-center gap-2 border border-red-900/40 bg-red-950/10 px-3 py-2">
                    <span className="h-2 w-2 bg-red-600 rounded-none shadow-none" />
                    <p className="text-xs uppercase tracking-[0.16em] text-red-500 font-bold">
                      Deposit Confirmed // Agent Access Unlocked
                    </p>
                  </div>
                )}

                {isDepositConfirmed && creditSyncState === "syncing" && (
                  <div className="mb-5 flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-2">
                    <span className="h-2 w-2 bg-neutral-500 rounded-none animate-pulse" />
                    <p className="text-xs uppercase tracking-[0.16em] text-neutral-400 font-bold">
                      Syncing Payment Ledger...
                    </p>
                  </div>
                )}

                {isDepositConfirmed && creditSyncState === "synced" && (
                  <div className="mb-5 flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-2">
                    <span className="h-2 w-2 bg-neutral-500 rounded-none" />
                    <p className="text-xs uppercase tracking-[0.16em] text-neutral-400 font-bold">
                      Credits Synced // Available Credits: {syncedCredits ?? "--"}
                    </p>
                  </div>
                )}

                {isDepositConfirmed && creditSyncState === "error" && (
                  <div className="mb-5 flex flex-col gap-2 border border-red-900/40 bg-red-950/10 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.16em] text-red-500 font-bold">
                      Credit Sync Failed // {creditSyncError ?? "Unable to refresh access credits."}
                    </p>
                    <button
                      type="button"
                      onClick={handleRetryCreditSync}
                      className="inline-flex w-fit items-center justify-center border border-red-900/40 bg-red-950/20 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-red-400 transition hover:bg-red-900/30"
                    >
                      Retry Sync
                    </button>
                  </div>
                )}

                <div className="mb-5 border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-1 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Vault Revenue (ETH)</p>
                  <p className="text-3xl text-neutral-200 font-mono">
                    {isConnected
                      ? isBalancePending
                        ? "..."
                        : formattedVaultBalance
                      : "0.0000 ETH"}
                  </p>
                </div>

                <div className="mb-5 border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-1 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Your Available Credits</p>
                  <p className="text-2xl text-neutral-200 font-mono">{isConnected ? syncedCredits ?? "0" : "0"}</p>
                </div>

                <div className="mb-5 border border-neutral-900 bg-neutral-900 p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Target Agent Wallet</p>
                  <p className="mt-1 break-all text-sm text-neutral-400 font-mono">{targetAgentAddress}</p>
                  {usesFallbackAgentAddress && (
                    <p className="mt-1 text-xs text-neutral-600">
                      No agent wallet found in page context. Using protocol treasury fallback for testing.
                    </p>
                  )}
                </div>

                {consumerHasExplicitAgentTarget && (
                  <div className={`mb-5 border px-3 py-3 ${consumerGatewayReadinessTone.border} ${consumerGatewayReadinessTone.bg}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-none ${consumerGatewayReadinessTone.dot}`} />
                      <p className={`text-xs uppercase tracking-[0.16em] font-bold ${consumerGatewayReadinessTone.text}`}>
                        {isLoadingConsumerGatewayReadiness
                          ? "Checking Gateway Activation..."
                          : `Gateway Status // ${formatGatewayReadinessLabel(
                              consumerEffectiveGatewayReadinessStatus ?? "UNCONFIGURED",
                            )}`}
                      </p>
                    </div>
                    {consumerGatewayActivationBlocked && !isLoadingConsumerGatewayReadiness && (
                      <p className="mt-2 text-xs text-neutral-400">
                        This agent has not activated GhostGate yet. Merchant must register and verify a gateway canary
                        before consumers can deposit or use this agent.
                      </p>
                    )}
                    {consumerGatewayReadinessError && (
                      <p className="mt-2 text-xs text-red-500">{consumerGatewayReadinessError}</p>
                    )}
                  </div>
                )}

                <div className="space-y-4">
                  <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                    Deposit ETH
                    <input
                      value={ethAmount}
                      onChange={(event) => setEthAmount(event.target.value)}
                      disabled={consumerGatewayActivationBlocked}
                      inputMode="decimal"
                      placeholder="0.01"
                      className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none font-mono"
                    />
                  </label>

                  <div className="border border-neutral-900 bg-neutral-900 p-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Estimated Access Credits</p>
                    <p className="text-lg text-neutral-200 font-mono">{estimatedCredits == null ? "--" : estimatedCredits.toString()}</p>
                    <p className="mt-1 text-xs text-neutral-600">
                      Price per credit: {formatEther(CREDIT_PRICE_WEI)} ETH
                    </p>
                  </div>

                  {isConnected && !isOnSupportedChain && (
                    <div className="border border-red-900/50 bg-red-950/20 p-3">
                      <p className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-red-500 font-bold">
                        <AlertTriangle className="h-4 w-4" />
                        NETWORK MISMATCH // INITIALIZING SWITCH PROTOCOL
                      </p>
                      <button
                        type="button"
                        onClick={handleSwitchToPreferredChain}
                        disabled={isSwitchingChain}
                        className="mt-3 inline-flex items-center gap-2 border border-red-900/40 bg-neutral-900 px-4 py-2 text-xs uppercase tracking-wider text-red-400 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSwitchingChain ? "Switching..." : "Switch to Base Mainnet"}
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handlePurchase}
                    disabled={!canPurchase}
                    className="w-full border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm uppercase tracking-wider text-neutral-300 font-bold transition hover:bg-red-600 hover:border-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSwitchingChain
                      ? "Switching network..."
                      : isDepositWriting
                        ? "Submitting..."
                        : isDepositConfirming
                          ? "Confirming..."
                          : "Deposit ETH"}
                  </button>

                  {depositWriteError && (
                    <p className="text-xs text-red-500">{getErrorMessage(depositWriteError, "Transaction failed.")}</p>
                  )}
                  {readError && (
                    <p className="text-xs text-red-500">{getErrorMessage(readError, "Failed to read vault balance.")}</p>
                  )}
                  {switchError && <p className="text-xs text-red-500">{switchError}</p>}
                </div>
              </article>

              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Code className="h-5 w-5 text-neutral-500" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">API ACCESS // CONSUMER CONSOLE</h2>
                </div>

                {consumerHasExplicitAgentTarget && (
                  <div className={`mb-4 border px-3 py-2 ${consumerGatewayReadinessTone.border} ${consumerGatewayReadinessTone.bg}`}>
                    <p className={`text-xs uppercase tracking-[0.16em] font-bold ${consumerGatewayReadinessTone.text}`}>
                      {isLoadingConsumerGatewayReadiness
                        ? "Gateway Activation Check Pending"
                        : isGatewayLive(consumerEffectiveGatewayReadinessStatus)
                          ? "Agent Gateway Live // Consumer Access Enabled"
                          : "Agent Gateway Not Live // Consumer Access Disabled"}
                    </p>
                  </div>
                )}

                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConsumerSdk("node")}
                    className={`border px-3 py-2 text-xs uppercase tracking-[0.14em] transition font-bold ${consumerSdk === "node"
                      ? "border-neutral-700 bg-neutral-800 text-neutral-200"
                      : "border-neutral-800 bg-neutral-950 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
                      }`}
                  >
                    Node.js SDK
                  </button>
                  <button
                    type="button"
                    onClick={() => setConsumerSdk("python")}
                    className={`border px-3 py-2 text-xs uppercase tracking-[0.14em] transition font-bold ${consumerSdk === "python"
                      ? "border-neutral-700 bg-neutral-800 text-neutral-200"
                      : "border-neutral-800 bg-neutral-950 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
                      }`}
                  >
                    Python CLI
                  </button>
                </div>

                <div className="border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                    {consumerSdk === "python"
                      ? "Trusted CLI Usage Example (Raw EIP-712 Request)"
                      : "Usage Example"}
                  </p>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
                    <code>{consumerUsageExample}</code>
                  </pre>
                </div>

                {consumerSdk === "python" && (
                  <p className="mt-3 text-xs text-neutral-600">
                    This example runs in a trusted CLI/server environment and signs the gate request directly. Do
                    not run this with a raw private key in frontend code.
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={consumerGatewayActivationBlocked}
                  className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs uppercase tracking-wider text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Copy className="h-4 w-4" />
                  {copyState === "copied"
                    ? "Copied"
                    : `Copy ${consumerSdk === "node" ? "Node.js" : "Python"} Example`}
                </button>

                {copyState === "error" && (
                  <p className="mt-2 text-xs text-red-500">Clipboard permission blocked. Copy manually.</p>
                )}

                <div className="mt-5 border border-neutral-900 bg-neutral-900 p-4">
                  <p className="text-sm text-neutral-500">
                    {consumerSdk === "node"
                      ? "The Node SDK signs and routes verification requests to"
                      : "This Python CLI example signs and sends a raw EIP-712 verification request to"}
                  </p>
                  <p className="mt-1">
                    <span className="block break-all text-neutral-300 font-mono">
                      {APP_BASE_URL}/api/gate/{consumerServiceSlug}
                    </span>
                    <span className="text-neutral-300 font-mono">1 Request = 1 Credit.</span>
                  </p>
                </div>

                <SdkDocsLinks />
              </article>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<main className="min-h-screen font-mono text-neutral-400" />}>
      <DashboardPageContent />
    </Suspense>
  );
}
