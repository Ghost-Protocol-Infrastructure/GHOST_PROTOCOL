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
  WHALE: "border-neutral-800 bg-neutral-900 text-neutral-300",
  ACTIVE: "border-neutral-800 bg-neutral-900 text-neutral-300",
  NEW: "border-neutral-800 bg-neutral-900 text-neutral-500",
  GHOST: "border-neutral-800 bg-neutral-900 text-neutral-600",
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
    <main className="min-h-screen font-mono text-neutral-400 bg-neutral-950 [background-image:none]">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm uppercase tracking-[0.18em] text-neutral-500 font-bold">Agent Profile</h1>
          <Link
            href="/rank"
            className="border border-neutral-900 bg-neutral-950 px-3 py-2 text-xs uppercase tracking-[0.12em] text-neutral-400 transition hover:border-red-600 hover:text-red-500 font-bold"
          >
            Back to Rank
          </Link>
        </div>

        <section className="mb-6 border border-neutral-900 bg-neutral-950 p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-bold tracking-tight text-neutral-100">{agent.name || `Agent #${agent.agentId}`}</h2>
            <span className="border border-red-900/30 bg-red-950/10 px-2 py-1 text-xs uppercase tracking-[0.16em] text-red-600 font-bold">
              #{agent.agentId}
            </span>
            <span className={`border px-2 py-1 text-xs uppercase tracking-[0.16em] font-bold ${tierClassName[agent.tier]}`}>
              {agent.tier}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-2">
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Creator Wallet</p>
              <p className="text-neutral-300 font-mono" title={agent.creator}>
                {truncateAddress(agent.creator)}
              </p>
            </div>
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Owner Wallet</p>
              <p className="text-neutral-300 font-mono" title={ownerAddress}>
                {truncateAddress(ownerAddress)}
              </p>
            </div>
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Status</p>
              <p className="text-neutral-300 font-mono">{statusLabel}</p>
            </div>
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Rank Score</p>
              <p className="text-neutral-300 font-mono">{agent.rankScore.toFixed(2)}</p>
            </div>
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Reputation</p>
              <p className="text-neutral-300 font-mono">{agent.reputation.toFixed(2)}</p>
            </div>
            <div className="border border-neutral-900 bg-neutral-900 p-3">
              <p className="mb-1 uppercase tracking-[0.16em] text-neutral-500 font-bold">Transactions</p>
              <p className="text-neutral-300 font-mono">{agent.txCount}</p>
            </div>
          </div>

          {agentDescription ? (
            <div className="mt-4 border border-neutral-900 bg-neutral-900 p-3 text-sm text-neutral-400 font-mono">
              {agentDescription}
            </div>
          ) : null}
        </section>

        <section className="border border-neutral-900 bg-neutral-950 p-6">
          <h3 className="mb-3 text-sm uppercase tracking-[0.16em] text-neutral-100 font-bold">Connect</h3>
          <p className="mb-3 text-sm text-neutral-400">
            Choose your SDK runtime and copy the integration starter below.
          </p>
          <div className="border border-neutral-800 bg-neutral-900 p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Agent ID</p>
            <code className="block break-all text-lg text-neutral-200 font-mono">{agent.agentId}</code>
          </div>
          <div className="mt-4">
            <IntegrationTabs agentId={agent.agentId} initialTab={initialSdkTab} />
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            The snippets above are pre-filled with this agent identifier so onboarding stays consistent.
          </p>
        </section>
      </div>
    </main>
  );
}
