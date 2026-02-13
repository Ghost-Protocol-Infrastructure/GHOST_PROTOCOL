"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Check, Copy } from "lucide-react";
import Navbar from "@/components/Navbar";
import baseAgents from "../data/leads-scored.json";
import monitoredAgentIdsData from "../data/monitored-agents.json";

type Network = "MEGAETH" | "BASE";
type LeadTier = "WHALE" | "ACTIVE" | "NEW";

type BaseAgentLead = {
  agentId: string;
  owner: string;
  txCount?: number;
  transactionCount?: number;
  velocity?: number;
  reputation?: number;
  yield?: number | string | null;
  uptime?: number | string | null;
  claimed?: boolean;
  isClaimed?: boolean;
  monitored?: boolean;
  isMonitored?: boolean;
  tier: LeadTier;
};

type ProcessedLead = {
  agentId: string;
  owner: string;
  tier: LeadTier;
  txCount: number;
  isClaimed: boolean;
  reputationScore: number;
  yieldEth: number | null;
  uptimePct: number | null;
};

const leads = baseAgents as BaseAgentLead[];
const monitoredAgentIds = new Set(
  (Array.isArray(monitoredAgentIdsData) ? monitoredAgentIdsData : []).map((value) => String(value)),
);

const truncateAddress = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const parseYieldEth = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;

  const numeric = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const parseUptimePct = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return clamp(value, 0, 100);
  if (typeof value !== "string") return null;

  const numeric = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(numeric) ? clamp(numeric, 0, 100) : null;
};

