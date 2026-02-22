import Link from "next/link";
import { notFound } from "next/navigation";
import Image from "next/image";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type AgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ sdk?: string }>;
};

type AgentSummary = {
  agentId: string;
  address: string;
  name: string;
  image: string | null;
  creator: string;
  owner: string;
  status: string;
  tier: "WHALE" | "ACTIVE" | "NEW" | "GHOST";
  txCount: number;
  reputation: number;
  rankScore: number;
  description: string | null;
};

const tierClassName: Record<AgentSummary["tier"], string> = {
  WHALE: "border-violet-400 bg-violet-500/20 text-violet-300 animate-pulse shadow-[0_0_10px_rgba(139,92,246,0.5)]",
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

const normalizeAgentDescription = (description: string | null): string | null => {
  if (!description) return null;

  const cleaned = description.trim();
  if (!cleaned) return null;

  const fallbackRegistryMatch = cleaned.match(/^Fallback-indexed registry service\s+(\d+)\s+\(CreateService \+ ownerOf\)\.?$/i);
  if (fallbackRegistryMatch) {
    return `On-chain identity verified for Agent #${fallbackRegistryMatch[1]}. Additional profile metadata is syncing.`;
  }

  const fallbackErc8004Match = cleaned.match(/^Fallback-indexed ERC-8004 token\s+(\d+)\s+\(Transfer \+ ownerOf\)\.?$/i);
  if (fallbackErc8004Match) {
    return `On-chain identity verified for Agent #${fallbackErc8004Match[1]}. Additional profile metadata is syncing.`;
  }

  if (cleaned.toLowerCase().startsWith("fallback-indexed")) {
    return "On-chain identity verified. Additional profile metadata is syncing.";
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
      image: true,
      creator: true,
      owner: true,
      status: true,
      tier: true,
      txCount: true,
      reputation: true,
      rankScore: true,
      description: true,
    },
  });

  if (!agent) {
    notFound();
  }

  const statusLabel = toTitleCase(agent.status);
  const requestedSdkTab = resolvedSearchParams?.sdk?.toLowerCase();
  const hasLegacySetupParam = requestedSdkTab === "node" || requestedSdkTab === "python";
  const ownerAddress = agent.owner ?? agent.creator;
  const agentDescription = normalizeAgentDescription(agent.description);
  const agentImageUrl = resolveAgentImageUrl(agent.image);
  const merchantSetupHref = `/dashboard?mode=merchant&agentId=${encodeURIComponent(agent.agentId)}&owner=${encodeURIComponent(ownerAddress)}`;
  const consumerTerminalHref = `/dashboard?mode=consumer&agentId=${encodeURIComponent(agent.agentId)}&owner=${encodeURIComponent(ownerAddress)}`;
  const agentConsoleHref = `/dashboard?agentId=${encodeURIComponent(agent.agentId)}&owner=${encodeURIComponent(ownerAddress)}`;

  return (
    <main className="min-h-screen font-mono text-neutral-400 bg-neutral-950 [background-image:none] max-w-7xl mx-auto border-l border-r border-neutral-900">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm uppercase tracking-[0.18em] text-neutral-500 font-bold">{"// AGENT PROFILE"}</h1>
          <Link
            href="/rank"
            className="border border-neutral-900 bg-neutral-950 px-3 py-2 text-xs uppercase tracking-[0.12em] text-neutral-400 transition hover:border-red-600 hover:text-red-500 font-bold"
          >
            {"//BACK_TO_RANK"}
          </Link>
        </div>

        {hasLegacySetupParam ? (
          <section className="mb-6 border border-amber-700/40 bg-amber-950/10 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-amber-300 font-bold">
              Setup snippets moved to Merchant Console
            </p>
            <p className="mt-2 text-sm text-amber-100/80">
              This page is now a public agent profile. Use Merchant Console for SDK initialization and setup.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                href={merchantSetupHref}
                className="border border-amber-600/50 bg-amber-950/20 px-3 py-2 text-xs uppercase tracking-[0.12em] text-amber-300 transition hover:border-amber-500 hover:text-amber-200 font-bold"
              >
                Open Merchant Console
              </Link>
              <Link
                href={consumerTerminalHref}
                className="border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs uppercase tracking-[0.12em] text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200 font-bold"
              >
                Open Consumer Terminal
              </Link>
            </div>
          </section>
        ) : null}

        <section className="mb-6 border border-neutral-900 bg-neutral-950 p-6">
          <div className="grid grid-cols-1 items-stretch gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
            <div className="relative aspect-square w-full max-w-[300px] self-start overflow-hidden border border-neutral-800 bg-neutral-900">
              {agentImageUrl ? (
                <Image
                  src={agentImageUrl}
                  alt={`${agent.name || `Agent #${agent.agentId}`} avatar`}
                  fill
                  className="object-cover"
                  unoptimized
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-4xl font-bold text-neutral-600">
                  {(agent.name || "A").slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>

            <div className="min-w-0 flex flex-col">
              <div className="mb-6 flex flex-wrap items-baseline gap-4">
                <h2 className="text-4xl font-black uppercase tracking-tight text-neutral-100">{agent.name || `Agent #${agent.agentId}`}</h2>
                <div className="flex items-center gap-2">
                  <span className="text-red-600 font-bold text-sm tracking-widest">#{agent.agentId}</span>
                  <span className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] font-bold ${tierClassName[agent.tier]}`}>
                    {agent.tier}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-0 border border-neutral-800 text-xs md:grid-cols-2 flex-1">
                <div className="border-b md:border-r border-neutral-800 bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Creator Wallet</p>
                  <p className="text-neutral-200 font-mono text-sm" title={agent.creator}>
                    {truncateAddress(agent.creator)}
                  </p>
                </div>
                <div className="border-b border-neutral-800 bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Owner Wallet</p>
                  <p className="text-neutral-200 font-mono text-sm" title={ownerAddress}>
                    {truncateAddress(ownerAddress)}
                  </p>
                </div>
                <div className="border-b md:border-r border-neutral-800 bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Status</p>
                  <p className="text-neutral-200 font-mono text-sm uppercase">{statusLabel}</p>
                </div>
                <div className="border-b border-neutral-800 bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Rank Score</p>
                  <p className="text-neutral-200 font-mono text-sm">{agent.rankScore.toFixed(2)}</p>
                </div>
                <div className="md:border-r border-neutral-800 bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70 md:border-b-0 border-b">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Reputation</p>
                  <p className="text-neutral-200 font-mono text-sm">{agent.reputation.toFixed(2)}</p>
                </div>
                <div className="bg-neutral-900 p-4 transition-colors hover:bg-neutral-800/70">
                  <p className="mb-2 uppercase tracking-[0.2em] text-neutral-500 font-bold text-[10px]">Transactions</p>
                  <p className="text-neutral-200 font-mono text-sm">{agent.txCount}</p>
                </div>
              </div>
            </div>
          </div>

          {agentDescription ? (
            <div className="mt-4 border border-neutral-800 bg-neutral-900 p-3 text-sm text-neutral-400 font-mono">
              {agentDescription}
            </div>
          ) : null}
        </section>

        <section className="border border-neutral-900 bg-neutral-950 p-6">
          <h3 className="mb-3 text-sm uppercase tracking-[0.16em] text-neutral-100 font-bold">Agent Access</h3>
          <p className="mb-3 text-sm text-neutral-400">
            Use this profile to inspect metadata and confirm agent identity.
          </p>
          <div className="border border-neutral-800 bg-neutral-900 p-4">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Agent ID</p>
            <code className="block break-all text-lg text-neutral-200 font-mono">{agent.agentId}</code>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href={agentConsoleHref}
              className="border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs uppercase tracking-[0.12em] text-neutral-400 transition hover:border-red-600 hover:text-red-500 font-bold"
            >
              {"//ACCESS_AGENT_TERMINAL"}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
