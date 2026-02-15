"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Activity, AlertTriangle, Code, Copy, Info, Wallet } from "lucide-react";
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
import baseAgents from "../../data/leads-scored.json";

const CREDIT_PRICE_WEI = parseEther("0.00001");
const SUPPORTED_CHAIN_IDS = new Set<number>([base.id]);
const PREFERRED_CHAIN_ID = base.id;

type CopyState = "idle" | "copied" | "error";
type CreditSyncState = "idle" | "syncing" | "synced" | "error";

type BaseAgentLead = {
  agentId: string;
  owner: string;
  txCount: number;
  tier: "WHALE" | "ACTIVE" | "NEW";
};

const indexedBaseAgents = baseAgents as BaseAgentLead[];

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
  const [syncedCredits, setSyncedCredits] = useState<string | null>(null);
  const syncedHashesRef = useRef<Set<string>>(new Set());

  const amountWei = useMemo(() => parseInputWei(ethAmount), [ethAmount]);
  const estimatedCredits = useMemo(() => {
    if (amountWei == null) return null;
    return amountWei / CREDIT_PRICE_WEI;
  }, [amountWei]);

  const requestedAgentId = searchParams.get("agentId");
  const requestedAgentWallet = useMemo(
    () => indexedBaseAgents.find((agent) => agent.agentId === requestedAgentId)?.owner ?? null,
    [requestedAgentId],
  );
  const requestedAgentAddress = useMemo(
    () => normalizeAddress(requestedAgentWallet),
    [requestedAgentWallet],
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

  const consumerUsageExample = useMemo(
    () =>
      `The Python SDK automatically routes verification requests to
https://ghost-rank.vercel.app/api/gate/<your-service-name>.`,
    [],
  );

  const ownedAgents = useMemo(() => {
    if (!address) return [];
    return indexedBaseAgents.filter((a) => a.owner.toLowerCase() === address.toLowerCase());
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

  const merchantSdkExample = useMemo(
    () =>
      `from ghostgate import GhostGate
gate = GhostGate(api_key="${merchantApiKey}")

# Agent ID: ${selectedOwnedAgent?.agentId ?? "YOUR_AGENT_ID"}

@app.route('/ask', methods=['POST'])
@gate.guard(cost=1, service="weather")
def my_agent():
    return "AI Response"`,
    [merchantApiKey, selectedOwnedAgent],
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
    <main className="min-h-screen bg-slate-950 font-mono text-slate-400">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
        <header className="mb-8 flex flex-col gap-4 border border-slate-800 bg-slate-900 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-cyan-400" />
            <h1 className="text-sm uppercase tracking-[0.2em] text-slate-100 md:text-base">
              GhostGate Terminal
            </h1>
          </div>
          <ConnectButton />
        </header>

        {!isConnected && (
          <section className="mb-6 border border-cyan-700 bg-slate-900 p-4">
            <p className="text-sm uppercase tracking-[0.18em] text-cyan-400">
              Connect Wallet to Access Terminal
            </p>
          </section>
        )}

        {showMerchantView ? (
          <section className="space-y-6">
            <div className="border border-emerald-500/40 bg-emerald-950/10 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <p className="text-sm uppercase tracking-[0.18em] text-emerald-400">
                  MERCHANT CONSOLE
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Active Agent</span>
                  <select
                    value={selectedOwnedAgent?.agentId ?? ""}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    className="min-w-[156px] border border-emerald-500/40 bg-slate-950 px-3 py-2 text-xs uppercase tracking-[0.16em] text-emerald-300 outline-none focus:border-emerald-400"
                  >
                    {ownedAgents.map((agent) => (
                      <option key={`${agent.agentId}-${agent.owner}`} value={agent.agentId}>
                        AGENT #{agent.agentId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <article className="bg-slate-900 border border-emerald-500/30 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Code className="h-5 w-5 text-emerald-400" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-emerald-300">YOUR API GATEWAY</h2>
                </div>

                <div className="border border-emerald-500/20 bg-slate-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-400">API Key</p>
                  <code className="block break-all text-sm text-emerald-300">{merchantApiKey}</code>
                </div>

                <button
                  type="button"
                  onClick={handleCopyApiKey}
                  className="mt-4 inline-flex items-center gap-2 border border-emerald-500/40 bg-slate-800 px-4 py-2 text-xs uppercase tracking-wider text-emerald-300 transition hover:bg-slate-700"
                >
                  <Copy className="h-4 w-4" />
                  {apiKeyCopyState === "copied" ? "Copied" : "Copy"}
                </button>

                {apiKeyCopyState === "error" && (
                  <p className="mt-2 text-xs text-yellow-400">Clipboard permission blocked. Copy manually.</p>
                )}

                <div className="mt-5 border border-emerald-500/20 bg-slate-950 p-4">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-400">SDK Usage Preview</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-emerald-300">
                    <code>{merchantSdkExample}</code>
                  </pre>
                </div>

                <p className="mt-5 text-sm text-slate-400">
                  Install the GhostGate SDK to monetize your agent.
                </p>
              </article>

              <article className="bg-slate-900 border border-yellow-500/30 rounded-none p-5">
                <div className="mb-5 flex items-center gap-3">
                  <Wallet className="h-5 w-5 text-yellow-400" />
                  <h2 className="text-sm uppercase tracking-[0.18em] text-yellow-300">PROJECTED REVENUE</h2>
                </div>

                <div className="border border-yellow-500/20 bg-slate-950 p-4">
                  <p className="mb-1 text-xs uppercase tracking-[0.16em] text-slate-500">Estimated Balance</p>
                  <p className="text-3xl text-slate-500">0.0000 ETH</p>
                </div>

                <div className="mt-4 inline-flex items-center gap-2 border border-yellow-500/30 bg-yellow-950/20 px-3 py-1.5">
                  <span className="h-2 w-2 rounded-full bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.8)]" />
                  <span className="text-xs uppercase tracking-[0.16em] text-yellow-300">PENDING INSTALL</span>
                </div>
              </article>
            </div>

            <div className="flex flex-col gap-3 border border-slate-800 bg-slate-900 p-5 sm:flex-row">
              <a
                href="#"
                className="inline-flex items-center justify-center border border-emerald-500/40 bg-emerald-950/20 px-4 py-2 text-xs uppercase tracking-[0.16em] text-emerald-300 transition hover:bg-emerald-900/30"
              >
                VIEW DEVELOPER DOCS
              </a>
              <a
                href="/sdk/ghostgate.py"
                download
                className="inline-flex items-center justify-center border border-cyan-500/40 bg-cyan-950/20 px-4 py-2 text-xs uppercase tracking-[0.16em] text-cyan-300 transition hover:bg-cyan-900/30"
              >
                DOWNLOAD SDK (.PY)
              </a>
              <div className="inline-flex flex-col items-start">
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center justify-center border border-slate-700 bg-slate-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-slate-600 cursor-not-allowed disabled:cursor-not-allowed"
                >
                  WITHDRAW FUNDS
                </button>
                <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500">
                  <Info className="h-3 w-3" />
                  Minimum 0.01 ETH required for withdrawal.
                </p>
              </div>
            </div>
          </section>
        ) : (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <article className="bg-slate-900 border border-slate-800 rounded-none p-5">
              <div className="mb-5 flex items-center gap-3">
                <Wallet className="h-5 w-5 text-emerald-400" />
                <h2 className="text-sm uppercase tracking-[0.18em] text-slate-100">Agent Vault</h2>
              </div>

              {isConfirmed && (
                <div className="mb-5 flex items-center gap-2 border border-emerald-500/50 bg-emerald-950/20 px-3 py-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                  <p className="text-xs uppercase tracking-[0.16em] text-emerald-300">
                    Deposit Confirmed // Agent Access Unlocked
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "syncing" && (
                <div className="mb-5 flex items-center gap-2 border border-cyan-500/40 bg-cyan-950/20 px-3 py-2">
                  <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                  <p className="text-xs uppercase tracking-[0.16em] text-cyan-300">
                    Syncing Payment Ledger...
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "synced" && (
                <div className="mb-5 flex items-center gap-2 border border-cyan-500/40 bg-cyan-950/20 px-3 py-2">
                  <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                  <p className="text-xs uppercase tracking-[0.16em] text-cyan-300">
                    Credits Synced // Available Credits: {syncedCredits ?? "--"}
                  </p>
                </div>
              )}

              {isConfirmed && creditSyncState === "error" && (
                <div className="mb-5 flex flex-col gap-2 border border-yellow-500/40 bg-yellow-950/20 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.16em] text-yellow-300">
                    Credit Sync Failed // {creditSyncError ?? "Unable to refresh access credits."}
                  </p>
                  <button
                    type="button"
                    onClick={handleRetryCreditSync}
                    className="inline-flex w-fit items-center justify-center border border-yellow-500/40 bg-slate-900 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-yellow-300 transition hover:bg-slate-800"
                  >
                    Retry Sync
                  </button>
                </div>
              )}

              <div className="mb-5 border border-slate-800 bg-slate-950 p-4">
                <p className="mb-1 text-xs uppercase tracking-[0.16em] text-slate-400">Vault Revenue (ETH)</p>
                <p className="text-3xl text-emerald-400">
                  {isConnected
                    ? isBalancePending
                      ? "..."
                      : formattedVaultBalance
                    : "0.0000 ETH"}
                </p>
              </div>

              <div className="mb-5 border border-slate-800 bg-slate-950 p-4">
                <p className="mb-1 text-xs uppercase tracking-[0.16em] text-slate-400">Your Available Credits</p>
                <p className="text-2xl text-cyan-300">{isConnected ? syncedCredits ?? "0" : "0"}</p>
              </div>

              <div className="mb-5 border border-slate-800 bg-slate-950 p-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Target Agent Wallet</p>
                <p className="mt-1 break-all text-sm text-cyan-300">{targetAgentAddress}</p>
                {usesFallbackAgentAddress && (
                  <p className="mt-1 text-xs text-slate-500">
                    No agent wallet found in page context. Using protocol treasury fallback for testing.
                  </p>
                )}
              </div>

              <div className="space-y-4">
                <label className="block text-xs uppercase tracking-[0.16em] text-slate-400">
                  Deposit ETH
                  <input
                    value={ethAmount}
                    onChange={(event) => setEthAmount(event.target.value)}
                    inputMode="decimal"
                    placeholder="0.01"
                    className="mt-2 w-full border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-cyan-500 rounded-none"
                  />
                </label>

                <div className="border border-slate-800 bg-slate-950 p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Estimated Access Credits</p>
                  <p className="text-lg text-emerald-400">{estimatedCredits == null ? "--" : estimatedCredits.toString()}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Price per credit: {formatEther(CREDIT_PRICE_WEI)} ETH
                  </p>
                </div>

                {isConnected && !isOnSupportedChain && (
                  <div className="border border-yellow-500/50 bg-yellow-950/20 p-3">
                    <p className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-yellow-500">
                      <AlertTriangle className="h-4 w-4" />
                      NETWORK MISMATCH // INITIALIZING SWITCH PROTOCOL
                    </p>
                    <button
                      type="button"
                      onClick={handleSwitchToPreferredChain}
                      disabled={isSwitchingChain}
                      className="mt-3 inline-flex items-center gap-2 border border-yellow-500/40 bg-slate-900 px-4 py-2 text-xs uppercase tracking-wider text-yellow-400 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSwitchingChain ? "Switching..." : "Switch to Base Mainnet"}
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handlePurchase}
                  disabled={!canPurchase}
                  className="w-full border border-slate-600 bg-slate-800 px-4 py-2 text-sm uppercase tracking-wider text-cyan-400 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                  <p className="text-xs text-cyan-400">{getErrorMessage(writeError, "Transaction failed.")}</p>
                )}
                {readError && (
                  <p className="text-xs text-cyan-400">{getErrorMessage(readError, "Failed to read vault balance.")}</p>
                )}
                {switchError && <p className="text-xs text-cyan-400">{switchError}</p>}
              </div>
            </article>

            <article className="bg-slate-900 border border-slate-800 rounded-none p-5">
              <div className="mb-5 flex items-center gap-3">
                <Code className="h-5 w-5 text-cyan-400" />
                <h2 className="text-sm uppercase tracking-[0.18em] text-slate-100">API ACCESS // CONSUMER MODE</h2>
              </div>

              <div className="border border-slate-800 bg-slate-950 p-4">
                <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-400">Usage Example</p>
                <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-cyan-400">
                  <code>{consumerUsageExample}</code>
                </pre>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className="mt-4 inline-flex items-center gap-2 border border-slate-600 bg-slate-800 px-4 py-2 text-xs uppercase tracking-wider text-cyan-400 transition hover:bg-slate-700"
              >
                <Copy className="h-4 w-4" />
                {copyState === "copied" ? "Copied" : "Copy Example"}
              </button>

              {copyState === "error" && (
                <p className="mt-2 text-xs text-cyan-400">Clipboard permission blocked. Copy manually.</p>
              )}

              <div className="mt-5 border border-slate-800 bg-slate-950 p-4">
                <p className="text-sm text-slate-400">
                  The Python SDK automatically routes verification requests to{" "}
                  <span className="text-cyan-300">https://ghost-rank.vercel.app/api/gate/&lt;your-service-name&gt;.</span>{" "}
                  <span className="text-cyan-300">1 Request = 1 Credit.</span>
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
    <Suspense fallback={<main className="min-h-screen bg-slate-950 font-mono text-slate-400" />}>
      <DashboardPageContent />
    </Suspense>
  );
}
