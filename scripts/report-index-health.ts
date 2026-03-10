import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { prisma } from "../lib/db";

type AgentIndexMode = "erc8004" | "olas";

const AGENT_INDEX_MODE: AgentIndexMode =
  process.env.AGENT_INDEX_MODE?.trim().toLowerCase() === "olas" ? "olas" : "erc8004";

const CURSOR_KEY = AGENT_INDEX_MODE === "olas" ? "agent_indexer_olas" : "agent_indexer_erc8004";
const INDEXER_RPC_URL =
  process.env.BASE_RPC_URL?.trim() || process.env.BASE_RPC_URL_INDEXER?.trim() || "https://mainnet.base.org";
const INDEXER_RPC_ENV = process.env.BASE_RPC_URL?.trim()
  ? "BASE_RPC_URL"
  : process.env.BASE_RPC_URL_INDEXER?.trim()
    ? "BASE_RPC_URL_INDEXER"
    : "default";
const AVERAGE_BASE_BLOCK_TIME_SECONDS = 2;

const main = async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(INDEXER_RPC_URL),
  });

  const [cursor, latestBlock, agentCount, inputCount, activeSnapshot] = await Promise.all([
    prisma.systemState.findUnique({
      where: { key: CURSOR_KEY },
      select: { key: true, lastSyncedBlock: true },
    }),
    client.getBlockNumber(),
    prisma.agent.count(),
    prisma.agentScoreInput.count(),
    prisma.leaderboardSnapshot.findFirst({
      where: { isActive: true, status: "READY" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        completedAt: true,
        totalAgents: true,
      },
    }),
  ]);

  const lastSyncedBlock = cursor?.lastSyncedBlock ?? null;
  const lagBlocks = lastSyncedBlock == null ? null : latestBlock - lastSyncedBlock;
  const lagSeconds = lagBlocks == null ? null : Number(lagBlocks) * AVERAGE_BASE_BLOCK_TIME_SECONDS;
  const lagMinutes = lagSeconds == null ? null : Math.round((lagSeconds / 60) * 100) / 100;

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: AGENT_INDEX_MODE,
        rpcEnv: INDEXER_RPC_ENV,
        cursorKey: CURSOR_KEY,
        lastSyncedBlock: lastSyncedBlock?.toString() ?? null,
        latestBlock: latestBlock.toString(),
        lagBlocks: lagBlocks?.toString() ?? null,
        lagMinutes,
        counts: {
          agents: agentCount,
          agentScoreInputs: inputCount,
        },
        activeSnapshot: activeSnapshot
          ? {
              id: activeSnapshot.id,
              totalAgents: activeSnapshot.totalAgents,
              createdAt: activeSnapshot.createdAt.toISOString(),
              completedAt: activeSnapshot.completedAt?.toISOString() ?? null,
            }
          : null,
      },
      null,
      2,
    ),
  );
};

main()
  .catch((error) => {
    console.error("report-index-health failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
