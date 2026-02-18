import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import IntegrationTabs from "./IntegrationTabs";

export const dynamic = "force-dynamic";

type AgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ sdk?: string }>;
};

type AgentSummary = {
  agentId: string;
  address: string;
  name: string;
  creator: string;
  owner: string;
  status: string;
  tier: "WHALE" | "ACTIVE" | "NEW" | "GHOST";
  txCount: number;
  reputation: number;
  rankScore: number;
  yield: number;
  uptime: number;
  description: string | null;
};

const tierClassName: Record<AgentSummary["tier"], string> = {
  WHALE: "border-emerald-400/40 bg-emerald-500/20 text-emerald-300",
  ACTIVE: "border-amber-400/40 bg-amber-500/20 text-amber-300",
  NEW: "border-slate-500/40 bg-slate-500/20 text-slate-300",
  GHOST: "border-slate-700/60 bg-slate-800/40 text-slate-500",
};

const toTitleCase = (value: string): string =>
  value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");

const truncateAddress = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;

const normalizeAgentDescription = (description: string | null): string | null => {
  if (!description) return null;

  const cleaned = description.trim();
  if (!cleaned) return null;

  const fallbackMatch = cleaned.match(/^Fallback-indexed registry service\s+(\d+)\s+\(CreateService \+ ownerOf\)\.?$/i);
  if (fallbackMatch) {
    return `Indexed via fallback registry path for Agent #${fallbackMatch[1]}.`;
  }

  return cleaned;
};

export default async function AgentProfilePage({ params, searchParams }: AgentPageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const agentId = decodeURIComponent(id).trim();

  if (!agentId) {
    notFound();
  }

  const agent = await prisma.agent.findUnique({
    where: { agentId },
    select: {
      agentId: true,
      address: true,
      name: true,
      creator: true,
      owner: true,
      status: true,
      tier: true,
      txCount: true,
      reputation: true,
      rankScore: true,
      yield: true,
      uptime: true,
      description: true,
    },
  });

  if (!agent) {
    notFound();
  }

  const statusLabel = toTitleCase(agent.status);
  const initialSdkTab = resolvedSearchParams?.sdk?.toLowerCase() === "python" ? "python" : "node";
  const ownerAddress = agent.owner ?? agent.creator;
  const agentDescription = normalizeAgentDescription(agent.description);

  return (
    <main className="min-h-screen bg-slate-950 font-mono text-slate-300">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm uppercase tracking-[0.18em] text-slate-400">Agent Profile</h1>
          <Link
            href="/rank"
            className="border border-slate-700 bg-slate-900 px-3 py-2 text-xs uppercase tracking-[0.12em] text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
          >
            Back to Rank
          </Link>
        </div>

        <section className="mb-6 border border-cyan-500/20 bg-slate-900/80 p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">{agent.name || `Agent #${agent.agentId}`}</h2>
            <span className="border border-violet-500/40 bg-violet-500/20 px-2 py-1 text-xs uppercase tracking-[0.16em] text-violet-200">
              #{agent.agentId}
            </span>
            <span className={`border px-2 py-1 text-xs uppercase tracking-[0.16em] ${tierClassName[agent.tier]}`}>
              {agent.tier}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-2">
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Creator Wallet</p>
              <p className="text-slate-300" title={agent.creator}>
                {truncateAddress(agent.creator)}
              </p>
            </div>
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Owner Wallet</p>
              <p className="text-slate-300" title={ownerAddress}>
                {truncateAddress(ownerAddress)}
              </p>
            </div>
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Status</p>
              <p className="text-slate-300">{statusLabel}</p>
            </div>
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Rank Score</p>
              <p className="text-slate-300">{agent.rankScore.toFixed(2)}</p>
            </div>
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Reputation</p>
              <p className="text-slate-300">{agent.reputation.toFixed(2)}</p>
            </div>
            <div className="border border-slate-800 bg-slate-950 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-slate-500">Transactions</p>
              <p className="text-slate-300">{agent.txCount}</p>
            </div>
          </div>

          {agentDescription ? (
            <div className="mt-4 border border-slate-800 bg-slate-950 p-3 text-sm text-slate-400">
              {agentDescription}
            </div>
          ) : null}
        </section>

        <section className="border border-emerald-500/25 bg-emerald-950/10 p-6">
          <h3 className="mb-3 text-sm uppercase tracking-[0.16em] text-emerald-300">Connect</h3>
          <p className="mb-3 text-sm text-slate-400">
            Choose your SDK runtime and copy the integration starter below.
          </p>
          <div className="border border-emerald-500/30 bg-slate-950 p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Agent ID</p>
            <code className="block break-all text-lg text-emerald-300">{agent.agentId}</code>
          </div>
          <div className="mt-4">
            <IntegrationTabs agentId={agent.agentId} initialTab={initialSdkTab} />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            The snippets above are pre-filled with this agent identifier so onboarding stays consistent.
          </p>
        </section>
      </div>
    </main>
  );
}
