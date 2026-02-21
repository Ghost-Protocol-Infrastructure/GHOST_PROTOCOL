"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { AlertTriangle, Code, Copy, Info, Wallet } from "lucide-react";
import {
  useAccount,
  useReadContract,
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
import GhostLogo from "@/components/GhostLogo";
import LatencyIndicator from "@/components/LatencyIndicator";

const CREDIT_PRICE_WEI = parseEther("0.00001");
const SUPPORTED_CHAIN_IDS = new Set<number>([base.id]);
const PREFERRED_CHAIN_ID = base.id;

type CopyState = "idle" | "copied" | "error";
type CreditSyncState = "idle" | "syncing" | "synced" | "error";
type ConsumerSdk = "node" | "python";

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
};

const isHexAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);
const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");
const APP_BASE_URL = normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL?.trim() || "https://ghostprotocol.cc");

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
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const { data: txHash, error: writeError, isPending: isWriting, writeContract } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
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
    if (!address || !txHash || !isConfirmed) return;
    await syncCreditsFromChain(address, txHash);
  };

  useEffect(() => {
    if (!txHash) {
      setCreditSyncState("idle");
      setCreditSyncError(null);
      setSyncedCredits(null);
      return;
    }

    setCreditSyncState("idle");
    setCreditSyncError(null);
  }, [txHash]);

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
    if (!isConfirmed || !address || !txHash) return;
    if (syncedHashesRef.current.has(txHash)) return;
    syncedHashesRef.current.add(txHash);

    void refetchBalance();
    void syncCreditsFromChain(address, txHash);
  }, [address, isConfirmed, refetchBalance, syncCreditsFromChain, txHash]);

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
      `from ghostgate import GhostGate

gate = GhostGate(
    api_key="sk_live_your_api_key",
    private_key="0xyour_private_key",
    base_url="${APP_BASE_URL}",
)

@gate.guard(cost=1, service="${consumerServiceSlug}", method="POST")
def run_agent():
    return {"ok": True}`,
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
  const showMerchantView = ownedAgents.length > 0 && !forceConsumerView;

  useEffect(() => {
    if (!ownedAgents.length) {
      setSelectedAgentId("");
      return;
    }

    const selectedIsOwned = ownedAgents.some((agent) => agent.agentId === selectedAgentId);

    // Only use URL agentId for initial/default selection.
    if (!selectedAgentId) {
      const requestedIsOwned = requestedAgentId != null && ownedAgents.some((agent) => agent.agentId === requestedAgentId);
      if (requestedIsOwned && requestedAgentId != null) {
        setSelectedAgentId(requestedAgentId);
        return;
      }

      setSelectedAgentId(ownedAgents[0].agentId);
      return;
    }

    if (!selectedIsOwned) {
      setSelectedAgentId(ownedAgents[0].agentId);
    }
  }, [ownedAgents, requestedAgentId, selectedAgentId]);

  const merchantApiKey = useMemo(() => {
    if (!address || !selectedOwnedAgent) return "sk_live_[WALLET]...";
    return `sk_live_${selectedOwnedAgent.agentId}_${address.slice(2, 10)}...`;
  }, [address, selectedOwnedAgent]);

  const selectedAgentProfileHref = selectedOwnedAgent
    ? `/agent/${encodeURIComponent(selectedOwnedAgent.agentId)}`
    : "/rank";
  const selectedAgentConsumerTerminalHref = selectedOwnedAgent
    ? `/dashboard?mode=consumer&agentId=${encodeURIComponent(selectedOwnedAgent.agentId)}&owner=${encodeURIComponent(selectedOwnedAgent.owner)}`
    : "/dashboard?mode=consumer";
  const merchantServiceSlug = selectedOwnedAgent ? `agent-${selectedOwnedAgent.agentId}` : "agent-your-agent-id";

  const merchantSdkExample = useMemo(
    () =>
      `from ghostgate import GhostGate
gate = GhostGate(api_key="${merchantApiKey}")

# Agent ID: ${selectedOwnedAgent?.agentId ?? "YOUR_AGENT_ID"}

@app.route('/ask', methods=['POST'])
@gate.guard(cost=1, service="${merchantServiceSlug}")
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
    !isWriting &&
    !isConfirming &&
    !isSwitchingChain;

  const vaultBalanceWei = typeof agentVaultBalance === "bigint" ? agentVaultBalance : 0n;
  const formattedVaultBalance = useMemo(() => {
    return `${Number.parseFloat(formatEther(vaultBalanceWei)).toFixed(4)} ETH`;
  }, [vaultBalanceWei]);

  const handleSwitchToPreferredChain = async () => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: PREFERRED_CHAIN_ID });
    } catch (error) {
      setSwitchError(getErrorMessage(error, "Unable to switch network."));
    }
  };

  const handlePurchase = async () => {
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

    writeContract({
      address: GHOST_VAULT_ADDRESS,
      abi: GHOST_VAULT_ABI,
      functionName: "depositCredit",
      args: [targetAgentAddress],
      value: amountWei,
    });
  };

  const handleCopy = async () => {
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
    <main className="min-h-screen font-mono text-neutral-400">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
        <header className="mb-12 flex flex-col gap-4 border-b border-neutral-900 pb-8 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <GhostLogo className="h-5 w-5" />
            <h1 className="text-sm tracking-[0.2em] text-neutral-100 md:text-base font-bold">
              ghost_gate // SETTLEMENT TERMINAL
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <LatencyIndicator
              labelClassName="text-neutral-600 text-[10px] tracking-[0.16em]"
              valueClassName="text-red-500 font-bold text-[10px] tracking-[0.16em]"
              offlineValueClassName="text-neutral-500 font-bold text-[10px] tracking-[0.16em]"
            />
            <ConnectButton showBalance={false} chainStatus="icon" accountStatus="full" />
          </div>
        </header>

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

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Code className="h-5 w-5 text-red-600" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">YOUR API GATEWAY</h2>
                </div>

                <div className="border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">API Key</p>
                  <code className="block break-all text-sm text-neutral-300 font-mono">{merchantApiKey}</code>
                </div>

                <button
                  type="button"
                  onClick={handleCopyApiKey}
                  className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
                >
                  <Copy className="h-4 w-4" />
                  {apiKeyCopyState === "copied" ? "Copied" : "Copy"}
                </button>

                {apiKeyCopyState === "error" && (
                  <p className="mt-2 text-xs text-red-500">Clipboard permission blocked. Copy manually.</p>
                )}

                <div className="mt-5 border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">SDK Usage Preview</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
                    <code>{merchantSdkExample}</code>
                  </pre>
                </div>

                <p className="mt-5 text-sm text-neutral-500">
                  Install the GhostGate SDK to monetize your agent.
                </p>
              </article>

              <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Wallet className="h-5 w-5 text-neutral-500" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">PROJECTED REVENUE</h2>
                </div>

                <div className="border border-neutral-900 bg-neutral-900 p-4">
                  <p className="mb-1 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Estimated Balance</p>
                  <p className="text-3xl text-neutral-500 font-mono">0.0000 ETH</p>
                </div>

                <div className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-1.5">
                  <span className="h-2 w-2 bg-neutral-600 rounded-none" />
                  <span className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">PENDING INSTALL</span>
                </div>
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
                  disabled
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-600 cursor-not-allowed disabled:cursor-not-allowed"
                >
                  WITHDRAW FUNDS
                </button>
                <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-neutral-600">
                  <Info className="h-3 w-3" />
                  Minimum 0.01 ETH required for withdrawal.
                </p>
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
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <article className="bg-neutral-950 border border-neutral-900 rounded-none p-5">
              <div className="mb-5 flex items-center gap-3">
                <Wallet className="h-5 w-5 text-neutral-500" />
                <h2 className="text-sm uppercase tracking-[0.18em] text-neutral-300 font-bold">Agent Vault</h2>
              </div>

              {isConfirmed && (
                <div className="mb-5 flex items-center gap-2 border border-red-900/40 bg-red-950/10 px-3 py-2">
                  <span className="h-2 w-2 bg-red-600 rounded-none shadow-none" />
                  <p className="text-xs uppercase tracking-[0.16em] text-red-500 font-bold">
                    Deposit Confirmed // Agent Access Unlocked
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "syncing" && (
                <div className="mb-5 flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-2">
                  <span className="h-2 w-2 bg-neutral-500 rounded-none animate-pulse" />
                  <p className="text-xs uppercase tracking-[0.16em] text-neutral-400 font-bold">
                    Syncing Payment Ledger...
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "synced" && (
                <div className="mb-5 flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-3 py-2">
                  <span className="h-2 w-2 bg-neutral-500 rounded-none" />
                  <p className="text-xs uppercase tracking-[0.16em] text-neutral-400 font-bold">
                    Credits Synced // Available Credits: {syncedCredits ?? "--"}
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "error" && (
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

              <div className="space-y-4">
                <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
                  Deposit ETH
                  <input
                    value={ethAmount}
                    onChange={(event) => setEthAmount(event.target.value)}
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
                  className="w-full border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm uppercase tracking-wider text-neutral-300 font-bold transition hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSwitchingChain
                    ? "Switching network..."
                    : isWriting
                      ? "Submitting..."
                      : isConfirming
                        ? "Confirming..."
                        : "Deposit ETH"}
                </button>

                {writeError && (
                  <p className="text-xs text-red-500">{getErrorMessage(writeError, "Transaction failed.")}</p>
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
                  Python SDK
                </button>
              </div>

              <div className="border border-neutral-900 bg-neutral-900 p-4">
                <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Usage Example</p>
                <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
                  <code>{consumerUsageExample}</code>
                </pre>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className="mt-4 inline-flex items-center gap-2 border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs uppercase tracking-wider text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
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
                    : "The Python SDK automatically routes verification requests to"}{" "}
                  <span className="text-neutral-300 font-mono">{APP_BASE_URL}/api/gate/{consumerServiceSlug}.</span>{" "}
                  <span className="text-neutral-300 font-mono">1 Request = 1 Credit.</span>
                </p>
              </div>
            </article>
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
