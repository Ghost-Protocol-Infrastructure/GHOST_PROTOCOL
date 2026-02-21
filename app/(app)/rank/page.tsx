"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useAccount } from "wagmi";
import { Bot, Copy, Crown } from "lucide-react";
import Navbar from "@/components/Navbar";
import { isClaimedAgent } from "@/lib/agent-claim";

type Network = "MEGAETH" | "BASE";
type LeadTier = "WHALE" | "ACTIVE" | "NEW" | "GHOST";
type SyncHealth = "live" | "stale" | "offline" | "unknown";
const STALE_SYNC_THRESHOLD_SECONDS = 3 * 60 * 60;

type ApiAgent = {
  address: string;
  agentId?: string;
  name: string;
  image?: string | null;
  creator: string;
  owner?: string;
  status: string;
  tier?: string;
  txCount?: number;
  reputation?: number;
  rankScore?: number;
  yield?: number;
  uptime?: number;
  volume: string;
  score: number;
};

type ProcessedLead = {
  agentId: string;
  displayName: string;
  imageUrl: string | null;
  owner: string;
  tier: LeadTier;
  txCount: number;
  velocity: number;
  isClaimed: boolean;
  reputationScore: number;
  rankScore: number;
  yieldEth: number | null;
  uptimePct: number | null;
};

type AgentApiResponse = {
  agents: ApiAgent[];
  totalAgents?: number;
  activatedAgents?: number;
  filteredTotal?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  lastSyncedBlock?: string | null;
  syncHealth?: string | null;
  syncAgeSeconds?: number | null;
  lastSyncedAt?: string | null;
};

type NetworkStatusDisplay = {
  label: string;
  description: string;
  textClassName: string;
  descriptionClassName: string;
  pingClassName: string;
  dotClassName: string;
  dotShadowClassName: string;
  showPing: boolean;
};

