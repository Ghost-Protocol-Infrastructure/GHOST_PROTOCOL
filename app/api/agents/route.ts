import { NextRequest, NextResponse } from "next/server";
import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { prisma } from "@/lib/db";
import { resolveScoreReadSource } from "@/lib/score-read-source";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_PAGE = 1;
const MAX_QUERY_LENGTH = 120;
const ONE_HOUR_SECONDS = 60 * 60;
const ONE_DAY_SECONDS = 24 * ONE_HOUR_SECONDS;
const STALE_SYNC_THRESHOLD_SECONDS = 3 * ONE_HOUR_SECONDS;
const DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS = 30_000;
const ACTIVATED_AGENTS_CACHE_TTL_MS = (() => {
  const raw = process.env.GHOST_ACTIVATED_AGENTS_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS;
  return parsed;
})();
const AGENT_INDEX_MODE = process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";
const ACTIVE_CURSOR_KEY = AGENT_INDEX_MODE === "olas" ? "agent_indexer_olas" : "agent_indexer_erc8004";
const LEGACY_CURSOR_KEY = "agent_indexer";
const SCORE_READ_SOURCE = resolveScoreReadSource(
  process.env.SCORE_READ_SOURCE,
  process.env.LEADERBOARD_READ_FROM_SNAPSHOT,
);
const SCORE_V2_SYNTHETIC_USAGE_PRIMARY = (() => {
  const raw = process.env.SCORE_V2_SYNTHETIC_USAGE_PRIMARY?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return AGENT_INDEX_MODE === "erc8004";
})();
const SCORE_V2_SYBIL_WINDOW_MINUTES = (() => {
  const raw = process.env.SCORE_V2_SYBIL_WINDOW_MINUTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 7 * 24 * 60;
  const parsed = Number.parseInt(raw, 10);
  return Math.max(60, Math.min(parsed, 30 * 24 * 60));
})();

type SyncHealth = "live" | "stale" | "offline" | "unknown";
type TxMetricSource =
  | "AGENT_ONCHAIN"
  | "USAGE_ACTIVITY_7D"
  | "OWNER_FALLBACK"
  | "CREATOR_FALLBACK"
  | "UNRESOLVED";
type CanonicalAddressSource = "OLAS_AGENT" | "ERC8004_RESOLVED" | "MANUAL_OVERRIDE" | "AGENT_ADDRESS" | "NONE";

type SyncMetadata = {
  syncHealth: SyncHealth;
  syncAgeSeconds: number | null;
  lastSyncedAt: string | null;
};

type RankedAddressRow = {
  address: string;
  rank: bigint | number;
};

type ActivatedAgentsCache = {
  value: number;
  expiresAtMs: number;
};

type GatewayReadinessInfo = {
  readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  lastCanaryCheckedAt: string | null;
  lastCanaryPassedAt: string | null;
};

let activatedAgentsCache: ActivatedAgentsCache | null = null;
let activatedAgentsInFlight: Promise<number> | null = null;

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

const HEX_ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const isHexAddress = (value: string | null | undefined): boolean =>
  typeof value === "string" && HEX_ADDRESS_PATTERN.test(value.trim());

const parseAgentIdFromServiceSlug = (service: string): string | null => {
  const normalized = service.trim().toLowerCase();
  if (!normalized.startsWith("agent-")) return null;
  const agentId = normalized.slice("agent-".length).trim();
  return agentId.length > 0 ? agentId : null;
};

