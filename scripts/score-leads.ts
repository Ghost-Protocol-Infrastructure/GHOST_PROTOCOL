import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

const INPUT_PATH = join(process.cwd(), "data", "base-agents.json");
const OUTPUT_PATH = join(process.cwd(), "data", "leads-scored.json");
const CONCURRENCY_LIMIT = 5;
const BATCH_DELAY_MS = 100;

type Tier = "WHALE" | "ACTIVE" | "NEW";

type BaseAgent = {
  agentId: string;
  owner: Address;
  monetized?: boolean;
};

type ScoredLead = {
  agentId: string;
  owner: Address;
  txCount: number;
  tier: Tier;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getTier = (txCount: number): Tier => {
  if (txCount > 500) return "WHALE";
  if (txCount > 50) return "ACTIVE";
  return "NEW";
};

async function main(): Promise<void> {
  const raw = await readFile(INPUT_PATH, "utf8");
  const agents = JSON.parse(raw) as BaseAgent[];

  const publicClient = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org", {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });

  const ownerByLowercase = new Map<string, Address>();
  for (const agent of agents) {
    ownerByLowercase.set(agent.owner.toLowerCase(), agent.owner);
  }

  const uniqueOwners = Array.from(ownerByLowercase.entries());
  const txCountByOwnerLower = new Map<string, number>();

  for (let index = 0; index < uniqueOwners.length; index += CONCURRENCY_LIMIT) {
    const batch = uniqueOwners.slice(index, index + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map(async ([ownerLower, owner]) => {
        try {
          const txCount = await publicClient.getTransactionCount({ address: owner });
          txCountByOwnerLower.set(ownerLower, Number(txCount));
        } catch (error) {
          txCountByOwnerLower.set(ownerLower, 0);
          console.warn(`Failed to fetch txCount for ${owner}. Defaulting to 0.`);
          console.error(error);
        }
      }),
    );

    if (index + CONCURRENCY_LIMIT < uniqueOwners.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const scored: ScoredLead[] = agents.map((agent) => {
    const txCount = txCountByOwnerLower.get(agent.owner.toLowerCase()) ?? 0;
    return {
      agentId: agent.agentId,
      owner: agent.owner,
      txCount,
      tier: getTier(txCount),
    };
  });

  const whaleOwners = new Set(
    uniqueOwners
      .filter(([ownerLower]) => (txCountByOwnerLower.get(ownerLower) ?? 0) > 500)
      .map(([ownerLower]) => ownerLower),
  );

  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(scored, null, 2), "utf8");

  console.log(`Scored ${uniqueOwners.length} unique owners. Found ${whaleOwners.size} Whales.`);
  console.log(`Saved scored leads to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Failed to score leads:", error);
  process.exitCode = 1;
});