const truncateAddress = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const resolveAgentImageUrl = (raw: string | null | undefined): string | null => {
  const image = raw?.trim();
  if (!image) return null;
  if (image.startsWith("data:image/")) return image;
  if (image.startsWith("<svg")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(image)}`;
  }
  if (image.startsWith("ipfs://ipfs/")) {
    return `https://ipfs.io/ipfs/${image.slice("ipfs://ipfs/".length)}`;
  }
  if (image.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${image.slice("ipfs://".length)}`;
  }
  return image;
};

const normalizeTxScore = (txCount: number, maxTxCount: number): number => {
  if (maxTxCount <= 0) return 0;

  const numerator = Math.log10(txCount + 1);
  const denominator = Math.log10(maxTxCount + 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;

  return clamp(Math.round((numerator / denominator) * 100), 0, 100);
};

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

const formatYield = (yieldEth: number): string => `${yieldEth.toFixed(4)} ETH`;
const formatUptime = (uptimePct: number): string => `${uptimePct.toFixed(1)}%`;
const formatReputation = (score: number): string => (Number.isInteger(score) ? String(score) : score.toFixed(2));
const formatBlockHeight = (rawBlock: string | null): string => {
  if (!rawBlock || !/^\d+$/.test(rawBlock)) return "--";
  return rawBlock.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const isHexAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);

const parseSyncAgeSeconds = (raw: number | null | undefined): number | null => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.trunc(raw));
};

const resolveSyncHealth = (rawSyncHealth: string | null | undefined, syncAgeSeconds: number | null): SyncHealth => {
  if (rawSyncHealth === "live" || rawSyncHealth === "stale" || rawSyncHealth === "offline" || rawSyncHealth === "unknown") {
    return rawSyncHealth;
  }

  if (syncAgeSeconds == null) return "unknown";
  if (syncAgeSeconds > 24 * 60 * 60) return "offline";
  if (syncAgeSeconds > STALE_SYNC_THRESHOLD_SECONDS) return "stale";
  return "live";
};

const getBaseNetworkStatusDisplay = (syncHealth: SyncHealth): NetworkStatusDisplay => {
  switch (syncHealth) {
    case "live":
      return {
        label: "LIVE_ON_BASE",
        description: "Systems nominal, real-time data",
        textClassName: "text-neutral-300",
        descriptionClassName: "text-neutral-500",
        pingClassName: "bg-red-500",
        dotClassName: "bg-red-600",
        dotShadowClassName: "shadow-none",
        showPing: true,
      };
    case "stale":
      return {
        label: "SYNC_LAG",
        description: "Indexer is behind by several hours...",
        textClassName: "text-yellow-500",
        descriptionClassName: "text-yellow-500/90",
        pingClassName: "bg-yellow-500",
        dotClassName: "bg-yellow-600",
        dotShadowClassName: "shadow-none",
        showPing: true,
      };
    case "offline":
      return {
        label: "LOST_SIGNAL",
        description: "Indexer is down",
        textClassName: "text-red-500",
        descriptionClassName: "text-red-500/90",
        pingClassName: "bg-red-500",
        dotClassName: "bg-red-600",
        dotShadowClassName: "shadow-none",
        showPing: true,
      };
    default:
      return {
        label: "SYNC_UNKNOWN",
        description: "Unable to verify indexer health",
        textClassName: "text-neutral-600",
        descriptionClassName: "text-neutral-700",
        pingClassName: "bg-neutral-700",
        dotClassName: "bg-neutral-800",
        dotShadowClassName: "shadow-none",
        showPing: false,
      };
  }
};

const MEGAETH_STATUS_DISPLAY: NetworkStatusDisplay = {
  label: "MEGAETH_WIP",
  description: "MegaETH telemetry is not verified yet",
  textClassName: "text-neutral-500",
  descriptionClassName: "text-neutral-600",
  pingClassName: "bg-neutral-500",
  dotClassName: "bg-neutral-600",
  dotShadowClassName: "shadow-none",
  showPing: false,
};

const parseTxCount = (rawVolume: string): number => {
  const parsed = Number.parseInt(rawVolume, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
};

const deriveAgentId = (agent: ApiAgent): string => {
  if (agent.agentId?.trim()) return agent.agentId.trim();

  const fromAddress = agent.address.match(/(?:service|agent)[:_-](\d+)/i)?.[1];
  if (fromAddress) return fromAddress;

  const fromName = agent.name.match(/(?:agent|service)\s*#?\s*(\d+)/i)?.[1];
  if (fromName) return fromName;

  if (isHexAddress(agent.address)) return agent.address.slice(2, 8).toUpperCase();
  return agent.name.trim().slice(0, 12).toUpperCase() || "UNKNOWN";
};

const normalizeDisplayName = (agent: ApiAgent, agentId: string): string => {
  const clean = agent.name.trim();
  return clean.length > 0 ? clean : `Agent #${agentId}`;
};

const getLeadTier = (txCount: number, isClaimed: boolean): LeadTier => {
  if (!isClaimed && txCount <= 0) return "GHOST";
  if (txCount > 500) return "WHALE";
  if (txCount > 50) return "ACTIVE";
  return "NEW";
};

const parseTier = (tier: string | undefined, txCount: number, isClaimed: boolean): LeadTier => {
  if (tier === "WHALE" || tier === "ACTIVE" || tier === "NEW" || tier === "GHOST") return tier;
  return getLeadTier(txCount, isClaimed);
};

const buildLeadsFromApi = (agents: ApiAgent[]): ProcessedLead[] => {
  const maxTxCount = Math.max(
    0,
    ...agents.map((agent) =>
      typeof agent.txCount === "number" && Number.isFinite(agent.txCount) ? Math.max(0, Math.trunc(agent.txCount)) : parseTxCount(agent.volume),
    ),
  );

  const seeded: ProcessedLead[] = agents.map((agent) => {
    const txCount =
      typeof agent.txCount === "number" && Number.isFinite(agent.txCount)
        ? Math.max(0, Math.trunc(agent.txCount))
        : parseTxCount(agent.volume);
    const velocity = normalizeTxScore(txCount, maxTxCount);
    const rawReputation =
      typeof agent.reputation === "number" && Number.isFinite(agent.reputation)
        ? clamp(agent.reputation, 0, 100)
        : typeof agent.score === "number" && Number.isFinite(agent.score)
          ? clamp(agent.score, 0, 100)
          : 0;
    const rawYield = typeof agent.yield === "number" && Number.isFinite(agent.yield) ? Math.max(0, agent.yield) : 0;
    const rawUptime = typeof agent.uptime === "number" && Number.isFinite(agent.uptime) ? clamp(agent.uptime, 0, 100) : 0;
    const isClaimed = isClaimedAgent({
      status: agent.status,
      tier: agent.tier,
      yieldValue: rawYield,
      uptimeValue: rawUptime,
    });
    const rankScore =
      typeof agent.rankScore === "number" && Number.isFinite(agent.rankScore)
        ? clamp(agent.rankScore, 0, 100)
        : roundToTwo(rawReputation * 0.7 + velocity * 0.3);
    const agentId = deriveAgentId(agent);
    const ownerSource = agent.owner ?? agent.creator;

    return {
      agentId,
      displayName: normalizeDisplayName(agent, agentId),
      imageUrl: resolveAgentImageUrl(agent.image),
      owner: isHexAddress(ownerSource) ? ownerSource.toLowerCase() : ownerSource,
      tier: parseTier(agent.tier, txCount, isClaimed),
      txCount,
      velocity,
      isClaimed,
      reputationScore: rawReputation,
      rankScore,
      yieldEth: isClaimed ? rawYield : null,
      uptimePct: isClaimed ? rawUptime : null,
    };
  });

  return seeded
    .sort((a, b) => b.rankScore - a.rankScore || b.reputationScore - a.reputationScore || b.txCount - a.txCount);
};

