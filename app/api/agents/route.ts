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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sort = request.nextUrl.searchParams.get("sort");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const orderBy =
    sort === "volume"
      ? [{ txCount: "desc" as const }, { rankScore: "desc" as const }]
      : [{ rankScore: "desc" as const }, { reputation: "desc" as const }, { txCount: "desc" as const }];

  const [agents, totalAgents, indexerState] = await prisma.$transaction([
    prisma.agent.findMany({
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
