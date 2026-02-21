import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, parseEther, type AbiEvent, type Address } from "viem";
import { base } from "viem/chains";
import { GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "@/lib/constants";
import { getCreditBalance, syncDeposits } from "@/lib/db";

export const runtime = "nodejs";

const DEFAULT_CREDIT_PRICE_WEI = 10_000_000_000_000n; // 0.00001 ETH
const DEFAULT_MAX_BLOCKS_PER_SYNC_REQUEST = 500n;
const DEFAULT_LOG_CHUNK_SIZE = 500n;
const MIN_LOG_CHUNK_SIZE = 10n;

const getCreditPriceWei = (): bigint => {
  const rawWei = process.env.GHOST_CREDIT_PRICE_WEI?.trim();
  if (rawWei && /^\d+$/.test(rawWei)) return BigInt(rawWei);

  const rawEth = process.env.GHOST_CREDIT_PRICE_ETH?.trim();
  if (rawEth) {
    try {
      return parseEther(rawEth);
    } catch {
      // Fall back to default below.
    }
  }

  return DEFAULT_CREDIT_PRICE_WEI;
};

const CREDIT_PRICE_WEI = getCreditPriceWei();

const START_BLOCK = (() => {
  const raw = process.env.GHOST_VAULT_DEPLOYMENT_BLOCK?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0n;
  return BigInt(raw);
})();

const parsePositiveBigIntEnv = (value: string | undefined, fallback: bigint): bigint => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) return fallback;
  return parsed;
};

const MAX_BLOCKS_PER_SYNC_REQUEST = parsePositiveBigIntEnv(
  process.env.GHOST_SYNC_CREDITS_MAX_BLOCKS_PER_REQUEST,
  DEFAULT_MAX_BLOCKS_PER_SYNC_REQUEST,
);

const INITIAL_LOG_CHUNK_SIZE = parsePositiveBigIntEnv(
  process.env.GHOST_SYNC_CREDITS_LOG_CHUNK_SIZE,
  DEFAULT_LOG_CHUNK_SIZE,
);

const parseSuggestedProviderWindow = (error: unknown): bigint | null => {
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/\[(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\]/);
  if (!match) return null;

  const lower = BigInt(match[1]);
  const upper = BigInt(match[2]);
  if (upper < lower) return null;
  const window = upper - lower + 1n;
  if (window <= 0n) return null;
  return window;
};

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org"),
});

const depositedEvent = GHOST_VAULT_ABI.find(
  (item): item is AbiEvent => item.type === "event" && item.name === "Deposited",
);

if (!depositedEvent) {
  throw new Error("GhostVault ABI does not contain Deposited event.");
}

const parseUserAddress = async (request: NextRequest): Promise<Address | null> => {
  const fromQuery = request.nextUrl.searchParams.get("userAddress");
  if (fromQuery) {
    try {
      return getAddress(fromQuery);
    } catch {
      return null;
    }
  }

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { userAddress?: unknown };
      if (typeof body.userAddress !== "string") return null;
      return getAddress(body.userAddress);
    } catch {
      return null;
    }
  }

  return null;
};

