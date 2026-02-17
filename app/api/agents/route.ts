import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const parseLimit = (rawLimit: string | null): number => {
  if (!rawLimit) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const parseOwner = (rawOwner: string | null): string | null => {
  if (!rawOwner) return null;
  const normalized = rawOwner.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sort = request.nextUrl.searchParams.get("sort");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const ownerQuery = request.nextUrl.searchParams.get("owner");
  const owner = parseOwner(ownerQuery);

  if (ownerQuery && !owner) {
    return NextResponse.json(
      { error: "Invalid owner address." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const orderBy =
    sort === "volume"
      ? [{ txCount: "desc" as const }, { rankScore: "desc" as const }]
      : [{ rankScore: "desc" as const }, { reputation: "desc" as const }, { txCount: "desc" as const }];
  const where = owner
    ? {
        creator: {
          equals: owner,
          mode: "insensitive" as const,
        },
      }
    : undefined;

  const [agents, totalAgents, indexerState] = await prisma.$transaction([
    prisma.agent.findMany({
      where,
      orderBy,
      take: limit,
    }),
    prisma.agent.count(),
    prisma.systemState.findFirst({
      where: { key: "agent_indexer" },
    }),
  ]);

  return NextResponse.json(
    {
      totalAgents,
      filteredAgents: agents.length,
      lastSyncedBlock: indexerState?.lastSyncedBlock?.toString() ?? null,
      agents: agents.map((agent) => ({
        address: agent.address,
        name: agent.name,
        creator: agent.creator,
        image: agent.image,
        description: agent.description,
        telegram: agent.telegram,
        twitter: agent.twitter,
        website: agent.website,
        status: agent.status,
        tier: agent.tier,
        txCount: agent.txCount,
        reputation: agent.reputation,
        rankScore: agent.rankScore,
        yield: agent.yield,
        uptime: agent.uptime,
        volume: agent.volume.toString(),
        score: agent.score,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      })),
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
