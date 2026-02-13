"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import GhostList from "@/components/GhostList";
import Navbar from "@/components/Navbar";
import type { GhostAgent } from "@/types/ghost";
import baseAgents from "../data/leads-scored.json";

type Network = "MEGAETH" | "BASE";
type LeadTier = "WHALE" | "ACTIVE" | "NEW";

type BaseAgentLead = {
  agentId: string;
  owner: string;
  txCount: number;
  tier: LeadTier;
};

const leads = baseAgents as BaseAgentLead[];

const truncateAddress = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;

const tierClassName: Record<LeadTier, string> = {
  WHALE: "border-emerald-400/40 bg-emerald-500/20 text-emerald-300",
  ACTIVE: "border-amber-400/40 bg-amber-500/20 text-amber-300",
  NEW: "border-slate-500/40 bg-slate-500/20 text-slate-300",
};

export default function Home() {
  const [network, setNetwork] = useState<Network>("MEGAETH");
  const { address: userAddress } = useAccount();
  const router = useRouter();

  const megaEthMockAgents = useMemo<GhostAgent[]>(() => {
    const uniqueOwners = new Map<string, BaseAgentLead>();
    for (const lead of leads) {
      const key = lead.owner.toLowerCase();
      if (!uniqueOwners.has(key)) {
        uniqueOwners.set(key, lead);
      }
      if (uniqueOwners.size >= 50) break;
    }

    return Array.from(uniqueOwners.values()).map((lead, index) => ({
      rank: index + 1,
      agentAddress: lead.owner,
      reputationScore: Math.min(99, Math.max(45, 58 + Math.floor(lead.txCount / 8) - (index % 9))),
      totalEarningsEth: (1.2 + lead.txCount / 140 + (50 - index) / 30).toFixed(2),
      uptimePct: Math.min(99.9, 89 + (lead.txCount % 90) / 10),
    }));
  }, []);

  const whaleOwners = useMemo(() => {
    const uniqueWhales = new Set(leads.filter((agent) => agent.tier === "WHALE").map((agent) => agent.owner.toLowerCase()));
    return uniqueWhales.size;
  }, []);

  const handleClaimProfile = (owner: string) => {
    const isOwner = userAddress?.toLowerCase() === owner.toLowerCase();
    if (!isOwner) return;
    router.push("/dashboard");
  };

  return (
    <main className="min-h-screen bg-slate-950 p-8 max-w-7xl mx-auto space-y-8 mb-20 relative z-[50] font-mono text-slate-300">
      <Navbar />

      <section className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative inline-flex w-full max-w-md rounded-sm border border-slate-700 bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => setNetwork("MEGAETH")}
            className={`w-1/2 px-4 py-2 text-xs tracking-[0.18em] transition ${
              network === "MEGAETH"
                ? "bg-slate-950 text-fuchsia-300 shadow-[inset_0_0_12px_rgba(232,121,249,0.35)]"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            MEGAETH (SIM)
          </button>
          <button
            type="button"
            onClick={() => setNetwork("BASE")}
            className={`w-1/2 px-4 py-2 text-xs tracking-[0.18em] transition ${
              network === "BASE"
                ? "bg-slate-950 text-cyan-300 shadow-[inset_0_0_12px_rgba(34,211,238,0.35)]"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            BASE (LIVE)
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">//total_agents</span>
          </div>
          <div className="text-3xl text-white font-regular drop-shadow-[0_0_5px_rgba(255,255,255,0.3)]">
            {network === "MEGAETH" ? megaEthMockAgents.length : leads.length}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">//network_status</span>
          </div>
          <div className="text-sm font-regular flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 will-change-[transform,opacity]"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_10px_#34d399]"></span>
            </span>
            <span className={network === "MEGAETH" ? "text-fuchsia-300" : "text-cyan-300"}>
              [{network === "MEGAETH" ? "simulated" : "live_on_base"}]
            </span>
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">//whale_wallets</span>
          </div>
          <div className="text-3xl text-white font-regular drop-shadow-[0_0_5px_rgba(255,255,255,0.3)]">
            {network === "MEGAETH" ? "--" : whaleOwners}
          </div>
        </div>
        <div className="p-4 rounded-sm bg-slate-950/50 border border-violet-500/20 backdrop-blur-sm transform-gpu group hover:border-violet-500/40 transition-colors">
          <div className="relative inline-flex mb-2">
            <div className="absolute inset-0 bg-violet-500/20" aria-hidden="true"></div>
            <span className="relative text-white text-[10px] tracking-[0.2em]">//claim_route</span>
          </div>
          <div className="text-sm text-cyan-300">/dashboard</div>
        </div>
      </div>

      {network === "MEGAETH" ? (
        <GhostList initialAgents={megaEthMockAgents} />
      ) : (
        <section className="relative bg-slate-950/80 backdrop-blur-md border border-cyan-500/30 rounded-lg overflow-hidden shadow-[0_0_40px_-10px_rgba(34,211,238,0.25)]">
          <div className="h-1 w-full bg-gradient-to-r from-cyan-600 via-sky-500 to-cyan-600 opacity-50"></div>
          <div className="grid grid-cols-12 gap-0 border-b border-cyan-500/30 bg-cyan-950/10 text-xs tracking-widest text-cyan-300">
            <div className="col-span-1 py-3 px-4 border-r border-cyan-500/20">RANK</div>
            <div className="col-span-2 py-3 px-4 border-r border-cyan-500/20">TIER</div>
            <div className="col-span-2 py-3 px-4 border-r border-cyan-500/20">AGENT ID</div>
            <div className="col-span-3 py-3 px-4 border-r border-cyan-500/20">OWNER</div>
            <div className="col-span-1 py-3 px-4 border-r border-cyan-500/20 text-right">TXS</div>
            <div className="col-span-3 py-3 px-4 text-right">ACTION</div>
          </div>

          <div className="divide-y divide-cyan-500/10">
            {leads.map((agent, index) => {
              const isOwner = userAddress?.toLowerCase() === agent.owner.toLowerCase();
              return (
                <div key={`${agent.agentId}-${agent.owner}`} className="grid grid-cols-12 gap-0 items-center text-sm hover:bg-cyan-500/10">
                  <div className="col-span-1 py-3 px-4 border-r border-cyan-500/10 text-slate-300">
                    {index + 1}
                  </div>
                  <div className="col-span-2 py-3 px-4 border-r border-cyan-500/10">
                    <span className={`inline-flex border px-2 py-1 text-[11px] tracking-wider ${tierClassName[agent.tier]}`}>
                      {agent.tier}
                    </span>
                  </div>
                  <div className="col-span-2 py-3 px-4 border-r border-cyan-500/10 text-slate-200">
                    {agent.agentId}
                  </div>
                  <div className="col-span-3 py-3 px-4 border-r border-cyan-500/10 text-slate-400">
                    <span title={agent.owner}>{truncateAddress(agent.owner)}</span>
                  </div>
                  <div className="col-span-1 py-3 px-4 border-r border-cyan-500/10 text-right text-slate-300">
                    {agent.txCount}
                  </div>
                  <div className="col-span-3 py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => handleClaimProfile(agent.owner)}
                      disabled={!isOwner}
                      className={
                        isOwner
                          ? "px-3 py-2 text-xs tracking-[0.12em] bg-emerald-500 text-black hover:bg-emerald-400 transition"
                          : "px-3 py-2 text-xs tracking-[0.12em] border border-slate-700 text-slate-600 cursor-not-allowed"
                      }
                    >
                      {isOwner ? "CLAIM PROFILE" : "LOCKED"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