const tierClassName: Record<LeadTier, string> = {
  WHALE:
    "border-neon-purple border-violet-400 bg-emerald-500/20 text-emerald-300 animate-pulse shadow-[0_0_10px_rgba(139,92,246,0.5)]",
  ACTIVE: "border-amber-400/40 bg-amber-500/20 text-amber-300",
  NEW: "border-slate-500/40 bg-slate-500/20 text-slate-300",
  GHOST: "border-slate-700/60 bg-slate-800/40 text-slate-500",
};
const PAGE_SIZE = 250;
const SEARCH_DEBOUNCE_MS = 300;

export default function Home() {
  const [network, setNetwork] = useState<Network>("BASE");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageInput, setPageInput] = useState("1");
  const [copiedOwner, setCopiedOwner] = useState<string | null>(null);
  const [baseLeads, setBaseLeads] = useState<ProcessedLead[]>([]);
  const [totalAgentsCount, setTotalAgentsCount] = useState<number>(0);
  const [activatedAgentsCount, setActivatedAgentsCount] = useState<number>(0);
  const [filteredAgentsCount, setFilteredAgentsCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [lastSyncedBlock, setLastSyncedBlock] = useState<string | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealth>("unknown");
  const [isLoadingLeads, setIsLoadingLeads] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
  const { address: userAddress } = useAccount();
  const router = useRouter();
  const networkSelectValue = network === "BASE" ? "base" : "megaeth";

  useEffect(() => {
    const debounceHandle = window.setTimeout(() => {
      const normalized = searchInput.trim();
      setSearchQuery((previous) => (previous === normalized ? previous : normalized));
      setCurrentPage(1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounceHandle);
    };
  }, [searchInput]);

  useEffect(() => {
    let isActive = true;

    const loadLeads = async () => {
      setIsLoadingLeads(true);
      try {
        const params = new URLSearchParams({
          limit: PAGE_SIZE.toString(),
          page: currentPage.toString(),
        });
        if (searchQuery) {
          params.set("q", searchQuery);
        }

        const response = await fetch(`/api/agents?${params.toString()}`, {
          cache: "no-store",
          headers: {
            "cache-control": "no-cache",
          },
        });

        if (!response.ok) {
          throw new Error(`Agent API request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as AgentApiResponse;
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        const totalAgents =
          typeof payload.totalAgents === "number" && Number.isFinite(payload.totalAgents)
            ? payload.totalAgents
            : agents.length;
        const filteredTotal =
          typeof payload.filteredTotal === "number" && Number.isFinite(payload.filteredTotal)
            ? payload.filteredTotal
            : agents.length;
        const resolvedTotalPages =
          typeof payload.totalPages === "number" && Number.isFinite(payload.totalPages)
            ? payload.totalPages
            : Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
        const activatedAgents =
          typeof payload.activatedAgents === "number" && Number.isFinite(payload.activatedAgents)
            ? Math.max(0, Math.trunc(payload.activatedAgents))
            : 0;

        if (!isActive) return;
        if (currentPage > resolvedTotalPages) {
          setCurrentPage(resolvedTotalPages);
          return;
        }
        const parsedSyncAgeSeconds = parseSyncAgeSeconds(payload.syncAgeSeconds);
        setBaseLeads(buildLeadsFromApi(agents));
        setTotalAgentsCount(Math.max(0, Math.trunc(totalAgents)));
        setActivatedAgentsCount(activatedAgents);
        setFilteredAgentsCount(Math.max(0, Math.trunc(filteredTotal)));
        setTotalPages(Math.max(1, Math.trunc(resolvedTotalPages)));
        setLastSyncedBlock(payload.lastSyncedBlock ?? null);
        setSyncHealth(resolveSyncHealth(payload.syncHealth, parsedSyncAgeSeconds));
        setLoadError(null);
      } catch (error) {
        if (!isActive) return;

        const message = error instanceof Error ? error.message : "Failed to load live leaderboard data.";
        setLoadError(message);
        setBaseLeads([]);
        setTotalAgentsCount(0);
        setActivatedAgentsCount(0);
        setFilteredAgentsCount(0);
        setTotalPages(1);
        setLastSyncedBlock(null);
        setSyncHealth("unknown");
      } finally {
        if (isActive) setIsLoadingLeads(false);
      }
    };

    void loadLeads();
    const refreshHandle = window.setInterval(() => {
      void loadLeads();
    }, 60_000);

    return () => {
      isActive = false;
      window.clearInterval(refreshHandle);
    };
  }, [currentPage, searchQuery]);

  const rankedAgents = useMemo(() => {
    const source = network === "BASE" ? baseLeads : [];
    const rankOffset = (currentPage - 1) * PAGE_SIZE;
    return source.map((agent, index) => ({
      ...agent,
      rank: rankOffset + index + 1,
    }));
  }, [baseLeads, network, currentPage]);

  const networkStatusDisplay =
    network === "MEGAETH" ? MEGAETH_STATUS_DISPLAY : getBaseNetworkStatusDisplay(syncHealth);
  const canGoPrev = currentPage > 1;
  const canGoNext = currentPage < totalPages;
  const visibleStart = filteredAgentsCount === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const visibleEnd = filteredAgentsCount === 0 ? 0 : Math.min(currentPage * PAGE_SIZE, filteredAgentsCount);
  const isPagerDisabled = network !== "BASE" || isLoadingLeads;

  const reputationColor = (score: number): string => {
    if (score >= 80) return "text-emerald-300";
    if (score >= 50) return "text-amber-300";
    return "text-slate-400";
  };

  const handleOpenDashboard = (mode: "merchant" | "consumer", agentId: string, owner: string) => {
    const params = new URLSearchParams({ mode, agentId, owner });
    router.push(`/dashboard?${params.toString()}`);
  };

  useEffect(() => {
    if (!copiedOwner) return;
    const timeout = setTimeout(() => setCopiedOwner(null), 1400);
    return () => clearTimeout(timeout);
  }, [copiedOwner]);

  const handleCopyOwner = async (owner: string) => {
    try {
      await navigator.clipboard.writeText(owner);
      setCopiedOwner(owner);
    } catch {
      setCopiedOwner(null);
    }
  };

  const markAvatarBroken = (key: string) => {
    setBrokenAvatars((previous) => {
      if (previous.has(key)) return previous;
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  };

  useEffect(() => {
    setPageInput(currentPage.toString());
  }, [currentPage]);

  const submitPageJump = () => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(currentPage.toString());
      return;
    }

    const clampedPage = Math.max(1, Math.min(totalPages, parsed));
    setCurrentPage(clampedPage);
    setPageInput(clampedPage.toString());
  };

  return (
    <>
      <main className="min-h-screen p-8 pb-20 max-w-7xl mx-auto space-y-12 relative z-[50] font-mono text-neutral-400 bg-neutral-950 [background-image:none] border-l border-r border-neutral-900">
      <Navbar />

      <section className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-neutral-800 pb-8">
        <div className="relative w-full max-w-xs group">
          <select
            value={networkSelectValue}
            onChange={(event) => setNetwork(event.target.value === "base" ? "BASE" : "MEGAETH")}
            className="w-full appearance-none border border-neutral-800 bg-neutral-950 py-3 pl-4 pr-10 text-xs font-bold uppercase tracking-widest text-neutral-300 outline-none transition-all hover:border-neutral-600 focus:border-red-600 rounded-none"
            aria-label="Select network"
          >
            <option value="base">BASE_MAINNET</option>
            <option value="megaeth">MEGAETH_TESTNET</option>
          </select>
          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-neutral-500 group-hover:text-neutral-300 transition-colors">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2">
              <path d="M19 9l-7 7-7-7" strokeLinecap="square" strokeLinejoin="miter" />
            </svg>
          </span>
        </div>

        <input
          type="text"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="SEARCH_AGENT_ID_OR_NAME..."
          className="w-full md:flex-1 border border-neutral-800 bg-neutral-950 px-4 py-3 text-xs font-bold tracking-widest text-neutral-300 placeholder:text-neutral-700 focus:outline-none focus:border-red-600 transition-all rounded-none uppercase"
        />
      </section>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-0 border border-neutral-800 bg-neutral-950 text-neutral-400">
        <div className="p-6 border-r border-neutral-800 group hover:bg-neutral-900/30 transition-colors">
          <div className="mb-4 text-xs tracking-widest uppercase text-neutral-600 font-bold">Total Agents</div>
          <div className="text-3xl text-neutral-100 font-bold">
            {network === "BASE" ? (isLoadingLeads ? "--" : totalAgentsCount) : 0}
          </div>
        </div>
        <div className="p-6 border-r border-neutral-800 group hover:bg-neutral-900/30 transition-colors">
          <div className="mb-4 text-xs tracking-widest uppercase text-neutral-600 font-bold">Network Status</div>
          <div className="text-sm font-bold flex flex-col items-start gap-1">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {networkStatusDisplay.showPing ? (
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${networkStatusDisplay.pingClassName} opacity-75`}
                  ></span>
                ) : null}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${networkStatusDisplay.dotClassName}`}
                ></span>
              </span>
              <span className={networkStatusDisplay.textClassName}>{networkStatusDisplay.label}</span>
            </div>
            <p className={`text-[11px] leading-tight font-normal ${networkStatusDisplay.descriptionClassName}`}>
              {networkStatusDisplay.description}
            </p>
          </div>
        </div>
        <div className="p-6 border-r border-neutral-800 group hover:bg-neutral-900/30 transition-colors">
          <div className="mb-4 text-xs tracking-widest uppercase text-neutral-600 font-bold">Sync Height</div>
          <div className="text-3xl text-neutral-100 font-bold">
            {network === "BASE" ? (isLoadingLeads ? "--" : formatBlockHeight(lastSyncedBlock)) : "--"}
          </div>
        </div>
        <div className="p-6 group hover:bg-neutral-900/30 transition-colors">
          <div className="mb-4 text-xs tracking-widest uppercase text-neutral-600 font-bold">Activated Agents</div>
          <div className="text-xl text-neutral-100 font-bold">
            {network === "BASE" ? (isLoadingLeads ? "--/--" : `${activatedAgentsCount}/${totalAgentsCount}`) : "--"}
          </div>
        </div>
      </div>

      <section className="relative border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-3 text-xs uppercase tracking-widest">
          <div className="text-neutral-600">
            Showing {visibleStart}-{visibleEnd} of {filteredAgentsCount}
            {searchQuery ? " (filtered)" : ""}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-neutral-500">
              Page {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((previous) => Math.max(1, previous - 1))}
              disabled={!canGoPrev || isPagerDisabled}
              className="inline-flex h-8 w-8 items-center justify-center border border-neutral-800 text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Previous page"
            >
              {"<"}
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage((previous) => Math.min(totalPages, previous + 1))}
              disabled={!canGoNext || isPagerDisabled}
              className="inline-flex h-8 w-8 items-center justify-center border border-neutral-800 text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Next page"
            >
              {">"}
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(event) => {
                const next = event.target.value;
                if (/^\d*$/.test(next)) {
                  setPageInput(next);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitPageJump();
                }
              }}
              disabled={isPagerDisabled}
              className="h-8 w-16 border border-neutral-800 bg-neutral-950 px-2 text-center text-xs text-neutral-300 outline-none transition focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Page number"
            />
            <button
              type="button"
              onClick={submitPageJump}
              disabled={isPagerDisabled}
              className="inline-flex h-8 items-center justify-center border border-neutral-800 px-3 text-[10px] text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Go to page"
            >
              GO
            </button>
          </div>
        </div>

        <div className="max-h-[1000px] overflow-y-auto">
          <div className="sticky top-0 z-10 grid grid-cols-12 gap-0 border-b border-neutral-800 bg-neutral-950 text-xs uppercase tracking-widest text-neutral-600 font-bold">
            <div className="col-span-1 py-4 px-6 border-r border-neutral-800">RANK</div>
            <div className="col-span-3 py-4 px-6">AGENT</div>
            <div className="col-span-1 py-4 px-6 border-l border-r border-neutral-800 text-right">TXS</div>
            <div className="col-span-2 py-4 px-6 border-r border-neutral-800 text-right">REPUTATION</div>
            <div className="col-span-2 py-4 px-6 border-r border-neutral-800 text-right">YIELD</div>
            <div className="col-span-1 py-4 px-6 border-r border-neutral-800 text-right">UPTIME</div>
            <div className="col-span-2 py-4 px-6 text-right">ACTION</div>
          </div>

          {network !== "BASE" ? (
            <div className="py-24 text-center text-xs uppercase tracking-[0.2em] text-neutral-600">
              MegaETH telemetry is not verified yet. Switch to BASE (LIVE).
            </div>
          ) : isLoadingLeads ? (
            <div className="py-24 text-center text-xs uppercase tracking-[0.2em] text-neutral-600 animate-pulse">
              Loading live agents...
            </div>
          ) : loadError ? (
            <div className="py-24 text-center text-xs uppercase tracking-[0.2em] text-red-500">
              Live data fetch failed: {loadError}
            </div>
          ) : (
            <div className="divide-y divide-neutral-800">
              {rankedAgents.map((agent) => {
              const rowKey = `${agent.agentId}-${agent.owner}`;
              const isOwner = userAddress?.toLowerCase() === agent.owner.toLowerCase();
              const safeYieldEth = agent.isClaimed ? Math.max(0, agent.yieldEth ?? 0) : 0;
              const safeUptimePct = agent.isClaimed ? clamp(agent.uptimePct ?? 0, 0, 100) : 0;
              const showYieldZeroState = agent.isClaimed && safeYieldEth === 0;
              const showUptimeZeroState = agent.isClaimed && safeUptimePct === 0;
              const showAvatar = Boolean(agent.imageUrl) && !brokenAvatars.has(rowKey);
              const yieldClassName = !agent.isClaimed
                ? "text-neutral-600"
                : showYieldZeroState
                  ? "text-neutral-500"
                  : "text-neutral-300";
              const uptimeClassName = !agent.isClaimed
                ? "text-neutral-600"
                : showUptimeZeroState
                  ? "text-neutral-500"
                  : "text-neutral-300";
              const rankTextClassName =
                agent.rank === 1
                  ? "text-amber-300"
                  : agent.rank === 2
                    ? "text-slate-300"
                    : agent.rank === 3
                      ? "text-amber-600"
                      : "text-neutral-400";

                return (
                  <div
                    key={rowKey}
                    className="grid grid-cols-12 gap-0 items-center hover:bg-neutral-900/30 transition-colors group"
                  >
                  <div className={`col-span-1 py-3 px-6 border-r border-neutral-800 font-bold ${rankTextClassName}`}>
                    <div className="inline-flex items-center gap-1.5">
                      <span>{String(agent.rank).padStart(2, "0")}</span>
                      {agent.rank === 1 ? <Crown className="ml-1.5 h-5 w-5 text-amber-300" /> : null}
                    </div>
                  </div>
                  <div className="col-span-3 py-3 px-6">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-neutral-800 bg-neutral-900 text-xs font-bold text-neutral-400">
                        {showAvatar ? (
                          <Image
                            src={agent.imageUrl as string}
                            alt={`${agent.displayName} avatar`}
                            width={40}
                            height={40}
                            className="h-full w-full object-cover"
                            unoptimized
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={() => markAvatarBroken(rowKey)}
                          />
                        ) : (
                          <Bot className="h-5 w-5 text-neutral-500" aria-hidden="true" />
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-neutral-100 font-bold">{agent.displayName}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="inline-flex shrink-0 border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-500 font-bold">
                            #{agent.agentId}
                          </span>
                          <span className={`inline-flex border px-2 py-0.5 text-[10px] tracking-widest uppercase font-bold ${tierClassName[agent.tier]}`}>
                            {agent.tier}
                          </span>
                          {agent.isClaimed && (
                            <span className="inline-flex shrink-0 items-center border border-red-900/30 bg-red-950/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-red-600 whitespace-nowrap">
                              RESERVED
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-600 font-mono">
                          <span title={agent.owner}>{truncateAddress(agent.owner)}</span>
                          <button
                            type="button"
                            onClick={() => handleCopyOwner(agent.owner)}
                            className="inline-flex items-center justify-center border border-neutral-800 px-1 py-0.5 text-neutral-500 transition hover:border-neutral-600 hover:text-neutral-300"
                            aria-label={`Copy ${agent.owner}`}
                            title={copiedOwner === agent.owner ? "Copied" : "Copy full address"}
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="col-span-1 py-3 px-6 border-l border-r border-neutral-800 text-right text-neutral-400 font-mono">{agent.txCount}</div>
                  <div className={`col-span-2 py-3 px-6 border-r border-neutral-800 text-right font-mono ${reputationColor(agent.reputationScore)}`}>
                    {formatReputation(agent.reputationScore)}
                  </div>
                  <div className={`col-span-2 py-3 px-6 border-r border-neutral-800 text-right font-mono ${yieldClassName}`}>
                    {agent.isClaimed ? formatYield(safeYieldEth) : "---"}
                  </div>
                  <div className={`col-span-1 py-3 px-6 border-r border-neutral-800 text-right font-mono ${uptimeClassName}`}>
                    {agent.isClaimed ? formatUptime(safeUptimePct) : "---"}
                  </div>
                  <div className="col-span-2 py-3 px-6 text-right">
                    {!userAddress ? (
                      <span className="text-[10px] uppercase tracking-widest text-neutral-600 font-bold">
                        CONNECT_WALLET
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleOpenDashboard(isOwner ? "merchant" : "consumer", agent.agentId, agent.owner)}
                        className={`inline-flex min-w-[120px] items-center justify-center px-4 py-3 text-[10px] uppercase tracking-widest font-bold border transition-colors duration-200 ${isOwner
                          ? "bg-neutral-100 text-neutral-950 border-neutral-100 hover:bg-neutral-300 hover:border-neutral-300"
                          : "text-neutral-400 border-neutral-800 hover:text-neutral-100 hover:border-neutral-100"
                          }`}
                      >
                        {isOwner ? "MANAGE" : "ACCESS_TERMINAL"}
                      </button>
                    )}
                  </div>
                  </div>
                );
              })}

              {rankedAgents.length === 0 && (
                <div className="py-24 text-center text-xs uppercase tracking-[0.2em] text-neutral-600">No agents match your filter.</div>
              )}
            </div>
          )}
        </div>
      </section>
      </main>

      <footer className="border-t border-neutral-900 bg-neutral-950 py-12 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-end gap-8">
          <div>
            <div className="text-xs text-neutral-600 mb-4 font-bold tracking-widest">
              GHOST_PROTOCOL_INFRASTRUCTURE
            </div>
            <div className="text-[10px] text-neutral-700 max-w-sm leading-relaxed">
              Indexing ERC-8004 registries on Base. MegaETH expansion coming.
              <br />
              All systems nominal. No warranties implied.
              <br />
              © 2026 Ghost Protocol.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-12 text-xs tracking-wider uppercase">
            <div className="flex flex-col gap-3">
              <span className="text-neutral-500 font-bold mb-1">Network</span>
              <a href="#" className="hover:text-red-500 transition-colors">Base</a>
              <a href="#" className="hover:text-red-500 transition-colors">MegaETH</a>
            </div>
            <div className="flex flex-col gap-3">
              <span className="text-neutral-500 font-bold mb-1">Uplink</span>
              <a href="https://twitter.com/GhostProtocol_0" target="_blank" rel="noreferrer" className="hover:text-red-500 transition-colors">Twitter_X</a>
              <a href="https://github.com/Ghost-Protocol-Infrastructure" target="_blank" rel="noreferrer" className="hover:text-red-500 transition-colors">Github</a>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
