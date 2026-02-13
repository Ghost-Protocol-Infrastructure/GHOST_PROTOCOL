import { randomInt } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";

const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const REGISTRY_ADDRESS = getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
const AGENTS_OUT_FILE = process.env.AGENTS_OUT_FILE ?? "agents.json";

const POLL_INTERVAL_MS = parseIntEnv("POLL_INTERVAL_MS", 10_000, { min: 1_000 });
const MAX_EVENTS = parseIntEnv("MAX_EVENTS", 100, { min: 1, max: 500 });
const LOG_BLOCK_CHUNK_SIZE = parseIntEnv("LOG_BLOCK_CHUNK_SIZE", 20_000, { min: 100 });
const MIN_LOG_BLOCK_CHUNK_SIZE = parseIntEnv("MIN_LOG_BLOCK_CHUNK_SIZE", 1_000, { min: 100 });
const MAX_SCAN_BLOCKS = parseIntEnv("MAX_SCAN_BLOCKS", 200_000, { min: 1_000 });

const TRUST_SCORE_MIN = 80;
const TRUST_SCORE_MAX = 99;
const TPS_MIN = 1_000;
const TPS_MAX = 5_000;

const AGENT_REGISTERED_EVENT = parseAbiItem(
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string metadataURI)",
);

type BasePublicClient = PublicClient<ReturnType<typeof http>, typeof base>;

interface RegisteredAgentEvent {
  agentId: bigint;
  owner: Address;
  blockNumber: bigint;
  logIndex: number;
}

interface IndexedAgent {
  name: string;
  address: Address;
  score: number;
  tps: number;
}

interface AgentsFile {
  updatedAt: string;
  network: "base-mainnet";
  rpcUrl: string;
  registryAddress: Address;
  fetchedEvents: number;
  agents: IndexedAgent[];
}

class ConfigError extends Error {
  override name = "ConfigError";
}

function parseIntEnv(
  name: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer. Got: ${raw}`);
  }
  if (opts?.min != null && value < opts.min) {
    throw new ConfigError(`${name} must be >= ${opts.min}. Got: ${raw}`);
  }
  if (opts?.max != null && value > opts.max) {
    throw new ConfigError(`${name} must be <= ${opts.max}. Got: ${raw}`);
  }
  return value;
}

function randomIntInclusive(min: number, max: number): number {
  return randomInt(min, max + 1);
}

function compareByRecencyDesc(a: RegisteredAgentEvent, b: RegisteredAgentEvent): number {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber > b.blockNumber ? -1 : 1;
  }
  if (a.logIndex !== b.logIndex) {
    return a.logIndex > b.logIndex ? -1 : 1;
  }
  return 0;
}

function isBlockRangeTooLargeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("range is too large") || message.includes("eth_getlogs");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const absPath = path.resolve(process.cwd(), filePath);
  const dir = path.dirname(absPath);
  const baseName = path.basename(absPath);
  const tempPath = path.join(dir, `.${baseName}.tmp-${process.pid}-${Date.now()}`);
  const json = `${JSON.stringify(value, null, 2)}\n`;

  await writeFile(tempPath, json, "utf8");

  try {
    await rename(tempPath, absPath);
  } catch {
    try {
      await unlink(absPath);
    } catch {
      // Ignore if destination file does not exist yet.
    }
    try {
      await rename(tempPath, absPath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore cleanup failures.
      }
      throw error;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Aborted"));
    };

    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchLatestRegisteredAgentEvents(
  client: BasePublicClient,
  maxEvents = MAX_EVENTS,
): Promise<RegisteredAgentEvent[]> {
  const latestBlock = await client.getBlockNumber();
  const maxScanSpan = BigInt(MAX_SCAN_BLOCKS - 1);
  const oldestAllowedBlock = latestBlock > maxScanSpan ? latestBlock - maxScanSpan : 0n;
  let toBlock = latestBlock;
  let chunkSize = LOG_BLOCK_CHUNK_SIZE;
  const collected: RegisteredAgentEvent[] = [];

  while (collected.length < maxEvents && toBlock >= oldestAllowedBlock) {
    const fromBlock =
      toBlock >= BigInt(chunkSize) ? toBlock - BigInt(chunkSize) + 1n : oldestAllowedBlock;
    const boundedFromBlock = fromBlock < oldestAllowedBlock ? oldestAllowedBlock : fromBlock;

    let logs: Awaited<ReturnType<BasePublicClient["getLogs"]>>;
    try {
      logs = await client.getLogs({
        address: REGISTRY_ADDRESS,
        event: AGENT_REGISTERED_EVENT,
        fromBlock: boundedFromBlock,
        toBlock,
      });
    } catch (error) {
      if (isBlockRangeTooLargeError(error) && chunkSize > MIN_LOG_BLOCK_CHUNK_SIZE) {
        chunkSize = Math.max(MIN_LOG_BLOCK_CHUNK_SIZE, Math.floor(chunkSize / 2));
        continue;
      }
      throw error;
    }

    for (const log of logs) {
      const args = (log as { args?: { agentId?: bigint; owner?: Address } }).args;
      if (args?.agentId == null || args.owner == null) continue;
      collected.push({
        agentId: args.agentId,
        owner: getAddress(args.owner),
        blockNumber: log.blockNumber ?? 0n,
        logIndex: Number(log.logIndex ?? -1),
      });
    }

    if (boundedFromBlock === 0n || boundedFromBlock === oldestAllowedBlock) break;
    toBlock = boundedFromBlock - 1n;
  }

  collected.sort(compareByRecencyDesc);
  return collected.slice(0, maxEvents);
}

export async function fetchTopAgents(
  client: BasePublicClient,
  maxEvents = MAX_EVENTS,
): Promise<IndexedAgent[]> {
  const recentEvents = await fetchLatestRegisteredAgentEvents(client, maxEvents);

  return recentEvents.map((entry) => ({
    name: `Agent #${entry.agentId.toString()}`,
    address: entry.owner,
    score: randomIntInclusive(TRUST_SCORE_MIN, TRUST_SCORE_MAX),
    tps: randomIntInclusive(TPS_MIN, TPS_MAX),
  }));
}

