import { createPublicClient, fallback, getAddress, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";
import { prisma } from "../lib/db";

type AgentIndexMode = "erc8004" | "olas";

const parseAgentIndexMode = (): AgentIndexMode => {
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1];
  const rawMode = (modeArg ?? process.env.AGENT_INDEX_MODE ?? "erc8004").trim().toLowerCase();
  return rawMode === "olas" ? "olas" : "erc8004";
};

const AGENT_INDEX_MODE = parseAgentIndexMode();
const DEFAULT_ERC8004_REGISTRY_ADDRESS = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const DEFAULT_OLAS_REGISTRY_ADDRESS = "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE";
const REGISTRY_ADDRESS = getAddress(
  process.env.ERC8004_REGISTRY_ADDRESS?.trim() ||
    (AGENT_INDEX_MODE === "olas" ? DEFAULT_OLAS_REGISTRY_ADDRESS : DEFAULT_ERC8004_REGISTRY_ADDRESS),
);
const CURSOR_KEY = AGENT_INDEX_MODE === "olas" ? "agent_indexer_olas" : "agent_indexer_erc8004";
const LEGACY_CURSOR_KEY = "agent_indexer";
const DEFAULT_START_BLOCK = 10_827_380n;
const MIN_CHUNK_SIZE = 2_000n;
const MAX_CHUNK_SIZE = 10_000n;
const CHUNK_SIZE = (() => {
  const raw = process.env.AGENT_INDEX_CHUNK_SIZE?.trim();
  if (!raw || !/^\d+$/.test(raw)) return MAX_CHUNK_SIZE;
  const parsed = BigInt(raw);
  if (parsed < MIN_CHUNK_SIZE) return MIN_CHUNK_SIZE;
  if (parsed > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
  return parsed;
})();
const CHUNK_DELAY_MS = (() => {
  const raw = process.env.AGENT_INDEX_CHUNK_DELAY_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 40;
  return Math.max(0, Math.min(parsed, 1_000));
})();
const METADATA_CONCURRENCY = (() => {
  const raw = process.env.AGENT_METADATA_CONCURRENCY?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 25;
  return Math.max(1, Math.min(parsed, 50));
})();
const METADATA_BATCH_DELAY_MS = (() => {
  const raw = process.env.AGENT_METADATA_BATCH_DELAY_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 120;
  return Math.max(0, Math.min(parsed, 2_000));
})();
const PRISMA_RETRY_ATTEMPTS = (() => {
  const raw = process.env.AGENT_PRISMA_RETRY_ATTEMPTS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 3;
  return Math.max(1, Math.min(parsed, 6));
})();
const PRISMA_RETRY_DELAY_MS = (() => {
  const raw = process.env.AGENT_PRISMA_RETRY_DELAY_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 750;
  return Math.max(100, Math.min(parsed, 5_000));
})();
const PRISMA_OPERATION_TIMEOUT_MS = (() => {
  const raw = process.env.AGENT_PRISMA_OPERATION_TIMEOUT_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 120_000;
  return Math.max(5_000, Math.min(parsed, 900_000));
})();
const PRISMA_CONNECTION_TIMEOUT_MS = (() => {
  const raw = process.env.AGENT_PRISMA_CONNECTION_TIMEOUT_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 12_000;
  return Math.max(2_000, Math.min(parsed, 60_000));
})();
const TOKEN_RESOLVE_TIMEOUT_MS = (() => {
  const raw = process.env.AGENT_TOKEN_RESOLVE_TIMEOUT_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 25_000;
  return Math.max(5_000, Math.min(parsed, 120_000));
})();
const INDEXER_RPC_URL =
  process.env.BASE_RPC_URL_INDEXER?.trim() || process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const INDEXER_RPC_ENV = process.env.BASE_RPC_URL_INDEXER?.trim()
  ? "BASE_RPC_URL_INDEXER"
  : process.env.BASE_RPC_URL?.trim()
    ? "BASE_RPC_URL"
    : "default";
const AGENT_FORCE_EXIT_ON_FINISH =
  process.env.AGENT_FORCE_EXIT_ON_FINISH?.trim().toLowerCase() === "true" ||
  process.env.CI?.trim().toLowerCase() === "true";

const AGENT_REGISTERED_EVENT = parseAbiItem(
  "event AgentRegistered(address indexed agent, string name, address indexed creator, string image, string description, string telegram, string twitter, string website)",
);
const CREATE_SERVICE_EVENT = parseAbiItem("event CreateService(uint256 indexed serviceId, bytes32 configHash)");
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const OWNER_OF_FUNCTION = parseAbiItem("function ownerOf(uint256 serviceId) view returns (address)");
const TOKEN_URI_FUNCTION = parseAbiItem("function tokenURI(uint256 serviceId) view returns (string)");
const FALLBACK_ADDRESS_PREFIX = "service:";
const ERC8004_ADDRESS_PREFIX = "agent:";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FORCE_REFRESH_METADATA =
  process.argv.includes("--force-refresh-metadata") || process.env.AGENT_FORCE_REFRESH_METADATA === "true";
const FORCE_RESET_INDEXER =
  process.argv.includes("--reset-indexer") || process.env.AGENT_RESET_INDEXER === "true";
const METADATA_FETCH_TIMEOUT_MS = 8_000;
const METADATA_FETCH_RETRY_COUNT = 2;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

type IndexedAgentRecord = {
  address: string;
  name: string;
  creator: string;
  owner: string;
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

type ServiceResolution = {
  serviceIdText: string;
  record: IndexedAgentRecord | null;
  metadataUsedFallback: boolean;
  resolveTimedOut?: boolean;
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

const withTimeout = async <T>(label: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const isRecoverablePrismaError = (error: unknown): boolean => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(postgresql connection|kind:\s*closed|connection.*closed|engine is not yet connected|response from the engine was empty|genericfailure|prismaclientunknownrequesterror|P1001|P1017|timeout|timed out|socket hang up|ECONNRESET|connection reset)/i.test(
    message,
  );
};

const resetPrismaConnection = async (attempt: number): Promise<void> => {
  try {
    await withTimeout("prisma.$disconnect", PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$disconnect());
  } catch (error) {
    console.warn(
      `prisma.$disconnect failed during retry reset (attempt ${attempt}/${PRISMA_RETRY_ATTEMPTS}). Continuing.`,
    );
    console.error(error);
  }

  await sleep(PRISMA_RETRY_DELAY_MS * attempt);

  try {
    await withTimeout("prisma.$connect", PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$connect());
  } catch (error) {
    console.warn(`prisma.$connect failed during retry reset (attempt ${attempt}/${PRISMA_RETRY_ATTEMPTS}).`);
    console.error(error);
  }
};

const withPrismaRetry = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= PRISMA_RETRY_ATTEMPTS; attempt += 1) {
    try {
      // Do not race Prisma queries against a JS timeout.
      // Promise.race timeout does not cancel in-flight Prisma engine work and can leave the engine
      // in a bad state during reconnect/retry ("Engine is not yet connected").
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRecoverablePrismaError(error) || attempt >= PRISMA_RETRY_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `${label} failed with recoverable Prisma error (attempt ${attempt}/${PRISMA_RETRY_ATTEMPTS}). Retrying...`,
      );
      console.error(error);

      await resetPrismaConnection(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed after retries`);
};

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
const fallbackErc8004Description = (tokenId: string): string =>
  `Fallback-indexed ERC-8004 token ${tokenId} (Transfer + ownerOf).`;
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

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const resolveServiceRecord = async (
  client: ContractReader,
  serviceId: bigint,
): Promise<ServiceResolution> => {
  const serviceIdText = serviceId.toString();
  try {
    const ownerResult = await client.readContract({
      address: REGISTRY_ADDRESS,
      abi: [OWNER_OF_FUNCTION],
      functionName: "ownerOf",
      args: [serviceId],
    });
    const ownerAddress = typeof ownerResult === "string" ? ownerResult : "";
    if (!ownerAddress) {
      throw new Error("ownerOf returned a non-string value");
    }

    const syntheticAddress = `${FALLBACK_ADDRESS_PREFIX}${serviceIdText}`;
    let metadata: ServiceMetadata | null = null;
    try {
      metadata = await fetchServiceMetadata(client, serviceId);
    } catch (error) {
      console.warn(
        `Metadata fetch failed for service ${serviceIdText}. Falling back to synthetic identity fields.`,
      );
      console.error(error);
    }

    if (!metadata) {
      console.warn(`Metadata is empty for service ${serviceIdText}. Falling back to synthetic identity fields.`);
    }

    return {
      serviceIdText,
      metadataUsedFallback: metadata == null,
      record: {
        address: syntheticAddress,
        name: metadata?.name ?? fallbackServiceName(serviceIdText),
        creator: getAddress(ownerAddress as Address).toLowerCase(),
        owner: getAddress(ownerAddress as Address).toLowerCase(),
        image: metadata?.image ?? null,
        description: metadata?.description ?? fallbackServiceDescription(serviceIdText),
        telegram: null,
        twitter: null,
        website: null,
      },
    };
  } catch (error) {
    console.warn(`Skipping service ${serviceIdText} in fallback due to ownerOf failure.`);
    console.error(error);
    return {
      serviceIdText,
      metadataUsedFallback: true,
      record: null,
    };
  }
};

const resolveErc8004Record = async (
  client: ContractReader,
  tokenId: bigint,
  creatorHint: string | null,
): Promise<ServiceResolution> => {
  const tokenIdText = tokenId.toString();
  try {
    const ownerResult = await client.readContract({
      address: REGISTRY_ADDRESS,
      abi: [OWNER_OF_FUNCTION],
      functionName: "ownerOf",
      args: [tokenId],
    });
    const ownerAddress = typeof ownerResult === "string" ? ownerResult : "";
    if (!ownerAddress) {
      throw new Error("ownerOf returned a non-string value");
    }

    const owner = getAddress(ownerAddress as Address).toLowerCase();
    let metadata: ServiceMetadata | null = null;
    try {
      metadata = await fetchServiceMetadata(client, tokenId);
    } catch (error) {
      console.warn(
        `Metadata fetch failed for ERC-8004 token ${tokenIdText}. Falling back to synthetic identity fields.`,
      );
      console.error(error);
    }

    if (!metadata) {
      console.warn(`Metadata is empty for ERC-8004 token ${tokenIdText}. Falling back to synthetic identity fields.`);
    }

    return {
      serviceIdText: tokenIdText,
      metadataUsedFallback: metadata == null,
      record: {
        address: `${ERC8004_ADDRESS_PREFIX}${tokenIdText}`,
        name: metadata?.name ?? fallbackServiceName(tokenIdText),
        creator: creatorHint ?? owner,
        owner,
        image: metadata?.image ?? null,
        description: metadata?.description ?? fallbackErc8004Description(tokenIdText),
        telegram: null,
        twitter: null,
        website: null,
      },
    };
  } catch (error) {
    console.warn(`Skipping ERC-8004 token ${tokenIdText} due to ownerOf failure.`);
    console.error(error);
    return {
      serviceIdText: tokenIdText,
      metadataUsedFallback: true,
      record: null,
    };
  }
};

const normalizeAddressOrNull = (value: string | null | undefined): string | null => {
  if (!value || value.trim().length === 0) return null;
  try {
    return getAddress(value as Address).toLowerCase();
  } catch {
    return null;
  }
};

const buildErc8004TimeoutFallbackRecord = (tokenIdText: string, creatorHint: string | null): IndexedAgentRecord => {
  const creator = normalizeAddressOrNull(creatorHint) ?? ZERO_ADDRESS;
  return {
    address: `${ERC8004_ADDRESS_PREFIX}${tokenIdText}`,
    name: fallbackServiceName(tokenIdText),
    creator,
    owner: creator,
    image: null,
    description: fallbackErc8004Description(tokenIdText),
    telegram: null,
    twitter: null,
    website: null,
  };
};

const resolveErc8004RecordWithTimeout = async (
  client: ContractReader,
  tokenId: bigint,
  creatorHint: string | null,
): Promise<ServiceResolution> => {
  const tokenIdText = tokenId.toString();
  try {
    return await withTimeout(`resolve ERC-8004 token ${tokenIdText}`, TOKEN_RESOLVE_TIMEOUT_MS, () =>
      resolveErc8004Record(client, tokenId, creatorHint),
    );
  } catch (error) {
    console.warn(
      `Resolve timeout for ERC-8004 token ${tokenIdText}. Writing fallback row and continuing index progress.`,
    );
    console.error(error);
    return {
      serviceIdText: tokenIdText,
      metadataUsedFallback: true,
      resolveTimedOut: true,
      record: buildErc8004TimeoutFallbackRecord(tokenIdText, creatorHint),
    };
  }
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
  if (!state && AGENT_INDEX_MODE === "olas") {
    const legacyState = await prisma.systemState.findUnique({ where: { key: LEGACY_CURSOR_KEY } });
    if (legacyState && legacyState.lastSyncedBlock > 0n) {
      return legacyState.lastSyncedBlock + 1n;
    }
  }
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

const resetIndexerState = async (): Promise<{ deletedAgents: number }> => {
  const deletedAgents = await prisma.agent.deleteMany();
  await prisma.systemState.deleteMany({
    where: {
      key: {
        in: AGENT_INDEX_MODE === "olas" ? [CURSOR_KEY, LEGACY_CURSOR_KEY] : [CURSOR_KEY],
      },
    },
  });
  return { deletedAgents: deletedAgents.count };
};

const buildClient = () =>
  createPublicClient({
    chain: base,
    transport: fallback([
      http(INDEXER_RPC_URL, {
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
        owner: creator,
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

  const serviceIdList = Array.from(serviceIds).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let processedServices = 0;
  let fallbackMetadataCount = 0;

  for (const batch of chunkArray(serviceIdList, METADATA_CONCURRENCY)) {
    const results = await Promise.all(
      batch.map((serviceId) => resolveServiceRecord(client as unknown as ContractReader, serviceId)),
    );

    for (const result of results) {
      if (result.metadataUsedFallback) fallbackMetadataCount += 1;
      if (!result.record) continue;
      indexed.set(result.record.address, result.record);
    }

    processedServices += batch.length;
    if (processedServices % 100 === 0 || processedServices === serviceIdList.length) {
      console.log(
        `Fallback metadata progress: ${processedServices}/${serviceIdList.length} services (fallback ${fallbackMetadataCount})`,
      );
    }

    if (processedServices < serviceIdList.length && METADATA_BATCH_DELAY_MS > 0) {
      await sleep(METADATA_BATCH_DELAY_MS);
    }
  }

  return indexed;
};

const indexErc8004Incremental = async (
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{
  newCount: number;
  totalResolvedTokens: number;
  fallbackMetadataCount: number;
  tokenResolveTimeoutCount: number;
}> => {
  const client = buildClient();
  const usedAgentIds = await withPrismaRetry("load used agent IDs", collectUsedAgentIds);
  let chunkIndex = 0;
  let newCount = 0;
  let totalResolvedTokens = 0;
  let fallbackMetadataCount = 0;
  let tokenResolveTimeoutCount = 0;

  let currentBlock = fromBlock;
  while (currentBlock <= toBlock) {
    const chunkToBlock = currentBlock + CHUNK_SIZE <= toBlock ? currentBlock + CHUNK_SIZE : toBlock;
    chunkIndex += 1;
    if (chunkIndex % 20 === 1) {
      console.log(`ERC-8004 scan Transfer logs from ${currentBlock.toString()} to ${chunkToBlock.toString()}`);
    }

    let logs:
      | Awaited<ReturnType<typeof client.getLogs<typeof TRANSFER_EVENT>>>
      | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        logs = await client.getLogs({
          address: REGISTRY_ADDRESS,
          event: TRANSFER_EVENT,
          fromBlock: currentBlock,
          toBlock: chunkToBlock,
          strict: true,
        });
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `Transfer chunk fetch failed for ${currentBlock.toString()}-${chunkToBlock.toString()} (attempt ${attempt}/2).`,
        );
        if (attempt < 2) await sleep(CHUNK_DELAY_MS);
      }
    }

    if (!logs) {
      const message = `Failed to fetch Transfer logs for chunk ${currentBlock.toString()}-${chunkToBlock.toString()} after retries.`;
      console.error(message);
      console.error(lastError);
      throw new Error(message);
    }

    const creatorByTokenId = new Map<string, string | null>();
    const tokenIds = new Set<bigint>();

    for (const log of logs) {
      if (log.args.tokenId == null) continue;
      const tokenId = log.args.tokenId;
      tokenIds.add(tokenId);

      const tokenIdText = tokenId.toString();
      if (!creatorByTokenId.has(tokenIdText)) {
        creatorByTokenId.set(tokenIdText, null);
      }

      const fromAddress = typeof log.args.from === "string" ? log.args.from.toLowerCase() : "";
      const toAddress = typeof log.args.to === "string" ? log.args.to : null;
      if (fromAddress === ZERO_ADDRESS && toAddress) {
        try {
          creatorByTokenId.set(tokenIdText, getAddress(toAddress as Address).toLowerCase());
        } catch {
          // Ignore malformed mint event recipient.
        }
      }
    }

    const tokenIdList = Array.from(tokenIds).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let chunkFallbackMetadataCount = 0;
    let chunkResolvedTokens = 0;
    const chunkRecords = new Map<string, IndexedAgentRecord>();

    for (const batch of chunkArray(tokenIdList, METADATA_CONCURRENCY)) {
      const results = await Promise.all(
        batch.map((tokenId) =>
          resolveErc8004RecordWithTimeout(
            client as unknown as ContractReader,
            tokenId,
            creatorByTokenId.get(tokenId.toString()) ?? null,
          ),
        ),
      );

      for (const result of results) {
        if (result.metadataUsedFallback) chunkFallbackMetadataCount += 1;
        if (result.resolveTimedOut) tokenResolveTimeoutCount += 1;
        if (!result.record) continue;
        chunkRecords.set(result.record.address, result.record);
      }

      chunkResolvedTokens += batch.length;
      totalResolvedTokens += batch.length;
      if (chunkResolvedTokens % 100 === 0 || chunkResolvedTokens === tokenIdList.length) {
        console.log(
          `ERC-8004 metadata progress (chunk ${currentBlock.toString()}-${chunkToBlock.toString()}): ${chunkResolvedTokens}/${tokenIdList.length}`,
        );
      }

      if (chunkResolvedTokens < tokenIdList.length && METADATA_BATCH_DELAY_MS > 0) {
        await sleep(METADATA_BATCH_DELAY_MS);
      }
    }

    if (chunkRecords.size > 0) {
      const chunkNewCount = await withPrismaRetry(
        `upsert ERC-8004 agents for chunk ${currentBlock.toString()}-${chunkToBlock.toString()}`,
        () => upsertAgents(chunkRecords, usedAgentIds),
      );
      newCount += chunkNewCount;
    }

    fallbackMetadataCount += chunkFallbackMetadataCount;
    await withPrismaRetry(
      `persist ERC-8004 cursor for chunk ending ${chunkToBlock.toString()}`,
      () => persistCursor(chunkToBlock),
    );

    if (chunkIndex % 10 === 0 || chunkToBlock === toBlock) {
      console.log(
        `Chunk checkpoint: blocks ${currentBlock.toString()}-${chunkToBlock.toString()}, chunk_tokens=${tokenIdList.length}, total_tokens=${totalResolvedTokens}, new_agents=${newCount}, metadata_fallback=${fallbackMetadataCount}, token_timeouts=${tokenResolveTimeoutCount}`,
      );
    }

    currentBlock = chunkToBlock + 1n;
    if (currentBlock <= toBlock) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return {
    newCount,
    totalResolvedTokens,
    fallbackMetadataCount,
    tokenResolveTimeoutCount,
  };
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
  const client = buildClient() as unknown as ContractReader;
  const rows = await prisma.agent.findMany({
    where: { address: { startsWith: FALLBACK_ADDRESS_PREFIX } },
    select: { address: true, name: true, description: true, image: true, owner: true, creator: true },
  });

  let refreshed = 0;
  let fallbackUsed = 0;
  let unchanged = 0;
  let processed = 0;

  const refreshRow = async (row: (typeof rows)[number]): Promise<{
    refreshed: boolean;
    fallbackUsed: boolean;
    unchanged: boolean;
  }> => {
    const serviceIdText = row.address.slice(FALLBACK_ADDRESS_PREFIX.length);
    if (!/^\d+$/.test(serviceIdText)) {
      return { refreshed: false, fallbackUsed: false, unchanged: true };
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
      metadata = await fetchServiceMetadata(client, serviceId);
    } catch (error) {
      console.warn(`Metadata fetch failed for service ${serviceIdText} during refresh. Falling back to synthetic values.`);
      console.error(error);
    }

    const nextName = metadata?.name ?? fallbackServiceName(serviceIdText);
    const nextDescription = metadata?.description ?? fallbackServiceDescription(serviceIdText);
    const nextImage = metadata?.image ?? null;

    if (
      row.name === nextName &&
      row.description === nextDescription &&
      row.image === nextImage &&
      row.owner === owner &&
      row.creator === owner
    ) {
      return { refreshed: metadata != null, fallbackUsed: metadata == null, unchanged: true };
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

    return { refreshed: metadata != null, fallbackUsed: metadata == null, unchanged: false };
  };

  for (const batch of chunkArray(rows, METADATA_CONCURRENCY)) {
    const results = await Promise.all(batch.map((row) => refreshRow(row)));
    processed += batch.length;

    for (const result of results) {
      if (result.refreshed) refreshed += 1;
      if (result.fallbackUsed) fallbackUsed += 1;
      if (result.unchanged) unchanged += 1;
    }

    if (processed % 10 === 0 || processed === rows.length) {
      console.log(`Metadata refresh progress: ${processed}/${rows.length} agents`);
    }
    if (processed < rows.length && METADATA_BATCH_DELAY_MS > 0) {
      await sleep(METADATA_BATCH_DELAY_MS);
    }
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

const upsertAgents = async (records: Map<string, IndexedAgentRecord>, usedAgentIds?: Set<string>): Promise<number> => {
  if (records.size === 0) return 0;

  const addresses = Array.from(records.keys());
  const existing = await prisma.agent.findMany({
    where: { address: { in: addresses } },
    select: { address: true, agentId: true },
  });
  const existingSet = new Set(existing.map((row) => row.address));
  const existingByAddress = new Map(existing.map((row) => [row.address, row]));
  const resolvedUsedAgentIds = usedAgentIds ?? (await collectUsedAgentIds());
  const newCount = addresses.filter((address) => !existingSet.has(address)).length;

  let processed = 0;
  for (const record of records.values()) {
    const current = existingByAddress.get(record.address);
    const resolvedAgentId = current?.agentId
      ? current.agentId
      : allocateUniqueAgentId(deriveAgentId(record), record.address, resolvedUsedAgentIds);

    await prisma.agent.upsert({
      where: { address: record.address },
      create: {
        address: record.address,
        agentId: resolvedAgentId,
        name: record.name,
        creator: record.creator,
        owner: record.owner,
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
        owner: record.owner,
        image: record.image,
        description: record.description,
        telegram: record.telegram,
        twitter: record.twitter,
        website: record.website,
      },
    });

    processed += 1;
    if (processed % 250 === 0 || processed === records.size) {
      console.log(`Prisma upsert progress: ${processed}/${records.size}`);
    }
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
  console.log(
    `Indexer config: mode=${AGENT_INDEX_MODE}, cursor_key=${CURSOR_KEY}, chunk_size=${CHUNK_SIZE.toString()} blocks, chunk_delay_ms=${CHUNK_DELAY_MS}, metadata_concurrency=${METADATA_CONCURRENCY}, metadata_batch_delay_ms=${METADATA_BATCH_DELAY_MS}, prisma_retry_attempts=${PRISMA_RETRY_ATTEMPTS}, prisma_retry_delay_ms=${PRISMA_RETRY_DELAY_MS}, prisma_op_timeout_ms=${PRISMA_OPERATION_TIMEOUT_MS}, prisma_conn_timeout_ms=${PRISMA_CONNECTION_TIMEOUT_MS}, token_resolve_timeout_ms=${TOKEN_RESOLVE_TIMEOUT_MS}, rpc_env=${INDEXER_RPC_ENV}`,
  );

  if (FORCE_RESET_INDEXER) {
    const resetResult = await resetIndexerState();
    console.log(
      `Indexer reset complete: deleted_agents=${resetResult.deletedAgents}. Cursor cleared. Full re-index will start from block ${parseStartBlock().toString()}.`,
    );
  }

  if (FORCE_REFRESH_METADATA) {
    if (AGENT_INDEX_MODE !== "olas") {
      console.warn("Forced metadata refresh currently supports Olas service identities only. Skipping.");
      return;
    }
    const stats = await forceRefreshServiceMetadata();
    console.log(
      `Forced metadata refresh complete: total=${stats.total}, rich_metadata=${stats.refreshed}, fallback=${stats.fallbackUsed}, unchanged=${stats.unchanged}.`,
    );
    return;
  }

  const client = buildClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = await withPrismaRetry("read index cursor", () => getFromBlock());

  if (fromBlock > latestBlock) {
    const backfilledIdentityCount = await withPrismaRetry("backfill identity fields", () => backfillAgentIdentityColumns());
    await withPrismaRetry(`persist cursor ${latestBlock.toString()}`, () => persistCursor(latestBlock));
    console.log(`Indexed 0 new agents from block ${fromBlock.toString()} to ${latestBlock.toString()}.`);
    if (backfilledIdentityCount > 0) {
      console.log(`Backfilled identity fields for ${backfilledIdentityCount} existing agents.`);
    }
    return;
  }

  let newCount = 0;
  if (AGENT_INDEX_MODE === "erc8004") {
    const stats = await indexErc8004Incremental(fromBlock, latestBlock);
    newCount = stats.newCount;
    console.log(
      `ERC-8004 indexing summary: resolved_tokens=${stats.totalResolvedTokens}, metadata_fallback=${stats.fallbackMetadataCount}, token_timeouts=${stats.tokenResolveTimeoutCount}, new_agents=${stats.newCount}.`,
    );
  } else {
    let records = await fetchAgentRegistered(fromBlock, latestBlock);
    if (records.size === 0 && process.env.AGENT_INDEXER_FALLBACK_CREATE_SERVICE !== "false") {
      console.warn("AgentRegistered logs not found in range. Falling back to CreateService indexing.");
      records = await fetchCreateServiceFallback(fromBlock, latestBlock);
    }
    newCount = await withPrismaRetry("upsert Olas agent records", () => upsertAgents(records));
    await withPrismaRetry(`persist cursor ${latestBlock.toString()}`, () => persistCursor(latestBlock));
  }

  const backfilledIdentityCount = await withPrismaRetry("backfill identity fields", () => backfillAgentIdentityColumns());
  const normalizedLegacyCount =
    AGENT_INDEX_MODE === "olas"
      ? await withPrismaRetry("normalize legacy fallback labels", () => normalizeLegacyFallbackRows())
      : 0;
  if (AGENT_INDEX_MODE === "erc8004") {
    await withPrismaRetry(`persist cursor ${latestBlock.toString()}`, () => persistCursor(latestBlock));
  }

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
    try {
      await withTimeout("index prisma.$disconnect (final)", PRISMA_CONNECTION_TIMEOUT_MS, () => prisma.$disconnect());
    } catch (disconnectError) {
      console.error("Failed to disconnect Prisma cleanly:", disconnectError);
    }
    if (AGENT_FORCE_EXIT_ON_FINISH) {
      process.exit(process.exitCode ?? 0);
    }
  });