const resolveUsageAuthorizedCountByAgentIds = async (agentIds: string[]): Promise<Map<string, number>> => {
  const normalizedAgentIds = Array.from(
    new Set(
      agentIds
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );
  if (normalizedAgentIds.length === 0) return new Map();

  const services = normalizedAgentIds.map((agentId) => `agent-${agentId}`);
  const since = new Date(Date.now() - SCORE_V2_SYBIL_WINDOW_MINUTES * 60_000);

  try {
    const rows = await prisma.gateAccessEvent.groupBy({
      by: ["service"],
      where: {
        service: { in: services },
        outcome: "AUTHORIZED",
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });

    const usageByAgentId = new Map<string, number>();
    for (const row of rows) {
      const agentId = parseAgentIdFromServiceSlug(row.service);
      if (!agentId) continue;
      usageByAgentId.set(agentId, Math.max(0, Math.trunc(row._count._all)));
    }
    return usageByAgentId;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return new Map();
    }
    console.error("Failed to resolve GateAccessEvent usage counts.", error);
    return new Map();
  }
};

const inferTxMetricSource = (input: {
  address: string;
  owner: string;
  creator: string;
  txCount: number;
  usageAuthorizedCount7d: number;
}): TxMetricSource => {
  if (isHexAddress(input.address)) return "AGENT_ONCHAIN";
  if (SCORE_V2_SYNTHETIC_USAGE_PRIMARY && input.usageAuthorizedCount7d > 0 && input.txCount === input.usageAuthorizedCount7d) {
    return "USAGE_ACTIVITY_7D";
  }
  if (isHexAddress(input.owner)) return "OWNER_FALLBACK";
  if (isHexAddress(input.creator)) return "CREATOR_FALLBACK";
  return "UNRESOLVED";
};

const normalizeTxMetricSource = (raw: string | null | undefined): TxMetricSource | null => {
  if (raw === "AGENT_ONCHAIN") return raw;
  if (raw === "USAGE_ACTIVITY_7D") return raw;
  if (raw === "OWNER_FALLBACK") return raw;
  if (raw === "CREATOR_FALLBACK") return raw;
  if (raw === "UNRESOLVED") return raw;
  return null;
};

const normalizeCanonicalAddressSource = (raw: string | null | undefined): CanonicalAddressSource | null => {
  if (raw === "OLAS_AGENT") return raw;
  if (raw === "ERC8004_RESOLVED") return raw;
  if (raw === "MANUAL_OVERRIDE") return raw;
  if (raw === "AGENT_ADDRESS") return raw;
  if (raw === "NONE") return raw;
  return null;
};

const resolveActivatedAgentsCountUncached = async (): Promise<number> => {
  try {
    return prisma.agentGatewayConfig.count({
      where: { readinessStatus: "LIVE" },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return 0;
    }
    console.error("Failed to resolve activated agent count from gateway readiness.", error);
    return 0;
  }
};

const resolveActivatedAgentsCount = async (): Promise<number> => {
  const now = Date.now();
  if (activatedAgentsCache && activatedAgentsCache.expiresAtMs > now) {
    return activatedAgentsCache.value;
  }

  if (activatedAgentsInFlight) {
    return activatedAgentsInFlight;
  }

  activatedAgentsInFlight = resolveActivatedAgentsCountUncached()
    .then((value) => {
      activatedAgentsCache = {
        value,
        expiresAtMs: Date.now() + ACTIVATED_AGENTS_CACHE_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      activatedAgentsInFlight = null;
    });

  return activatedAgentsInFlight;
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
      syncAgeSeconds > ONE_DAY_SECONDS
        ? "offline"
        : syncAgeSeconds > STALE_SYNC_THRESHOLD_SECONDS
          ? "stale"
          : "live";

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

const resolveGatewayReadinessByAgentIds = async (agentIds: string[]): Promise<Map<string, GatewayReadinessInfo>> => {
  const normalizedAgentIds = Array.from(
    new Set(
      agentIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (normalizedAgentIds.length === 0) return new Map();

  try {
    const rows = await prisma.agentGatewayConfig.findMany({
      where: {
        agentId: {
          in: normalizedAgentIds,
        },
      },
      select: {
        agentId: true,
        readinessStatus: true,
        lastCanaryCheckedAt: true,
        lastCanaryPassedAt: true,
      },
    });

    const readinessByAgentId = new Map<string, GatewayReadinessInfo>();
    for (const row of rows) {
      readinessByAgentId.set(row.agentId.toLowerCase(), {
        readinessStatus: row.readinessStatus,
        lastCanaryCheckedAt: row.lastCanaryCheckedAt?.toISOString() ?? null,
        lastCanaryPassedAt: row.lastCanaryPassedAt?.toISOString() ?? null,
      });
    }
    return readinessByAgentId;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return new Map();
    }
    console.error("Failed to resolve agent gateway readiness statuses.", error);
    return new Map();
  }
};

const resolveGlobalRankByAddress = async (sort: string | null, addresses: string[]): Promise<Map<string, number>> => {
  if (addresses.length === 0) return new Map();

  const rankOrderSql =
    sort === "volume"
      ? Prisma.sql`ORDER BY a."txCount" DESC, a."rankScore" DESC, a."reputation" DESC, a."address" ASC`
      : Prisma.sql`ORDER BY a."rankScore" DESC, a."reputation" DESC, a."txCount" DESC, a."address" ASC`;

  const rows = await prisma.$queryRaw<RankedAddressRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT
        a."address",
        ROW_NUMBER() OVER (${rankOrderSql}) AS rank
      FROM "Agent" a
    )
    SELECT ranked."address", ranked.rank
    FROM ranked
    WHERE ranked."address" IN (${Prisma.join(addresses)})
  `);

  const rankByAddress = new Map<string, number>();
  for (const row of rows) {
    const normalizedAddress = row.address.toLowerCase();
    const normalizedRank =
      typeof row.rank === "bigint"
        ? Number(row.rank)
        : typeof row.rank === "number" && Number.isFinite(row.rank)
          ? Math.trunc(row.rank)
          : null;
    if (normalizedRank && normalizedRank > 0) {
      rankByAddress.set(normalizedAddress, normalizedRank);
    }
  }
  return rankByAddress;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sort = request.nextUrl.searchParams.get("sort");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const page = parsePage(request.nextUrl.searchParams.get("page"));
  const query = parseQuery(request.nextUrl.searchParams.get("q"));
  const skip = (page - 1) * limit;
  const ownerQuery = request.nextUrl.searchParams.get("owner");
  const owner = parseOwner(ownerQuery);
  const activatedAgentsPromise = resolveActivatedAgentsCount();

  if (ownerQuery && !owner) {
    return NextResponse.json(
      { error: "Invalid owner address." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  if (SCORE_READ_SOURCE === "snapshot") {
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
      const snapshotOrderBy: PrismaTypes.LeaderboardSnapshotRowOrderByWithRelationInput[] =
        sort === "volume"
          ? [{ txCount: "desc" as const }, { rankScore: "desc" as const }, { rank: "asc" as const }]
          : [{ rank: "asc" as const }];
      const snapshotFilters: PrismaTypes.LeaderboardSnapshotRowWhereInput[] = [{ snapshotId: activeSnapshot.id }];
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
      const snapshotWhere: PrismaTypes.LeaderboardSnapshotRowWhereInput =
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
      const activatedAgents = await activatedAgentsPromise;
      const gatewayReadinessByAgentId = await resolveGatewayReadinessByAgentIds(rows.map((row) => row.agentId));

      return NextResponse.json(
        {
          totalAgents: activeSnapshot.totalAgents,
          activatedAgents,
          filteredTotal,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
          filteredAgents: rows.length,
          lastSyncedBlock: indexerState?.lastSyncedBlock?.toString() ?? null,
          syncHealth: syncMetadata.syncHealth,
          syncAgeSeconds: syncMetadata.syncAgeSeconds,
          lastSyncedAt: syncMetadata.lastSyncedAt,
          agents: rows.map((row) => {
            const normalizedAgentId = row.agentId.toLowerCase();
            const usageAuthorizedCount7d = Math.max(0, Math.trunc(row.usageAuthorizedCount7d ?? 0));
            const txMetricSource =
              normalizeTxMetricSource(row.metricSource) ??
              inferTxMetricSource({
                address: row.agentAddress,
                owner: row.owner,
                creator: row.creator,
                txCount: row.txCount,
                usageAuthorizedCount7d,
              });
            const canonicalOnchainAddress =
              row.canonicalOnchainAddress?.toLowerCase() ??
              (txMetricSource === "AGENT_ONCHAIN" && isHexAddress(row.agentAddress)
                ? row.agentAddress.toLowerCase()
                : null);
            const canonicalAddressSource =
              normalizeCanonicalAddressSource(row.canonicalAddressSource) ??
              (canonicalOnchainAddress ? "AGENT_ADDRESS" : "NONE");
            const onchainTxCountAgent =
              typeof row.onchainTxCountAgent === "number" && Number.isFinite(row.onchainTxCountAgent)
                ? Math.max(0, Math.trunc(row.onchainTxCountAgent))
                : txMetricSource === "AGENT_ONCHAIN"
                  ? Math.max(0, Math.trunc(row.txCount))
                  : null;
            const onchainTxCountOwner =
              typeof row.onchainTxCountOwner === "number" && Number.isFinite(row.onchainTxCountOwner)
                ? Math.max(0, Math.trunc(row.onchainTxCountOwner))
                : txMetricSource === "OWNER_FALLBACK"
                  ? Math.max(0, Math.trunc(row.txCount))
                  : 0;
            return {
              rank: row.rank,
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
              txMetricSource,
              metricSource: txMetricSource,
              onchainTxCountAgent,
              onchainTxCountOwner,
              usageAuthorizedCount7d,
              canonicalOnchainAddress,
              canonicalAddressSource,
              reputation: row.reputation,
              rankScore: row.rankScore,
              yield: row.yield,
              uptime: row.uptime,
              volume: row.volume.toString(),
              score: row.score,
              gatewayReadinessStatus:
                gatewayReadinessByAgentId.get(normalizedAgentId)?.readinessStatus ?? "UNCONFIGURED",
              gatewayLastCanaryCheckedAt:
                gatewayReadinessByAgentId.get(normalizedAgentId)?.lastCanaryCheckedAt ?? null,
              gatewayLastCanaryPassedAt:
                gatewayReadinessByAgentId.get(normalizedAgentId)?.lastCanaryPassedAt ?? null,
              createdAt: row.agentCreatedAt.toISOString(),
              updatedAt: row.agentUpdatedAt.toISOString(),
            };
          }),
        },
        {
          headers: { "cache-control": "no-store" },
        },
      );
    }
  }

  const orderBy: PrismaTypes.AgentOrderByWithRelationInput[] =
    sort === "volume"
      ? [
          { txCount: "desc" as const },
          { rankScore: "desc" as const },
          { reputation: "desc" as const },
          { address: "asc" as const },
        ]
      : [
          { rankScore: "desc" as const },
          { reputation: "desc" as const },
          { txCount: "desc" as const },
          { address: "asc" as const },
        ];
  const filters: PrismaTypes.AgentWhereInput[] = [];
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
  const where: PrismaTypes.AgentWhereInput | undefined =
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
  const activatedAgents = await activatedAgentsPromise;
  const filteredWithExplicitRank = Boolean(query || owner);
  const rankByAddress = filteredWithExplicitRank
    ? await resolveGlobalRankByAddress(
        sort,
        agents.map((agent) => agent.address),
      )
    : new Map<string, number>();
  const gatewayReadinessByAgentId = await resolveGatewayReadinessByAgentIds(
    agents
      .map((agent) => agent.agentId ?? "")
      .filter((value): value is string => value.trim().length > 0),
  );
  const scoreInputs = await prisma.agentScoreInput.findMany({
    where: {
      agentAddress: {
        in: agents.map((agent) => agent.address),
      },
    },
    select: {
      agentAddress: true,
      onchainTxCountAgent: true,
      onchainTxCountOwner: true,
      usageAuthorizedCount7d: true,
      metricSource: true,
      canonicalOnchainAddress: true,
      canonicalAddressSource: true,
    },
  });
  const scoreInputByAddress = new Map(scoreInputs.map((row) => [row.agentAddress.toLowerCase(), row]));
  const usageAuthorizedCountByAgentId = await resolveUsageAuthorizedCountByAgentIds(
    agents
      .map((agent) => agent.agentId ?? "")
      .filter((value): value is string => value.trim().length > 0),
  );

  return NextResponse.json(
    {
      totalAgents,
      activatedAgents,
      filteredTotal,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
      filteredAgents: agents.length,
      lastSyncedBlock: indexerState?.lastSyncedBlock?.toString() ?? null,
      syncHealth: syncMetadata.syncHealth,
      syncAgeSeconds: syncMetadata.syncAgeSeconds,
      lastSyncedAt: syncMetadata.lastSyncedAt,
      agents: agents.map((agent, index) => {
        const ownerAddress = agent.owner ?? agent.creator;
        const agentId = agent.agentId ?? agent.address;
        const normalizedAgentId = agentId.toLowerCase();
        const scoreInput = scoreInputByAddress.get(agent.address.toLowerCase());
        const fallbackUsageCount7d = usageAuthorizedCountByAgentId.get(normalizedAgentId) ?? 0;
        const usageAuthorizedCount7d =
          typeof scoreInput?.usageAuthorizedCount7d === "number" && Number.isFinite(scoreInput.usageAuthorizedCount7d)
            ? Math.max(0, Math.trunc(scoreInput.usageAuthorizedCount7d))
            : fallbackUsageCount7d;
        const txMetricSource =
          normalizeTxMetricSource(scoreInput?.metricSource) ??
          inferTxMetricSource({
            address: agent.address,
            owner: ownerAddress,
            creator: agent.creator,
            txCount: agent.txCount,
            usageAuthorizedCount7d,
          });
        const onchainTxCountAgent =
          typeof scoreInput?.onchainTxCountAgent === "number" && Number.isFinite(scoreInput.onchainTxCountAgent)
            ? Math.max(0, Math.trunc(scoreInput.onchainTxCountAgent))
            : isHexAddress(agent.address)
              ? Math.max(0, Math.trunc(agent.txCount))
              : null;
        const onchainTxCountOwner =
          typeof scoreInput?.onchainTxCountOwner === "number" && Number.isFinite(scoreInput.onchainTxCountOwner)
            ? Math.max(0, Math.trunc(scoreInput.onchainTxCountOwner))
            : txMetricSource === "OWNER_FALLBACK"
              ? Math.max(0, Math.trunc(agent.txCount))
              : 0;
        const canonicalOnchainAddress = scoreInput?.canonicalOnchainAddress
          ? scoreInput.canonicalOnchainAddress.toLowerCase()
          : isHexAddress(agent.address)
            ? agent.address.toLowerCase()
            : null;
        const canonicalAddressSource =
          normalizeCanonicalAddressSource(scoreInput?.canonicalAddressSource) ??
          (canonicalOnchainAddress ? "AGENT_ADDRESS" : "NONE");
        return {
          rank: rankByAddress.get(agent.address.toLowerCase()) ?? skip + index + 1,
          address: agent.address,
          agentId,
          name: agent.name,
          creator: agent.creator,
          owner: ownerAddress,
          image: agent.image,
          description: agent.description,
          telegram: agent.telegram,
          twitter: agent.twitter,
          website: agent.website,
          status: agent.status,
          tier: agent.tier,
          txCount: agent.txCount,
          txMetricSource,
          metricSource: txMetricSource,
          onchainTxCountAgent,
          onchainTxCountOwner,
          usageAuthorizedCount7d,
          canonicalOnchainAddress,
          canonicalAddressSource,
          reputation: agent.reputation,
          rankScore: agent.rankScore,
          yield: agent.yield,
          uptime: agent.uptime,
          volume: agent.volume.toString(),
          score: agent.score,
          gatewayReadinessStatus:
            gatewayReadinessByAgentId.get((agent.agentId ?? "").toLowerCase())?.readinessStatus ?? "UNCONFIGURED",
          gatewayLastCanaryCheckedAt:
            gatewayReadinessByAgentId.get((agent.agentId ?? "").toLowerCase())?.lastCanaryCheckedAt ?? null,
          gatewayLastCanaryPassedAt:
            gatewayReadinessByAgentId.get((agent.agentId ?? "").toLowerCase())?.lastCanaryPassedAt ?? null,
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
        };
      }),
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