const scanDepositsInRange = async (
  userAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ matchedDeposits: number; depositedWei: bigint; chunkSizeUsed: bigint }> => {
  if (fromBlock > toBlock) {
    return {
      matchedDeposits: 0,
      depositedWei: 0n,
      chunkSizeUsed: INITIAL_LOG_CHUNK_SIZE,
    };
  }

  let matchedDeposits = 0;
  let depositedWei = 0n;
  let cursor = fromBlock;
  let chunkSize = INITIAL_LOG_CHUNK_SIZE;

  while (cursor <= toBlock) {
    const chunkEnd = (() => {
      const candidate = cursor + chunkSize - 1n;
      return candidate < toBlock ? candidate : toBlock;
    })();

    try {
      const logs = await publicClient.getLogs({
        address: GHOST_VAULT_ADDRESS,
        event: depositedEvent,
        args: { payer: userAddress },
        fromBlock: cursor,
        toBlock: chunkEnd,
      });

      matchedDeposits += logs.length;
      depositedWei += logs.reduce((sum, log) => {
        const args = log.args as { amount?: bigint };
        return sum + (args.amount ?? 0n);
      }, 0n);

      cursor = chunkEnd + 1n;
    } catch (error) {
      const suggestedWindow = parseSuggestedProviderWindow(error);
      if (suggestedWindow != null && suggestedWindow < chunkSize) {
        chunkSize = suggestedWindow >= MIN_LOG_CHUNK_SIZE ? suggestedWindow : MIN_LOG_CHUNK_SIZE;
        continue;
      }

      if (chunkSize > MIN_LOG_CHUNK_SIZE) {
        const halved = chunkSize / 2n;
        chunkSize = halved >= MIN_LOG_CHUNK_SIZE ? halved : MIN_LOG_CHUNK_SIZE;
        continue;
      }

      throw error;
    }
  }

  return { matchedDeposits, depositedWei, chunkSizeUsed: chunkSize };
};

const syncCreditsForUser = async (userAddress: Address) => {
  const latestBlock = await publicClient.getBlockNumber();
  const existingBalance = await getCreditBalance(userAddress);
  const lastSyncedBlockBefore = existingBalance?.lastSyncedBlock ?? 0n;
  const fromBlockCandidate = lastSyncedBlockBefore + 1n;
  const fromBlock = fromBlockCandidate > START_BLOCK ? fromBlockCandidate : START_BLOCK;
  const cappedToBlock =
    fromBlock <= latestBlock
      ? (() => {
          const target = fromBlock + MAX_BLOCKS_PER_SYNC_REQUEST - 1n;
          return target < latestBlock ? target : latestBlock;
        })()
      : latestBlock;
  const hasScannableRange = fromBlock <= cappedToBlock;

  const scan = hasScannableRange
    ? await scanDepositsInRange(userAddress, fromBlock, cappedToBlock)
    : {
        matchedDeposits: 0,
        depositedWei: 0n,
        chunkSizeUsed: INITIAL_LOG_CHUNK_SIZE,
      };

  const syncedToBlock = hasScannableRange ? cappedToBlock : lastSyncedBlockBefore;

  const synced = await syncDeposits(
    userAddress,
    scan.depositedWei,
    CREDIT_PRICE_WEI,
    syncedToBlock,
  );

  const partialSync = hasScannableRange && cappedToBlock < latestBlock;
  const remainingBlocks = partialSync ? latestBlock - cappedToBlock : 0n;

  return {
    userAddress,
    vaultAddress: GHOST_VAULT_ADDRESS,
    fromBlock: fromBlock.toString(),
    toBlock: cappedToBlock.toString(),
    headBlock: latestBlock.toString(),
    lastSyncedBlockBefore: lastSyncedBlockBefore.toString(),
    lastSyncedBlock: synced.lastSyncedBlock.toString(),
    matchedDeposits: scan.matchedDeposits,
    depositedWeiSinceLastSync: scan.depositedWei.toString(),
    creditPriceWei: CREDIT_PRICE_WEI.toString(),
    addedCredits: synced.added.toString(),
    credits: synced.after.toString(),
    partialSync,
    remainingBlocks: remainingBlocks.toString(),
    nextFromBlock: partialSync ? (cappedToBlock + 1n).toString() : null,
    maxBlocksPerRequest: MAX_BLOCKS_PER_SYNC_REQUEST.toString(),
    logChunkSizeUsed: scan.chunkSizeUsed.toString(),
  };
};

const handle = async (request: NextRequest): Promise<NextResponse> => {
  const userAddress = await parseUserAddress(request);
  if (!userAddress) {
    return json({ error: "userAddress is required", code: 400 }, 400);
  }

  try {
    const result = await syncCreditsForUser(userAddress);
    return json(result, 200);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return json({ error: "Failed to sync credits", code: 500, details }, 500);
  }
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
