import { createPublicClient, fallback, getAddress, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";
import { prisma } from "../lib/db";

const REGISTRY_ADDRESS = getAddress(
  process.env.ERC8004_REGISTRY_ADDRESS?.trim() || "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE",
);
const CURSOR_KEY = "agent_indexer";
const DEFAULT_START_BLOCK = 23_000_000n;
const CHUNK_SIZE = (() => {
  const raw = process.env.AGENT_INDEX_CHUNK_SIZE?.trim();
  if (raw && /^\d+$/.test(raw)) return BigInt(raw);
  return 2_000n;
})();
const CHUNK_DELAY_MS = 100;
const OWNER_READ_DELAY_MS = 120;

const AGENT_REGISTERED_EVENT = parseAbiItem(
  "event AgentRegistered(address indexed agent, string name, address indexed creator, string image, string description, string telegram, string twitter, string website)",
);
const CREATE_SERVICE_EVENT = parseAbiItem("event CreateService(uint256 indexed serviceId, bytes32 configHash)");
const OWNER_OF_FUNCTION = parseAbiItem("function ownerOf(uint256 serviceId) view returns (address)");
const TOKEN_URI_FUNCTION = parseAbiItem("function tokenURI(uint256 serviceId) view returns (string)");
const FALLBACK_ADDRESS_PREFIX = "service:";
const FORCE_REFRESH_METADATA =
  process.argv.includes("--force-refresh-metadata") || process.env.AGENT_FORCE_REFRESH_METADATA === "true";
const METADATA_FETCH_TIMEOUT_MS = 8_000;
const METADATA_FETCH_RETRY_COUNT = 2;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

type IndexedAgentRecord = {
  address: string;
  name: string;
  creator: string;
  image: string | null;
  description: string | null;
  telegram: string | null;
  twitter: string | null;
  website: string | null;
};

type ServiceMetadata = {
  name: string | null;
  description: string | null;
  image: string | null;
  metadataUri: string | null;
};

type ContractReader = {
  readContract: (args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const parseStartBlock = (): bigint => {
  const raw = process.env.AGENT_INDEX_START_BLOCK?.trim();
  if (raw && /^\d+$/.test(raw)) return BigInt(raw);
  return DEFAULT_START_BLOCK;
};

const sanitizeOptionalText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const fallbackName = (address: string): string => `Agent ${address.slice(0, 10)}`;
const fallbackServiceName = (serviceId: string): string => `Agent #${serviceId}`;
const fallbackServiceDescription = (serviceId: string): string =>
  `Fallback-indexed registry service ${serviceId} (CreateService + ownerOf).`;
const getIpfsGateway = (): string => {
  const configured = process.env.AGENT_METADATA_IPFS_GATEWAY?.trim();
  if (!configured) return DEFAULT_IPFS_GATEWAY;
  return configured.endsWith("/") ? configured : `${configured}/`;
};

const resolveUriForFetch = (value: string): string => {
  const normalized = value.trim();
  if (normalized.startsWith("ipfs://ipfs/")) {
    return `${getIpfsGateway()}${normalized.replace("ipfs://ipfs/", "")}`;
  }
  if (normalized.startsWith("ipfs://")) {
    return `${getIpfsGateway()}${normalized.replace("ipfs://", "")}`;
  }
  return normalized;
};

const sanitizeImageField = (raw: unknown): string | null => {
  const image = sanitizeOptionalText(raw);
  if (!image) return null;

  if (image.startsWith("<svg")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(image)}`;
  }
  return resolveUriForFetch(image);
};

const fetchJsonWithRetry = async (url: string): Promise<Record<string, unknown>> => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= METADATA_FETCH_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json,text/plain,*/*" },
      });
      if (!response.ok) {
        if (response.status >= 500 && attempt < METADATA_FETCH_RETRY_COUNT) {
          await sleep(250);
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.text();
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Metadata payload is not a JSON object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      if (attempt < METADATA_FETCH_RETRY_COUNT) {
        await sleep(250);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Metadata fetch failed");
};

const fetchServiceMetadata = async (
  client: ContractReader,
  serviceId: bigint,
): Promise<ServiceMetadata | null> => {
  const rawTokenUri = await client.readContract({
    address: REGISTRY_ADDRESS,
    abi: [TOKEN_URI_FUNCTION],
    functionName: "tokenURI",
    args: [serviceId],
  });
  const tokenUri = sanitizeOptionalText(rawTokenUri);
  if (!tokenUri) {
    throw new Error("tokenURI returned empty value");
  }

  const metadataUri = resolveUriForFetch(tokenUri);
  const payload = await fetchJsonWithRetry(metadataUri);
  const name = sanitizeOptionalText(payload.name);
  const description = sanitizeOptionalText(payload.description);
  const image = sanitizeImageField(payload.image) ?? sanitizeImageField(payload.image_data);

  if (!name && !description && !image) {
    return null;
  }

  return {
    name,
    description,
    image,
    metadataUri,
  };
};

const isHexAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);

const deriveAgentId = (record: Pick<IndexedAgentRecord, "address" | "name">): string => {
  const fromAddress = record.address.match(/(?:service|agent)[:_-](\d+)/i)?.[1];
  if (fromAddress) return fromAddress;

  const fromName = record.name.match(/(?:agent|service)\s*#?\s*(\d+)/i)?.[1];
  if (fromName) return fromName;

  if (isHexAddress(record.address)) return record.address.slice(2, 8).toUpperCase();
  return record.name.trim().slice(0, 12).toUpperCase() || record.address.toLowerCase();
};

const allocateUniqueAgentId = (candidate: string, address: string, usedIds: Set<string>): string => {
  const trimmed = candidate.trim();
  if (trimmed.length > 0 && !usedIds.has(trimmed)) {
    usedIds.add(trimmed);
    return trimmed;
  }

  const fallback = address.toLowerCase();
  if (!usedIds.has(fallback)) {
    usedIds.add(fallback);
    return fallback;
  }

  let suffix = 2;
  while (usedIds.has(`${fallback}-${suffix}`)) {
    suffix += 1;
  }
  const next = `${fallback}-${suffix}`;
  usedIds.add(next);
  return next;
};

const getFromBlock = async (): Promise<bigint> => {
  const state = await prisma.systemState.findUnique({ where: { key: CURSOR_KEY } });
  if (!state || state.lastSyncedBlock <= 0n) {
    return parseStartBlock();
  }
  return state.lastSyncedBlock + 1n;
};

const persistCursor = async (latestBlock: bigint): Promise<void> => {
  await prisma.systemState.upsert({
    where: { key: CURSOR_KEY },
    create: {
      key: CURSOR_KEY,
      lastSyncedBlock: latestBlock,
    },
    update: {
      lastSyncedBlock: latestBlock,
    },
  });
};

const buildClient = () =>
  createPublicClient({
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

const fetchAgentRegistered = async (
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, IndexedAgentRecord>> => {
  const client = buildClient();
  const indexed = new Map<string, IndexedAgentRecord>();
  let chunkIndex = 0;

  let currentBlock = fromBlock;
  while (currentBlock <= toBlock) {
    const chunkToBlock = currentBlock + CHUNK_SIZE <= toBlock ? currentBlock + CHUNK_SIZE : toBlock;
    chunkIndex += 1;
    if (chunkIndex % 20 === 1) {
      console.log(`Scanning AgentRegistered logs from ${currentBlock.toString()} to ${chunkToBlock.toString()}`);
    }

    let logs:
      | Awaited<ReturnType<typeof client.getLogs<typeof AGENT_REGISTERED_EVENT>>>
      | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        logs = await client.getLogs({
          address: REGISTRY_ADDRESS,
          event: AGENT_REGISTERED_EVENT,
          fromBlock: currentBlock,
          toBlock: chunkToBlock,
          strict: false,
        });
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `AgentRegistered chunk fetch failed for ${currentBlock.toString()}-${chunkToBlock.toString()} (attempt ${attempt}/2).`,
        );
        if (attempt < 2) await sleep(CHUNK_DELAY_MS);
      }
    }

    if (!logs) {
      console.warn(`Skipping AgentRegistered chunk ${currentBlock.toString()}-${chunkToBlock.toString()}.`);
      console.error(lastError);
      currentBlock = chunkToBlock + 1n;
      if (currentBlock <= toBlock) await sleep(CHUNK_DELAY_MS);
      continue;
    }

    for (const log of logs) {
      const args = log.args as {
        agent?: Address;
        name?: string;
        creator?: Address;
        image?: string;
        description?: string;
        telegram?: string;
        twitter?: string;
        website?: string;
      };

      if (!args.agent) continue;
      const address = getAddress(args.agent).toLowerCase();
      const creator = args.creator ? getAddress(args.creator).toLowerCase() : address;
      const name = sanitizeOptionalText(args.name) ?? fallbackName(address);

      indexed.set(address, {
        address,
        creator,
        name,
        image: sanitizeOptionalText(args.image),
        description: sanitizeOptionalText(args.description),
        telegram: sanitizeOptionalText(args.telegram),
        twitter: sanitizeOptionalText(args.twitter),
        website: sanitizeOptionalText(args.website),
      });
    }

    currentBlock = chunkToBlock + 1n;
    if (currentBlock <= toBlock) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return indexed;
};

const fetchCreateServiceFallback = async (
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, IndexedAgentRecord>> => {
  const client = buildClient();
  const indexed = new Map<string, IndexedAgentRecord>();
  const serviceIds = new Set<bigint>();
  let chunkIndex = 0;

  let currentBlock = fromBlock;
  while (currentBlock <= toBlock) {
    const chunkToBlock = currentBlock + CHUNK_SIZE <= toBlock ? currentBlock + CHUNK_SIZE : toBlock;
    chunkIndex += 1;
    if (chunkIndex % 20 === 1) {
      console.log(`Fallback scan CreateService logs from ${currentBlock.toString()} to ${chunkToBlock.toString()}`);
    }

    let logs:
      | Awaited<ReturnType<typeof client.getLogs<typeof CREATE_SERVICE_EVENT>>>
      | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        logs = await client.getLogs({
          address: REGISTRY_ADDRESS,
          event: CREATE_SERVICE_EVENT,
          fromBlock: currentBlock,
          toBlock: chunkToBlock,
          strict: true,
        });
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `CreateService chunk fetch failed for ${currentBlock.toString()}-${chunkToBlock.toString()} (attempt ${attempt}/2).`,
        );
        if (attempt < 2) await sleep(CHUNK_DELAY_MS);
      }
    }

    if (!logs) {
      console.warn(`Skipping CreateService chunk ${currentBlock.toString()}-${chunkToBlock.toString()}.`);
      console.error(lastError);
      currentBlock = chunkToBlock + 1n;
      if (currentBlock <= toBlock) await sleep(CHUNK_DELAY_MS);
      continue;
    }

    for (const log of logs) {
      if (log.args.serviceId == null) continue;
      serviceIds.add(log.args.serviceId);
    }

    currentBlock = chunkToBlock + 1n;
    if (currentBlock <= toBlock) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  for (const serviceId of serviceIds) {
    try {
      const owner = await client.readContract({
        address: REGISTRY_ADDRESS,
        abi: [OWNER_OF_FUNCTION],
        functionName: "ownerOf",
        args: [serviceId],
      });

      const serviceIdText = serviceId.toString();
      const syntheticAddress = `${FALLBACK_ADDRESS_PREFIX}${serviceIdText}`;
      let metadata: ServiceMetadata | null = null;
      try {
        metadata = await fetchServiceMetadata(client as unknown as ContractReader, serviceId);
      } catch (error) {
        console.warn(
          `Metadata fetch failed for service ${serviceIdText}. Falling back to synthetic identity fields.`,
        );
        console.error(error);
      }

      if (!metadata) {
        console.warn(`Metadata is empty for service ${serviceIdText}. Falling back to synthetic identity fields.`);
      }

      indexed.set(syntheticAddress, {
        address: syntheticAddress,
        name: metadata?.name ?? fallbackServiceName(serviceIdText),
        creator: getAddress(owner).toLowerCase(),
        image: metadata?.image ?? null,
        description: metadata?.description ?? fallbackServiceDescription(serviceIdText),
        telegram: null,
        twitter: null,
        website: null,
      });
    } catch (error) {
      console.warn(`Skipping service ${serviceId.toString()} in fallback due to ownerOf failure.`);
      console.error(error);
    }

    await sleep(OWNER_READ_DELAY_MS);
  }

  return indexed;
};

const normalizeLegacyFallbackRows = async (): Promise<number> => {
  const legacyRows = await prisma.agent.findMany({
    where: { address: { startsWith: FALLBACK_ADDRESS_PREFIX } },
    select: { address: true, name: true, description: true },
  });

  let updatedCount = 0;

  for (const row of legacyRows) {
    const serviceId = row.address.slice(FALLBACK_ADDRESS_PREFIX.length);
    if (!/^\d+$/.test(serviceId)) continue;

    const normalizedName = fallbackServiceName(serviceId);
    const normalizedDescription = fallbackServiceDescription(serviceId);

    const hasFallbackDescription = row.description?.toLowerCase().includes("fallback-indexed registry service") ?? false;
    const hasLegacyFallbackName = /^agent\s+0x[a-f0-9]+$/i.test(row.name);
    if (!hasFallbackDescription && !hasLegacyFallbackName) continue;
    if (row.name === normalizedName && row.description === normalizedDescription) continue;

    await prisma.agent.update({
      where: { address: row.address },
      data: {
        name: normalizedName,
        description: normalizedDescription,
      },
    });

    updatedCount += 1;
  }

  return updatedCount;
};

const forceRefreshServiceMetadata = async (): Promise<{
  total: number;
  refreshed: number;
  fallbackUsed: number;
  unchanged: number;
}> => {
  const client = buildClient();
  const rows = await prisma.agent.findMany({
    where: { address: { startsWith: FALLBACK_ADDRESS_PREFIX } },
    select: { address: true, name: true, description: true, image: true, owner: true, creator: true },
  });

  let refreshed = 0;
  let fallbackUsed = 0;
  let unchanged = 0;
  let processed = 0;

  for (const row of rows) {
    processed += 1;
    if (processed % 10 === 0 || processed === rows.length) {
      console.log(`Metadata refresh progress: ${processed}/${rows.length} agents`);
    }

    const serviceIdText = row.address.slice(FALLBACK_ADDRESS_PREFIX.length);
    if (!/^\d+$/.test(serviceIdText)) {
      unchanged += 1;
      continue;
    }

    const serviceId = BigInt(serviceIdText);
    let owner = row.owner;
    try {
      const ownerResult = await client.readContract({
        address: REGISTRY_ADDRESS,
        abi: [OWNER_OF_FUNCTION],
        functionName: "ownerOf",
        args: [serviceId],
      });
      const ownerAddress = typeof ownerResult === "string" ? ownerResult : "";
      if (!ownerAddress) throw new Error("ownerOf returned a non-string value");
      owner = getAddress(ownerAddress as Address).toLowerCase();
    } catch (error) {
      console.warn(`ownerOf failed for service ${serviceIdText} during metadata refresh. Preserving existing owner.`);
      console.error(error);
    }

    let metadata: ServiceMetadata | null = null;
    try {
      metadata = await fetchServiceMetadata(client as unknown as ContractReader, serviceId);
    } catch (error) {
      console.warn(`Metadata fetch failed for service ${serviceIdText} during refresh. Falling back to synthetic values.`);
      console.error(error);
    }

    const nextName = metadata?.name ?? fallbackServiceName(serviceIdText);
    const nextDescription = metadata?.description ?? fallbackServiceDescription(serviceIdText);
    const nextImage = metadata?.image ?? null;

    if (!metadata) {
      fallbackUsed += 1;
    } else {
      refreshed += 1;
    }

    if (
      row.name === nextName &&
      row.description === nextDescription &&
      row.image === nextImage &&
      row.owner === owner &&
      row.creator === owner
    ) {
      unchanged += 1;
      await sleep(OWNER_READ_DELAY_MS);
      continue;
    }

    await prisma.agent.update({
      where: { address: row.address },
      data: {
        name: nextName,
        description: nextDescription,
        image: nextImage,
        owner,
        creator: owner,
      },
    });

    await sleep(OWNER_READ_DELAY_MS);
  }

  return {
    total: rows.length,
    refreshed,
    fallbackUsed,
    unchanged,
  };
};

const collectUsedAgentIds = async (): Promise<Set<string>> => {
  const rows = await prisma.agent.findMany({
    select: { agentId: true },
  });

  return new Set(
    rows
      .map((row) => row.agentId.trim())
      .filter((value): value is string => Boolean(value)),
  );
};

const upsertAgents = async (records: Map<string, IndexedAgentRecord>): Promise<number> => {
  if (records.size === 0) return 0;

  const addresses = Array.from(records.keys());
  const existing = await prisma.agent.findMany({
    where: { address: { in: addresses } },
    select: { address: true, agentId: true },
  });
  const existingSet = new Set(existing.map((row) => row.address));
  const existingByAddress = new Map(existing.map((row) => [row.address, row]));
  const usedAgentIds = await collectUsedAgentIds();
  const newCount = addresses.filter((address) => !existingSet.has(address)).length;

  for (const record of records.values()) {
    const current = existingByAddress.get(record.address);
    const resolvedAgentId = current?.agentId
      ? current.agentId
      : allocateUniqueAgentId(deriveAgentId(record), record.address, usedAgentIds);

    await prisma.agent.upsert({
      where: { address: record.address },
      create: {
        address: record.address,
        agentId: resolvedAgentId,
        name: record.name,
        creator: record.creator,
        owner: record.creator,
        image: record.image,
        description: record.description,
        telegram: record.telegram,
        twitter: record.twitter,
        website: record.website,
      },
      update: {
        agentId: resolvedAgentId,
        name: record.name,
        creator: record.creator,
        owner: record.creator,
        image: record.image,
        description: record.description,
        telegram: record.telegram,
        twitter: record.twitter,
        website: record.website,
      },
    });
  }

  return newCount;
};

const backfillAgentIdentityColumns = async (): Promise<number> => {
  const rows = await prisma.agent.findMany({
    where: {
      OR: [{ agentId: "" }, { owner: "" }],
    },
    select: {
      address: true,
      name: true,
      creator: true,
      owner: true,
      agentId: true,
    },
  });

  if (rows.length === 0) return 0;

  const usedAgentIds = await collectUsedAgentIds();
  let updatedCount = 0;

  for (const row of rows) {
    const resolvedAgentId = row.agentId.trim()
      ? row.agentId
      : allocateUniqueAgentId(deriveAgentId({ address: row.address, name: row.name }), row.address, usedAgentIds);
    const resolvedOwner = row.owner.trim() ? row.owner : row.creator;

    if (row.agentId === resolvedAgentId && row.owner === resolvedOwner) continue;

    await prisma.agent.update({
      where: { address: row.address },
      data: {
        agentId: resolvedAgentId,
        owner: resolvedOwner,
      },
    });

    updatedCount += 1;
  }

  return updatedCount;
};

async function main(): Promise<void> {
  if (FORCE_REFRESH_METADATA) {
    const stats = await forceRefreshServiceMetadata();
    console.log(
      `Forced metadata refresh complete: total=${stats.total}, rich_metadata=${stats.refreshed}, fallback=${stats.fallbackUsed}, unchanged=${stats.unchanged}.`,
    );
    return;
  }

  const client = buildClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = await getFromBlock();

  if (fromBlock > latestBlock) {
    const backfilledIdentityCount = await backfillAgentIdentityColumns();
    await persistCursor(latestBlock);
    console.log(`Indexed 0 new agents from block ${fromBlock.toString()} to ${latestBlock.toString()}.`);
    if (backfilledIdentityCount > 0) {
      console.log(`Backfilled identity fields for ${backfilledIdentityCount} existing agents.`);
    }
    return;
  }

  let records = await fetchAgentRegistered(fromBlock, latestBlock);
  if (records.size === 0 && process.env.AGENT_INDEXER_FALLBACK_CREATE_SERVICE !== "false") {
    console.warn("AgentRegistered logs not found in range. Falling back to CreateService indexing.");
    records = await fetchCreateServiceFallback(fromBlock, latestBlock);
  }

  const newCount = await upsertAgents(records);
  const backfilledIdentityCount = await backfillAgentIdentityColumns();
  const normalizedLegacyCount = await normalizeLegacyFallbackRows();
  await persistCursor(latestBlock);

  console.log(`Indexed ${newCount} new agents from block ${fromBlock.toString()} to ${latestBlock.toString()}.`);
  if (backfilledIdentityCount > 0) {
    console.log(`Backfilled identity fields for ${backfilledIdentityCount} existing agents.`);
  }
  if (normalizedLegacyCount > 0) {
    console.log(`Normalized ${normalizedLegacyCount} legacy fallback agent labels.`);
  }
}

main()
  .catch((error) => {
    console.error("Failed to index agents into Postgres:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
