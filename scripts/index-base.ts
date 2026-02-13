import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, fallback, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";

const REGISTRY_ADDRESS: Address = "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE";
const START_BLOCK = 23000000n;
const CHUNK_SIZE = 10_000n;
const CHUNK_DELAY_MS = 100;
const OWNER_READ_DELAY_MS = 120;
const OUTPUT_PATH = join(process.cwd(), "data", "base-agents.json");

const CREATE_SERVICE_EVENT = parseAbiItem(
  "event CreateService(uint256 indexed serviceId, bytes32 configHash)",
);
const OWNER_OF_FUNCTION = parseAbiItem("function ownerOf(uint256 serviceId) view returns (address)");

type IndexedAgent = {
  agentId: string;
  owner: Address;
  monetized: boolean;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const publicClient = createPublicClient({
    chain: base,
    transport: fallback([
      http("https://mainnet.base.org", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
      http("https://base.llamarpc.com", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
      http("https://1rpc.io/base", { retryCount: 2, retryDelay: 250, timeout: 15_000 }),
    ]),
  });

  let logs: Awaited<ReturnType<typeof publicClient.getLogs<typeof CREATE_SERVICE_EVENT>>>;
  try {
    const latestBlock = await publicClient.getBlockNumber();
    logs = [];

    let currentBlock = START_BLOCK;
    while (currentBlock < latestBlock) {
      const toBlock = currentBlock + CHUNK_SIZE <= latestBlock ? currentBlock + CHUNK_SIZE : latestBlock;
      console.log("Fetching blocks", currentBlock.toString(), "to", toBlock.toString());

      let chunk: Awaited<ReturnType<typeof publicClient.getLogs<typeof CREATE_SERVICE_EVENT>>> | null = null;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          chunk = await publicClient.getLogs({
            address: REGISTRY_ADDRESS,
            event: CREATE_SERVICE_EVENT,
            fromBlock: currentBlock,
            toBlock,
            strict: true,
          });
          break;
        } catch (error) {
          lastError = error;
          console.warn(
            `Chunk fetch failed for ${currentBlock.toString()}-${toBlock.toString()} (attempt ${attempt}/2).`,
          );
          if (attempt < 2) {
            await sleep(CHUNK_DELAY_MS);
          }
        }
      }

      if (chunk) {
        logs.push(...chunk);
      } else {
        console.error(`Skipping chunk ${currentBlock.toString()}-${toBlock.toString()} after retry.`);
        console.error(lastError);
      }

      currentBlock += CHUNK_SIZE;
      await sleep(CHUNK_DELAY_MS);
    }
  } catch (error) {
    console.error("RPC ERROR: Failed to fetch CreateService events from Base Mainnet.");
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const serviceIds = Array.from(
    new Set(
      logs.flatMap((log) => (log.args.serviceId == null ? [] : [log.args.serviceId.toString()])),
    ),
  ).map((id) => BigInt(id));

  const agents: IndexedAgent[] = [];
  for (let index = 0; index < serviceIds.length; index += 1) {
    const serviceId = serviceIds[index];

    try {
      const owner = await publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: [OWNER_OF_FUNCTION],
        functionName: "ownerOf",
        args: [serviceId],
      });

      agents.push({
        agentId: serviceId.toString(),
        owner,
        monetized: false,
      });
    } catch (error) {
      console.warn(`Skipping service ${serviceId.toString()} due to ownerOf read failure.`);
      console.error(error);
    }

    if (index < serviceIds.length - 1) {
      await sleep(OWNER_READ_DELAY_MS);
    }
  }

  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(agents, null, 2), "utf8");

  console.log(`Indexed ${agents.length} Agents from Base Mainnet.`);
  console.log(`Saved index to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Unexpected indexer failure:", error);
  process.exitCode = 1;
});