async function updateOnce(client: BasePublicClient): Promise<void> {
  const agents = await fetchTopAgents(client, MAX_EVENTS);
  const payload: AgentsFile = {
    updatedAt: new Date().toISOString(),
    network: "base-mainnet",
    rpcUrl: RPC_URL,
    registryAddress: REGISTRY_ADDRESS,
    fetchedEvents: agents.length,
    agents,
  };

  await writeJsonAtomic(AGENTS_OUT_FILE, payload);

  // eslint-disable-next-line no-console
  console.log(
    `[${payload.updatedAt}] indexed ${payload.fetchedEvents} agents from Base -> ${AGENTS_OUT_FILE}`,
  );
}

async function main() {
  const runOnce = process.argv.includes("--once");

  const client = createPublicClient({
    chain: base,
    transport: http(RPC_URL, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });

  if (runOnce) {
    // eslint-disable-next-line no-console
    console.log("Running in CI Mode (One-Shot)...");
    await updateOnce(client);
    // eslint-disable-next-line no-console
    console.log("Data Updated.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log("Running in Dev Mode (Polling)...");
  // eslint-disable-next-line no-console
  console.log(
    `Base indexer started. rpc=${RPC_URL} registry=${REGISTRY_ADDRESS} maxEvents=${MAX_EVENTS} intervalMs=${POLL_INTERVAL_MS}`,
  );

  const abort = new AbortController();
  const stop = (reason: string) => {
    if (abort.signal.aborted) return;
    abort.abort(new Error(reason));
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("Unhandled promise rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    // eslint-disable-next-line no-console
    console.error("Uncaught exception:", error);
    stop("uncaughtException");
  });

  while (!abort.signal.aborted) {
    try {
      await updateOnce(client);
      // eslint-disable-next-line no-console
      console.log("Data Updated.");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[${new Date().toISOString()}] indexer tick failed:`, error);
    }

    try {
      await sleep(POLL_INTERVAL_MS, abort.signal);
    } catch {
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log("Base indexer stopped.");
}

await main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", error);
  process.exit(1);
});