const normalizeTxScore = (txCount: number, maxTxCount: number): number => {
  if (maxTxCount <= 0) return 0;

  const numerator = Math.log10(txCount + 1);
  const denominator = Math.log10(maxTxCount + 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;

  return clamp(Math.round((numerator / denominator) * 100), 0, 100);
};

const computeClaimedReputation = (
  txScore: number,
  uptimePct: number,
  yieldEth: number,
  maxClaimedYield: number,
): number => {
  const yieldScore = maxClaimedYield > 0 ? clamp((yieldEth / maxClaimedYield) * 100, 0, 100) : 0;
  const weighted = txScore * 0.5 + uptimePct * 0.3 + yieldScore * 0.2;
  return clamp(Math.round(weighted), 0, 100);
};

const formatYield = (yieldEth: number): string => `${yieldEth.toFixed(4)} ETH`;
const formatUptime = (uptimePct: number): string => `${uptimePct.toFixed(1)}%`;

const tierClassName: Record<LeadTier, string> = {
  WHALE:
    "border-neon-purple border-violet-400 bg-emerald-500/20 text-emerald-300 animate-pulse shadow-[0_0_10px_rgba(139,92,246,0.5)]",
  ACTIVE: "border-amber-400/40 bg-amber-500/20 text-amber-300",
  NEW: "border-slate-500/40 bg-slate-500/20 text-slate-300",
};

export default function Home() {
  const [network, setNetwork] = useState<Network>("BASE");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedOwner, setCopiedOwner] = useState<string | null>(null);
  const { address: userAddress } = useAccount();
  const router = useRouter();
  const networkSelectValue = network === "BASE" ? "base" : "megaeth";

  const baseLeads = useMemo<ProcessedLead[]>(() => {
    const seededLeads = leads.map((lead) => {
      const txCount = Math.max(0, lead.transactionCount ?? lead.txCount ?? 0);
      const yieldEth = parseYieldEth(lead.yield);
      const uptimePct = parseUptimePct(lead.uptime);
      const hasClaimFlag = Boolean(lead.claimed || lead.isClaimed || lead.monitored || lead.isMonitored);
      const isClaimed = monitoredAgentIds.has(lead.agentId) || hasClaimFlag;

      return {
        agentId: lead.agentId,
        owner: lead.owner,
        tier: lead.tier,
        txCount,
        yieldEth,
        uptimePct,
        isClaimed,
      };
    });

    const maxTxCount = Math.max(0, ...seededLeads.map((lead) => lead.txCount));
    const maxClaimedYield = Math.max(
      0,
      ...seededLeads
        .filter((lead) => lead.isClaimed && lead.yieldEth != null)
        .map((lead) => lead.yieldEth ?? 0),
    );

    return seededLeads
      .map((lead) => {
        const txScore = normalizeTxScore(lead.txCount, maxTxCount);
        const hasFullClaimTelemetry = lead.isClaimed && lead.yieldEth != null && lead.uptimePct != null;
        const reputationScore = hasFullClaimTelemetry
          ? computeClaimedReputation(txScore, lead.uptimePct!, lead.yieldEth!, maxClaimedYield)
          : txScore;

        return {
          agentId: lead.agentId,
          owner: lead.owner,
          tier: lead.tier,
          txCount: lead.txCount,
          isClaimed: lead.isClaimed,
          reputationScore,
          yieldEth: lead.isClaimed ? lead.yieldEth : null,
          uptimePct: lead.isClaimed ? lead.uptimePct : null,
        };
      })
      .sort((a, b) => b.reputationScore - a.reputationScore || b.txCount - a.txCount);
  }, []);

  const filteredAgents = useMemo(() => {
    const source = network === "BASE" ? baseLeads : [];
    if (!searchQuery.trim()) return source;

    const query = searchQuery.toLowerCase().trim();
    return source.filter((lead) => lead.agentId.toLowerCase().includes(query) || lead.owner.toLowerCase().includes(query));
  }, [baseLeads, network, searchQuery]);

  const rankedAgents = useMemo(
    () =>
      filteredAgents.map((agent, index) => ({
        ...agent,
        rank: index + 1,
      })),
    [filteredAgents],
  );

  const whaleOwners = useMemo(() => {
    const uniqueWhales = new Set(baseLeads.filter((agent) => agent.tier === "WHALE").map((agent) => agent.owner.toLowerCase()));
    return uniqueWhales.size;
  }, [baseLeads]);

  const uniqueBaseAgents = useMemo(() => {
    const seen = new Set<string>();
    for (const lead of baseLeads) {
      seen.add(lead.owner.toLowerCase());
    }
    return seen.size;
  }, [baseLeads]);

  const claimedCount = useMemo(() => baseLeads.filter((agent) => agent.isClaimed).length, [baseLeads]);

  const reputationColor = (score: number): string => {
    if (score >= 80) return "text-emerald-300";
    if (score >= 50) return "text-amber-300";
    return "text-slate-400";
  };

  const handleOpenDashboard = (mode: "merchant" | "consumer", agentId: string) => {
    const params = new URLSearchParams({ mode, agentId });
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
            {network === "BASE" ? baseLeads.length : 0}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//network_status"}</span>
          </div>
          <div className="text-sm font-regular flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 will-change-[transform,opacity]"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_10px_#34d399]"></span>
            </span>
            <span className={network === "MEGAETH" ? "text-fuchsia-300" : "text-cyan-300"}>
              [{network === "MEGAETH" ? "wip_no_verified_data" : "live_on_base"}]
            </span>
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//whale_wallets"}</span>
          </div>
          <div className="text-3xl text-white font-regular drop-shadow-[0_0_5px_rgba(255,255,255,0.3)]">
            {network === "BASE" ? whaleOwners : "--"}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/20" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">{"//claimed_agents"}</span>
          </div>
          <div className="text-sm text-cyan-300">
            {network === "BASE" ? `${claimedCount}/${uniqueBaseAgents}` : "--"}
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
                        <span className="inline-flex shrink-0 items-center gap-1 border border-emerald-400/50 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-emerald-300 whitespace-nowrap">
                          <Check className="h-2.5 w-2.5" />
                          Claimed
                        </span>
                      )}
                    </div>
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
                    {agent.reputationScore}
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
                        onClick={() => handleOpenDashboard(isOwner ? "merchant" : "consumer", agent.agentId)}
                        className={`inline-flex min-w-[132px] items-center justify-center px-3 py-2 text-xs uppercase tracking-[0.12em] font-mono border transition ${
                          isOwner
                            ? "bg-emerald-500 text-black border-emerald-400/40 hover:bg-emerald-400"
                            : "text-cyan-400 border-cyan-400/20 hover:bg-cyan-400/10"
                        }`}
                      >
                        {isOwner ? "CLAIM PROFILE" : "USE AGENT"}
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
