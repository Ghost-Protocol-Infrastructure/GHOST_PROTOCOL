"use client";

import { useEffect, useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Activity, CheckCircle2, Code, Copy, Wallet } from "lucide-react";
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatEther, parseEther, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { GHOST_CREDITS_ABI, GHOST_CREDITS_ADDRESS } from "@/lib/ghost-credits";

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const CREDIT_PRICE_WEI = parseEther("0.00001");
const SUPPORTED_CHAIN_IDS = new Set<number>([base.id, baseSepolia.id]);
const PREFERRED_CHAIN_ID = baseSepolia.id;

type CopyState = "idle" | "copied" | "error";

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

export default function DashboardPage() {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const { data: txHash, error: writeError, isPending: isWriting, writeContract } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const [ethAmount, setEthAmount] = useState("0.01");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [switchError, setSwitchError] = useState<string | null>(null);

  const amountWei = useMemo(() => parseInputWei(ethAmount), [ethAmount]);
  const estimatedCredits = useMemo(() => {
    if (amountWei == null) return null;
    return amountWei / CREDIT_PRICE_WEI;
  }, [amountWei]);

  const canQueryBalance = Boolean(isConnected && address);
  const isOnSupportedChain = chainId != null && SUPPORTED_CHAIN_IDS.has(chainId);
  const readChainId = chainId != null && SUPPORTED_CHAIN_IDS.has(chainId) ? chainId : PREFERRED_CHAIN_ID;

  const {
    data: creditBalance,
    error: readError,
    isPending: isBalancePending,
    refetch: refetchBalance,
  } = useReadContract({
    address: GHOST_CREDITS_ADDRESS,
    chainId: readChainId,
    abi: GHOST_CREDITS_ABI,
    functionName: "credits",
    args: [address ?? PLACEHOLDER_ADDRESS],
    query: {
      enabled: canQueryBalance,
    },
  });

  useEffect(() => {
    if (!isConfirmed) return;
    void refetchBalance();
  }, [isConfirmed, refetchBalance]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = setTimeout(() => setCopyState("idle"), 1600);
    return () => clearTimeout(timeout);
  }, [copyState]);

  const gatewayUrl = useMemo(() => {
    const userSegment = address ?? "[USER_ADDRESS]";
    return `https://ghost-rank.vercel.app/api/gate/${userSegment}/[SERVICE_SLUG]`;
  }, [address]);

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
      address: GHOST_CREDITS_ADDRESS,
      abi: GHOST_CREDITS_ABI,
      functionName: "buyCredits",
      value: amountWei,
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(gatewayUrl);
      setCopyState("copied");
    } catch {
      setCopyState("error");
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

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <article className="bg-slate-900 border border-slate-800 rounded-none p-5">
            <div className="mb-5 flex items-center gap-3">
              <Wallet className="h-5 w-5 text-emerald-400" />
              <h2 className="text-sm uppercase tracking-[0.18em] text-slate-100">Credit Balance</h2>
            </div>

            <div className="mb-5 border border-slate-800 bg-slate-950 p-4">
              <p className="mb-1 text-xs uppercase tracking-[0.16em] text-slate-400">Available Credits</p>
              <p className="text-3xl text-emerald-400">
                {isConnected
                  ? isBalancePending
                    ? "..."
                    : (creditBalance ?? 0n).toString()
                  : "0"}
              </p>
            </div>

            <div className="space-y-4">
              <label className="block text-xs uppercase tracking-[0.16em] text-slate-400">
                ETH Amount
                <input
                  value={ethAmount}
                  onChange={(event) => setEthAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="0.01"
                  className="mt-2 w-full border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-cyan-500 rounded-none"
                />
              </label>

              <div className="border border-slate-800 bg-slate-950 p-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Calculated Credits</p>
                <p className="text-lg text-emerald-400">{estimatedCredits == null ? "--" : estimatedCredits.toString()}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Price per credit: {formatEther(CREDIT_PRICE_WEI)} ETH
                </p>
              </div>

              {isConnected && !isOnSupportedChain && (
                <div className="border border-cyan-800 bg-slate-950 p-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-cyan-400">
                    Wrong network detected. Purchases execute on Base or Base Sepolia.
                  </p>
                  <button
                    type="button"
                    onClick={handleSwitchToPreferredChain}
                    disabled={isSwitchingChain}
                    className="mt-3 inline-flex items-center gap-2 border border-slate-600 bg-slate-800 px-4 py-2 text-xs uppercase tracking-wider text-cyan-400 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSwitchingChain ? "Switching..." : "Switch to Base Sepolia"}
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
                      : "Purchase"}
              </button>

              {isConfirmed && (
                <p className="flex items-center gap-2 text-xs text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Credits purchase confirmed on-chain.
                </p>
              )}

              {writeError && (
                <p className="text-xs text-cyan-400">{getErrorMessage(writeError, "Transaction failed.")}</p>
              )}
              {readError && (
                <p className="text-xs text-cyan-400">{getErrorMessage(readError, "Failed to read credits.")}</p>
              )}
              {switchError && <p className="text-xs text-cyan-400">{switchError}</p>}
            </div>
          </article>

          <article className="bg-slate-900 border border-slate-800 rounded-none p-5">
            <div className="mb-5 flex items-center gap-3">
              <Code className="h-5 w-5 text-cyan-400" />
              <h2 className="text-sm uppercase tracking-[0.18em] text-slate-100">Gateway Config</h2>
            </div>

            <div className="border border-slate-800 bg-slate-950 p-4">
              <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-400">Your Gateway URL</p>
              <code className="block break-all text-sm text-cyan-400">{gatewayUrl}</code>
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className="mt-4 inline-flex items-center gap-2 border border-slate-600 bg-slate-800 px-4 py-2 text-xs uppercase tracking-wider text-cyan-400 transition hover:bg-slate-700"
            >
              <Copy className="h-4 w-4" />
              {copyState === "copied" ? "Copied" : "Copy"}
            </button>

            {copyState === "error" && (
              <p className="mt-2 text-xs text-cyan-400">Clipboard permission blocked. Copy manually.</p>
            )}

            <div className="mt-5 border border-slate-800 bg-slate-950 p-4">
              <p className="text-sm text-slate-400">
                Use this URL to monetize your agent&apos;s data.{" "}
                <span className="text-emerald-400">1 Request = 1 Credit.</span>
              </p>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
