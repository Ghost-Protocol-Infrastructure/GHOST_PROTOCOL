"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Copy } from "lucide-react";
import Navbar from "@/components/Navbar";
import { isClaimedAgent } from "@/lib/agent-claim";

type Network = "MEGAETH" | "BASE";
type LeadTier = "WHALE" | "ACTIVE" | "NEW" | "GHOST";
type SyncHealth = "live" | "stale" | "offline" | "unknown";

type ApiAgent = {
  address: string;
  agentId?: string;
  name: string;
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
  if (syncAgeSeconds > 60 * 60) return "stale";
  return "live";
};

const getBaseNetworkStatusDisplay = (syncHealth: SyncHealth): NetworkStatusDisplay => {
  switch (syncHealth) {
    case "live":
      return {
        label: "live_on_base",
        description: "Systems nominal. Real-time data.",
        textClassName: "text-cyan-300",
        descriptionClassName: "text-emerald-300/90",
        pingClassName: "bg-emerald-400",
        dotClassName: "bg-emerald-500",
        dotShadowClassName: "shadow-[0_0_10px_#34d399]",
        showPing: true,
      };
    case "stale":
      return {
        label: "sync_lag",
        description: "Indexer is behind by 1+ hours.",
        textClassName: "text-amber-300",
        descriptionClassName: "text-amber-300/90",
        pingClassName: "bg-amber-300",
        dotClassName: "bg-amber-400",
        dotShadowClassName: "shadow-[0_0_10px_rgba(251,191,36,0.75)]",
        showPing: true,
      };
    case "offline":
      return {
        label: "signal_lost",
        description: "Indexer is down",
        textClassName: "text-rose-300",
        descriptionClassName: "text-rose-300/90",
        pingClassName: "bg-rose-300",
        dotClassName: "bg-rose-500",
        dotShadowClassName: "shadow-[0_0_10px_rgba(244,63,94,0.75)]",
        showPing: true,
      };
    default:
      return {
        label: "sync_status_unknown",
        description: "Unable to verify indexer health.",
        textClassName: "text-slate-400",
        descriptionClassName: "text-slate-500",
        pingClassName: "bg-slate-500",
        dotClassName: "bg-slate-500",
        dotShadowClassName: "shadow-[0_0_10px_rgba(100,116,139,0.65)]",
        showPing: false,
      };
  }
};

