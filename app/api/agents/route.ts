import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_PAGE = 1;
const MAX_QUERY_LENGTH = 120;
const ONE_HOUR_SECONDS = 60 * 60;
const ONE_DAY_SECONDS = 24 * ONE_HOUR_SECONDS;
const AGENT_INDEX_MODE = process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";
const ACTIVE_CURSOR_KEY = AGENT_INDEX_MODE === "olas" ? "agent_indexer_olas" : "agent_indexer_erc8004";
const LEGACY_CURSOR_KEY = "agent_indexer";
const LEADERBOARD_READ_FROM_SNAPSHOT = process.env.LEADERBOARD_READ_FROM_SNAPSHOT?.trim().toLowerCase() === "true";

type SyncHealth = "live" | "stale" | "offline" | "unknown";

type SyncMetadata = {
  syncHealth: SyncHealth;
  syncAgeSeconds: number | null;
  lastSyncedAt: string | null;
};

const basePublicClient = createPublicClient({
  chain: base,
  transport: fallback([
    http(process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org", {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
    http("https://base.llamarpc.com", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
    http("https://1rpc.io/base", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
  ]),
});

const parseLimit = (rawLimit: string | null): number => {
  if (!rawLimit) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const parsePage = (rawPage: string | null): number => {
  if (!rawPage) return DEFAULT_PAGE;
  const parsed = Number.parseInt(rawPage, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE;
  return parsed;
};

const parseQuery = (rawQuery: string | null): string | null => {
  if (!rawQuery) return null;
  const normalized = rawQuery.trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_QUERY_LENGTH);
};

const parseOwner = (rawOwner: string | null): string | null => {
  if (!rawOwner) return null;
  const normalized = rawOwner.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
};

const resolveSyncMetadata = async (lastSyncedBlock: bigint | null | undefined): Promise<SyncMetadata> => {
  if (!lastSyncedBlock || lastSyncedBlock <= 0n) {
    return {
      syncHealth: "offline",
      syncAgeSeconds: null,
      lastSyncedAt: null,
    };
  }

  try {
    const syncedBlock = await basePublicClient.getBlock({ blockNumber: lastSyncedBlock });
    const syncedAtSeconds = Number(syncedBlock.timestamp);
    if (!Number.isFinite(syncedAtSeconds) || syncedAtSeconds <= 0) {
      return {
        syncHealth: "unknown",
        syncAgeSeconds: null,
        lastSyncedAt: null,
      };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const syncAgeSeconds = Math.max(0, nowSeconds - syncedAtSeconds);
    const syncHealth: SyncHealth =
      syncAgeSeconds > ONE_DAY_SECONDS ? "offline" : syncAgeSeconds > ONE_HOUR_SECONDS ? "stale" : "live";

    return {
      syncHealth,
      syncAgeSeconds,
      lastSyncedAt: new Date(syncedAtSeconds * 1000).toISOString(),
    };
  } catch (error) {
    console.error("Failed to resolve Base sync freshness from block timestamp.", error);
    return {
      syncHealth: "unknown",
      syncAgeSeconds: null,
      lastSyncedAt: null,
    };
  }
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sort = request.nextUrl.searchParams.get("sort");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const page = parsePage(request.nextUrl.searchParams.get("page"));
  const query = parseQuery(request.nextUrl.searchParams.get("q"));
  const skip = (page - 1) * limit;
  const ownerQuery = request.nextUrl.searchParams.get("owner");
  const owner = parseOwner(ownerQuery);

  if (ownerQuery && !owner) {
    return NextResponse.json(
      { error: "Invalid owner address." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  if (LEADERBOARD_READ_FROM_SNAPSHOT) {
    const activeSnapshot = await prisma.leaderboardSnapshot.findFirst({
      where: {
        isActive: true,
        status: "READY",
      },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        totalAgents: true,
      },
    });

    if (activeSnapshot) {
      const snapshotOrderBy: Prisma.LeaderboardSnapshotRowOrderByWithRelationInput[] =
        sort === "volume"
          ? [{ txCount: "desc" as const }, { rankScore: "desc" as const }, { rank: "asc" as const }]
          : [{ rank: "asc" as const }];
      const snapshotFilters: Prisma.LeaderboardSnapshotRowWhereInput[] = [{ snapshotId: activeSnapshot.id }];
      if (owner) {
        snapshotFilters.push({
          owner: {
            equals: owner,
            mode: "insensitive" as const,
          },
        });
      }
      if (query) {
        snapshotFilters.push({
          OR: [
            { agentId: { contains: query, mode: "insensitive" as const } },
            { name: { contains: query, mode: "insensitive" as const } },
            { agentAddress: { contains: query, mode: "insensitive" as const } },
            { owner: { contains: query, mode: "insensitive" as const } },
            { creator: { contains: query, mode: "insensitive" as const } },
          ],
        });
      }
      const snapshotWhere: Prisma.LeaderboardSnapshotRowWhereInput =
        snapshotFilters.length === 1 ? snapshotFilters[0] : { AND: snapshotFilters };

      const [rows, filteredTotal, indexerStates] = await prisma.$transaction([
        prisma.leaderboardSnapshotRow.findMany({
          where: snapshotWhere,
          orderBy: snapshotOrderBy,
          take: limit,
          skip,
        }),
        prisma.leaderboardSnapshotRow.count({ where: snapshotWhere }),
        prisma.systemState.findMany({
          where: {
            key: {
              in: [ACTIVE_CURSOR_KEY, LEGACY_CURSOR_KEY],
            },
          },
          select: {
            key: true,
            lastSyncedBlock: true,
          },
        }),
      ]);
      const indexerState =
        indexerStates.find((state) => state.key === ACTIVE_CURSOR_KEY) ??
        indexerStates.find((state) => state.key === LEGACY_CURSOR_KEY) ??
        null;
      const syncMetadata = await resolveSyncMetadata(indexerState?.lastSyncedBlock);

      return NextResponse.json(
        {
          totalAgents: activeSnapshot.totalAgents,
          filteredTotal,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
          filteredAgents: rows.length,
          lastSyncedBlock: indexerState?.lastSyncedBlock?.toString() ?? null,
          syncHealth: syncMetadata.syncHealth,
          syncAgeSeconds: syncMetadata.syncAgeSeconds,
          lastSyncedAt: syncMetadata.lastSyncedAt,
          agents: rows.map((row) => ({
            address: row.agentAddress,
            agentId: row.agentId,
            name: row.name,
            creator: row.creator,
            owner: row.owner,
            image: row.image,
            description: row.description,
            telegram: row.telegram,
            twitter: row.twitter,
            website: row.website,
            status: row.status,
            tier: row.tier,
            txCount: row.txCount,
            reputation: row.reputation,
            rankScore: row.rankScore,
            yield: row.yield,
            uptime: row.uptime,
            volume: row.volume.toString(),
            score: row.score,
            createdAt: row.agentCreatedAt.toISOString(),
            updatedAt: row.agentUpdatedAt.toISOString(),
          })),
        },
        {
          headers: { "cache-control": "no-store" },
        },
      );
    }
  }

  const orderBy: Prisma.AgentOrderByWithRelationInput[] =
    sort === "volume"
      ? [{ txCount: "desc" as const }, { rankScore: "desc" as const }]
      : [{ rankScore: "desc" as const }, { reputation: "desc" as const }, { txCount: "desc" as const }];
  const filters: Prisma.AgentWhereInput[] = [];
  if (owner) {
    filters.push({
      owner: {
        equals: owner,
        mode: "insensitive" as const,
      },
    });
  }
  if (query) {
    filters.push({
      OR: [
        { agentId: { contains: query, mode: "insensitive" as const } },
        { name: { contains: query, mode: "insensitive" as const } },
        { address: { contains: query, mode: "insensitive" as const } },
        { owner: { contains: query, mode: "insensitive" as const } },
        { creator: { contains: query, mode: "insensitive" as const } },
      ],
    });
  }
  const where: Prisma.AgentWhereInput | undefined =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { AND: filters };

  const [agents, totalAgents, filteredTotal, indexerStates] = await prisma.$transaction([
    prisma.agent.findMany({
      where,
      orderBy,
      take: limit,
      skip,
    }),
    prisma.agent.count(),
    prisma.agent.count({ where }),
    prisma.systemState.findMany({
      where: {
        key: {
          in: [ACTIVE_CURSOR_KEY, LEGACY_CURSOR_KEY],
        },
      },
      select: {
        key: true,
        lastSyncedBlock: true,
      },
    }),
  ]);
  const indexerState =
    indexerStates.find((state) => state.key === ACTIVE_CURSOR_KEY) ??
    indexerStates.find((state) => state.key === LEGACY_CURSOR_KEY) ??
    null;
  const syncMetadata = await resolveSyncMetadata(indexerState?.lastSyncedBlock);

  return NextResponse.json(
    {
      totalAgents,
      filteredTotal,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
      filteredAgents: agents.length,
      lastSyncedBlock: indexerState?.lastSyncedBlock?.toString() ?? null,
      syncHealth: syncMetadata.syncHealth,
      syncAgeSeconds: syncMetadata.syncAgeSeconds,
      lastSyncedAt: syncMetadata.lastSyncedAt,
      agents: agents.map((agent) => ({
        address: agent.address,
        agentId: agent.agentId ?? agent.address,
        name: agent.name,
        creator: agent.creator,
        owner: agent.owner ?? agent.creator,
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
