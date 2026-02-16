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
  return 100_000n;
})();
const CHUNK_DELAY_MS = 100;
const OWNER_READ_DELAY_MS = 120;

const AGENT_REGISTERED_EVENT = parseAbiItem(
  "event AgentRegistered(address indexed agent, string name, address indexed creator, string image, string description, string telegram, string twitter, string website)",
);
const CREATE_SERVICE_EVENT = parseAbiItem("event CreateService(uint256 indexed serviceId, bytes32 configHash)");
const OWNER_OF_FUNCTION = parseAbiItem("function ownerOf(uint256 serviceId) view returns (address)");

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

      const syntheticAddress = `service:${serviceId.toString()}`;
      indexed.set(syntheticAddress, {
        address: syntheticAddress,
        name: `Service ${serviceId.toString()}`,
        creator: getAddress(owner).toLowerCase(),
        image: null,
        description: null,
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

const upsertAgents = async (records: Map<string, IndexedAgentRecord>): Promise<number> => {
  if (records.size === 0) return 0;

  const addresses = Array.from(records.keys());
  const existing = await prisma.agent.findMany({
    where: { address: { in: addresses } },
    select: { address: true },
  });
  const existingSet = new Set(existing.map((row) => row.address));
  const newCount = addresses.filter((address) => !existingSet.has(address)).length;

  for (const record of records.values()) {
    await prisma.agent.upsert({
      where: { address: record.address },
      create: {
        address: record.address,
        name: record.name,
        creator: record.creator,
        image: record.image,
        description: record.description,
        telegram: record.telegram,
        twitter: record.twitter,
        website: record.website,
      },
      update: {
        name: record.name,
        creator: record.creator,
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

async function main(): Promise<void> {
  const client = buildClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = await getFromBlock();

  if (fromBlock > latestBlock) {
    await persistCursor(latestBlock);
    console.log(`Indexed 0 new agents from block ${fromBlock.toString()} to ${latestBlock.toString()}.`);
    return;
  }

  let records = await fetchAgentRegistered(fromBlock, latestBlock);
  if (records.size === 0 && process.env.AGENT_INDEXER_FALLBACK_CREATE_SERVICE !== "false") {
    console.warn("AgentRegistered logs not found in range. Falling back to CreateService indexing.");
    records = await fetchCreateServiceFallback(fromBlock, latestBlock);
  }

  const newCount = await upsertAgents(records);
  await persistCursor(latestBlock);

  console.log(`Indexed ${newCount} new agents from block ${fromBlock.toString()} to ${latestBlock.toString()}.`);
}

main()
  .catch((error) => {
    console.error("Failed to index agents into Postgres:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