const MEGAETH_STATUS_DISPLAY: NetworkStatusDisplay = {
  label: "wip_no_verified_data",
  description: "MegaETH telemetry is not verified yet.",
  textClassName: "text-fuchsia-300",
  descriptionClassName: "text-fuchsia-300/85",
  pingClassName: "bg-fuchsia-400",
  dotClassName: "bg-fuchsia-500",
  dotShadowClassName: "shadow-[0_0_10px_rgba(232,121,249,0.75)]",
  showPing: true,
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

export default function Home() {
  const [network, setNetwork] = useState<Network>("BASE");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedOwner, setCopiedOwner] = useState<string | null>(null);
  const [baseLeads, setBaseLeads] = useState<ProcessedLead[]>([]);
  const [totalAgentsCount, setTotalAgentsCount] = useState<number>(0);
  const [lastSyncedBlock, setLastSyncedBlock] = useState<string | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealth>("unknown");
  const [isLoadingLeads, setIsLoadingLeads] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { address: userAddress } = useAccount();
  const router = useRouter();
  const networkSelectValue = network === "BASE" ? "base" : "megaeth";

  useEffect(() => {
    let isActive = true;

    const loadLeads = async () => {
      try {
        const response = await fetch("/api/agents?limit=1000", {
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

        if (!isActive) return;
        const parsedSyncAgeSeconds = parseSyncAgeSeconds(payload.syncAgeSeconds);
        setBaseLeads(buildLeadsFromApi(agents));
        setTotalAgentsCount(Math.max(0, Math.trunc(totalAgents)));
        setLastSyncedBlock(payload.lastSyncedBlock ?? null);
        setSyncHealth(resolveSyncHealth(payload.syncHealth, parsedSyncAgeSeconds));
        setLoadError(null);
      } catch (error) {
        if (!isActive) return;

        const message = error instanceof Error ? error.message : "Failed to load live leaderboard data.";
        setLoadError(message);
        setBaseLeads([]);
        setTotalAgentsCount(0);
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
  }, []);

  const filteredAgents = useMemo(() => {
    const source = network === "BASE" ? baseLeads : [];
    if (!searchQuery.trim()) return source;

    const query = searchQuery.toLowerCase().trim();
    return source.filter(
      (lead) =>
        lead.agentId.toLowerCase().includes(query) ||
        lead.displayName.toLowerCase().includes(query) ||
        lead.owner.toLowerCase().includes(query),
    );
  }, [baseLeads, network, searchQuery]);

  const rankedAgents = useMemo(
    () =>
      filteredAgents.map((agent, index) => ({
        ...agent,
        rank: index + 1,
      })),
    [filteredAgents],
  );

  const claimedCount = useMemo(() => baseLeads.filter((agent) => agent.isClaimed).length, [baseLeads]);
  const networkStatusDisplay =
    network === "MEGAETH" ? MEGAETH_STATUS_DISPLAY : getBaseNetworkStatusDisplay(syncHealth);

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

  return (
    <main className="min-h-screen bg-slate-950 p-8 max-w-7xl mx-auto space-y-8 mb-20 relative z-[50] font-mono text-slate-300">
      <Navbar />

      <section className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full max-w-xs">
          <select
            value={networkSelectValue}
            onChange={(event) => setNetwork(event.target.value === "base" ? "BASE" : "MEGAETH")}
            className="w-full appearance-none border border-slate-700 bg-slate-900 py-2 pl-3 pr-8 text-xs font-mono uppercase tracking-[0.14em] text-slate-300 outline-none transition focus:border-cyan-400 focus:shadow-[0_0_12px_rgba(34,211,238,0.25)]"
            aria-label="Select network"
          >
            <option value="base">BASE (LIVE)</option>
            <option value="megaeth">MEGAETH (WIP)</option>
          </select>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-slate-500">
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
              <path
                d="M5.25 7.75L10 12.5l4.75-4.75"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="search_agent_id_or_owner..."
          className="w-full max-w-sm border border-slate-700 bg-slate-900 px-3 py-2 text-xs tracking-[0.14em] text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
        />
      </section>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//total_agents"}</span>
          </div>
          <div className="text-3xl text-white font-regular drop-shadow-[0_0_5px_rgba(255,255,255,0.3)]">
            {network === "BASE" ? (isLoadingLeads ? "--" : totalAgentsCount) : 0}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//network_status"}</span>
          </div>
          <div className="text-sm font-regular flex flex-col items-start gap-1">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {networkStatusDisplay.showPing ? (
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${networkStatusDisplay.pingClassName} opacity-75 will-change-[transform,opacity]`}
                  ></span>
                ) : null}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${networkStatusDisplay.dotClassName} ${networkStatusDisplay.dotShadowClassName}`}
                ></span>
              </span>
              <span className={networkStatusDisplay.textClassName}>[{networkStatusDisplay.label}]</span>
            </div>
            <p className={`text-[11px] leading-tight ${networkStatusDisplay.descriptionClassName}`}>
              {networkStatusDisplay.description}
            </p>
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//sync_height"}</span>
          </div>
          <div className="text-3xl text-white font-regular drop-shadow-[0_0_5px_rgba(255,255,255,0.3)]">
            {network === "BASE" ? (isLoadingLeads ? "--" : formatBlockHeight(lastSyncedBlock)) : "--"}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/20" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//claimed_agents"}</span>
          </div>
          <div className="text-sm text-cyan-300">
            {network === "BASE" ? (isLoadingLeads ? "--/--" : `${claimedCount}/${totalAgentsCount}`) : "--"}
          </div>
        </div>
      </div>

      <section className="relative bg-slate-950/80 backdrop-blur-md border border-cyan-500/30 rounded-lg overflow-hidden shadow-[0_0_40px_-10px_rgba(34,211,238,0.25)]">
        <div className="h-1 w-full bg-gradient-to-r from-cyan-600 via-sky-500 to-cyan-600 opacity-50"></div>
        <div className="grid grid-cols-12 gap-0 border-b border-cyan-500/30 bg-cyan-950/10 text-xs uppercase tracking-wider text-slate-400">
          <div className="col-span-1 py-3 px-4 border-r border-cyan-500/20">RANK</div>
          <div className="col-span-3 py-3 px-4 border-r border-cyan-500/20">AGENT</div>
          <div className="col-span-1 py-3 px-4 border-r border-cyan-500/20 text-right">TXS</div>
          <div className="col-span-2 py-3 px-4 border-r border-cyan-500/20 text-right">REPUTATION</div>
          <div className="col-span-2 py-3 px-4 border-r border-cyan-500/20 text-right">YIELD</div>
          <div className="col-span-1 py-3 px-4 border-r border-cyan-500/20 text-right">UPTIME</div>
          <div className="col-span-2 py-3 px-4 text-right">ACTION</div>
        </div>

        {network !== "BASE" ? (
          <div className="py-16 text-center text-xs uppercase tracking-[0.16em] text-slate-600">
            MegaETH telemetry is not verified yet. Switch to BASE (LIVE).
          </div>
        ) : isLoadingLeads ? (
          <div className="py-16 text-center text-xs uppercase tracking-[0.16em] text-slate-600">
            Loading live agents from Postgres...
          </div>
        ) : loadError ? (
          <div className="py-16 text-center text-xs uppercase tracking-[0.16em] text-rose-400">
            Live data fetch failed: {loadError}
          </div>
        ) : (
          <div className="divide-y divide-cyan-500/10">
            {rankedAgents.map((agent) => {
              const isOwner = userAddress?.toLowerCase() === agent.owner.toLowerCase();
              const safeYieldEth = agent.isClaimed ? Math.max(0, agent.yieldEth ?? 0) : 0;
              const safeUptimePct = agent.isClaimed ? clamp(agent.uptimePct ?? 0, 0, 100) : 0;
              const showYieldZeroState = agent.isClaimed && safeYieldEth === 0;
              const showUptimeZeroState = agent.isClaimed && safeUptimePct === 0;
              const yieldClassName = !agent.isClaimed
                ? "text-slate-600"
                : showYieldZeroState
                  ? "text-slate-400"
                  : "text-emerald-300";
              const uptimeClassName = !agent.isClaimed
                ? "text-slate-600"
                : showUptimeZeroState
                  ? "text-slate-400"
                  : "text-cyan-300";

              return (
                <div
                  key={`${agent.agentId}-${agent.owner}`}
                  className="grid grid-cols-12 gap-0 items-center border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <div className="col-span-1 py-3 px-4 border-r border-cyan-500/10 text-slate-300">{agent.rank}</div>
                  <div className="col-span-3 py-3 px-4 border-r border-cyan-500/10">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-100">#{agent.agentId}</span>
                      <span className={`inline-flex border px-2 py-1 text-[11px] tracking-wider ${tierClassName[agent.tier]}`}>
                        {agent.tier}
                      </span>
                      {agent.isClaimed && (
                        <span className="inline-flex shrink-0 items-center border border-emerald-400/50 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300 whitespace-nowrap">
                          RESERVED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-slate-600">{agent.displayName}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      <span title={agent.owner}>{truncateAddress(agent.owner)}</span>
                      <button
                        type="button"
                        onClick={() => handleCopyOwner(agent.owner)}
                        className="inline-flex items-center justify-center border border-slate-700 px-1.5 py-1 text-slate-400 transition hover:border-cyan-500/50 hover:text-cyan-300"
                        aria-label={`Copy ${agent.owner}`}
                        title={copiedOwner === agent.owner ? "Copied" : "Copy full address"}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="col-span-1 py-3 px-4 border-r border-cyan-500/10 text-right text-slate-300">{agent.txCount}</div>
                  <div className={`col-span-2 py-3 px-4 border-r border-cyan-500/10 text-right ${reputationColor(agent.reputationScore)}`}>
                    {formatReputation(agent.reputationScore)}
                  </div>
                  <div className={`col-span-2 py-3 px-4 border-r border-cyan-500/10 text-right ${yieldClassName}`}>
                    {agent.isClaimed ? formatYield(safeYieldEth) : "---"}
                  </div>
                  <div className={`col-span-1 py-3 px-4 border-r border-cyan-500/10 text-right ${uptimeClassName}`}>
                    {agent.isClaimed ? formatUptime(safeUptimePct) : "---"}
                  </div>
                  <div className="col-span-2 py-3 px-4 text-right">
                    {!userAddress ? (
                      <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                        CONNECT WALLET FOR ACCESS
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleOpenDashboard(isOwner ? "merchant" : "consumer", agent.agentId, agent.owner)}
                        className={`inline-flex min-w-[132px] items-center justify-center px-3 py-2 text-xs uppercase tracking-[0.12em] font-mono border transition ${
                          isOwner
                            ? "bg-emerald-500 text-black border-emerald-400/40 hover:bg-emerald-400"
                            : "text-cyan-400 border-cyan-400/20 hover:bg-cyan-400/10"
                        }`}
                      >
                        {isOwner ? "ACTIVATE" : "ACCESS"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {rankedAgents.length === 0 && (
              <div className="py-16 text-center text-xs uppercase tracking-[0.16em] text-slate-600">No agents match your filter.</div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
