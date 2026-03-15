import { NextRequest, NextResponse } from "next/server";
import type { Prisma as PrismaTypes } from "@prisma/client";
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
const STALE_SYNC_THRESHOLD_SECONDS = 3 * ONE_HOUR_SECONDS;
const DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS = 30_000;
const ACTIVATED_AGENTS_CACHE_TTL_MS = (() => {
  const raw = process.env.GHOST_ACTIVATED_AGENTS_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVATED_AGENTS_CACHE_TTL_MS;
  return parsed;
})();
const ACTIVE_CURSOR_KEY = "agent_indexer_erc8004";
const SCORE_V2_SYNTHETIC_USAGE_PRIMARY = (() => {
  const raw = process.env.SCORE_V2_SYNTHETIC_USAGE_PRIMARY?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return true;
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

  if (!activeSnapshot) {
    return NextResponse.json(
      { error: "Active leaderboard snapshot unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

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

  const [rows, filteredTotal, indexerState] = await prisma.$transaction([
    prisma.leaderboardSnapshotRow.findMany({
      where: snapshotWhere,
      orderBy: snapshotOrderBy,
      take: limit,
      skip,
    }),
    prisma.leaderboardSnapshotRow.count({ where: snapshotWhere }),
    prisma.systemState.findUnique({
      where: {
        key: ACTIVE_CURSOR_KEY,
      },
      select: {
        lastSyncedBlock: true,
      },
    }),
  ]);
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
          (txMetricSource === "AGENT_ONCHAIN" && isHexAddress(row.agentAddress) ? row.agentAddress.toLowerCase() : null);
        const canonicalAddressSource =
          normalizeCanonicalAddressSource(row.canonicalAddressSource) ?? (canonicalOnchainAddress ? "AGENT_ADDRESS" : "NONE");
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
          expressYield: row.expressYield,
          wireYield: row.wireYield,
          uptime: row.uptime,
          volume: row.volume.toString(),
          score: row.score,
          gatewayReadinessStatus: gatewayReadinessByAgentId.get(normalizedAgentId)?.readinessStatus ?? "UNCONFIGURED",
          gatewayLastCanaryCheckedAt: gatewayReadinessByAgentId.get(normalizedAgentId)?.lastCanaryCheckedAt ?? null,
          gatewayLastCanaryPassedAt: gatewayReadinessByAgentId.get(normalizedAgentId)?.lastCanaryPassedAt ?? null,
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
