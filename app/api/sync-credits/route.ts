import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, type AbiEvent, type Address, type Hash } from "viem";
import { base, baseSepolia } from "viem/chains";
import { GHOST_CREDIT_PRICE_WEI, GHOST_PREFERRED_CHAIN_ID, GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "@/lib/constants";
import { getCreditBalance, syncDeposits } from "@/lib/db";

export const runtime = "nodejs";

const DEFAULT_MAX_BLOCKS_PER_SYNC_REQUEST = 500n;
const DEFAULT_LOG_CHUNK_SIZE = 500n;
const MIN_LOG_CHUNK_SIZE = 10n;
const DEFAULT_MAX_TX_AWARE_CATCHUP_STEPS_PER_REQUEST = 96;
const DEFAULT_SYNC_DEPOSIT_WRITE_CONFLICT_RETRIES = 3;
const CREDIT_PRICE_WEI = GHOST_CREDIT_PRICE_WEI;

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

const parsePositiveIntEnv = (value: string | undefined, fallback: number, max = 10_000): number => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > max ? max : parsed;
};

const MAX_BLOCKS_PER_SYNC_REQUEST = parsePositiveBigIntEnv(
  process.env.GHOST_SYNC_CREDITS_MAX_BLOCKS_PER_REQUEST,
  DEFAULT_MAX_BLOCKS_PER_SYNC_REQUEST,
);

const INITIAL_LOG_CHUNK_SIZE = parsePositiveBigIntEnv(
  process.env.GHOST_SYNC_CREDITS_LOG_CHUNK_SIZE,
  DEFAULT_LOG_CHUNK_SIZE,
);

const MAX_TX_AWARE_CATCHUP_STEPS_PER_REQUEST = parsePositiveIntEnv(
  process.env.GHOST_SYNC_CREDITS_MAX_TX_AWARE_CATCHUP_STEPS_PER_REQUEST,
  DEFAULT_MAX_TX_AWARE_CATCHUP_STEPS_PER_REQUEST,
);

const MAX_SYNC_DEPOSIT_WRITE_CONFLICT_RETRIES = parsePositiveIntEnv(
  process.env.GHOST_SYNC_CREDITS_MAX_WRITE_CONFLICT_RETRIES,
  DEFAULT_SYNC_DEPOSIT_WRITE_CONFLICT_RETRIES,
  20,
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
  chain: GHOST_PREFERRED_CHAIN_ID === 84532 ? baseSepolia : base,
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

type SyncCreditsRequestOptions = {
  depositTxHash: Hash | null;
  depositReceiptBlock: bigint | null;
};

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const parseSyncCreditsRequestOptions = (request: NextRequest): SyncCreditsRequestOptions => {
  const rawHash = request.nextUrl.searchParams.get("depositTxHash")?.trim() ?? null;
  const rawReceiptBlock = request.nextUrl.searchParams.get("depositReceiptBlock")?.trim() ?? null;

  const depositTxHash = rawHash && TX_HASH_PATTERN.test(rawHash) ? (rawHash as Hash) : null;
  const depositReceiptBlock =
    rawReceiptBlock && /^\d+$/.test(rawReceiptBlock) ? BigInt(rawReceiptBlock) : null;

  return {
    depositTxHash,
    depositReceiptBlock,
  };
};

const resolveDepositTargetBlock = async (
  options: SyncCreditsRequestOptions,
): Promise<bigint | null> => {
  if (options.depositReceiptBlock != null && options.depositReceiptBlock >= 0n) {
    return options.depositReceiptBlock;
  }

  if (!options.depositTxHash) {
    return null;
  }

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: options.depositTxHash });
    return receipt.blockNumber;
  } catch {
    return null;
  }
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

type SyncCreditsStepResult = {
  userAddress: Address;
  fromBlock: bigint;
  toBlock: bigint;
  headBlock: bigint;
  lastSyncedBlockBefore: bigint;
  lastSyncedBlock: bigint;
  matchedDeposits: number;
  depositedWeiSinceLastSync: bigint;
  addedCredits: bigint;
  credits: bigint;
  partialSync: boolean;
  remainingBlocks: bigint;
  nextFromBlock: bigint | null;
  maxBlocksPerRequest: bigint;
  logChunkSizeUsed: bigint;
};

type SyncCreditsResponsePayload = {
  userAddress: Address;
  vaultAddress: Address;
  fromBlock: string;
  toBlock: string;
  headBlock: string;
  lastSyncedBlockBefore: string;
  lastSyncedBlock: string;
  matchedDeposits: number;
  depositedWeiSinceLastSync: string;
  creditPriceWei: string;
  addedCredits: string;
  credits: string;
  partialSync: boolean;
  remainingBlocks: string;
  nextFromBlock: string | null;
  maxBlocksPerRequest: string;
  logChunkSizeUsed: string;
  txAwareCatchupApplied: boolean;
  txAwareCatchupSteps: number;
  targetDepositBlock: string | null;
  targetCaughtUp: boolean | null;
};

const buildSyncCreditsResponse = (
  step: SyncCreditsStepResult,
  extras?: {
    txAwareCatchupApplied?: boolean;
    txAwareCatchupSteps?: number;
    targetDepositBlock?: bigint | null;
    targetCaughtUp?: boolean | null;
    aggregateMatchedDeposits?: number;
    aggregateDepositedWei?: bigint;
    aggregateAddedCredits?: bigint;
    aggregateFromBlock?: bigint;
    aggregateLastSyncedBlockBefore?: bigint;
  },
): SyncCreditsResponsePayload => {
  const matchedDeposits = extras?.aggregateMatchedDeposits ?? step.matchedDeposits;
  const depositedWeiSinceLastSync = extras?.aggregateDepositedWei ?? step.depositedWeiSinceLastSync;
  const addedCredits = extras?.aggregateAddedCredits ?? step.addedCredits;
  const fromBlock = extras?.aggregateFromBlock ?? step.fromBlock;
  const lastSyncedBlockBefore = extras?.aggregateLastSyncedBlockBefore ?? step.lastSyncedBlockBefore;

  return {
    userAddress: step.userAddress,
    vaultAddress: GHOST_VAULT_ADDRESS,
    fromBlock: fromBlock.toString(),
    toBlock: step.toBlock.toString(),
    headBlock: step.headBlock.toString(),
    lastSyncedBlockBefore: lastSyncedBlockBefore.toString(),
    lastSyncedBlock: step.lastSyncedBlock.toString(),
    matchedDeposits,
    depositedWeiSinceLastSync: depositedWeiSinceLastSync.toString(),
    creditPriceWei: CREDIT_PRICE_WEI.toString(),
    addedCredits: addedCredits.toString(),
    credits: step.credits.toString(),
    partialSync: step.partialSync,
    remainingBlocks: step.remainingBlocks.toString(),
    nextFromBlock: step.nextFromBlock?.toString() ?? null,
    maxBlocksPerRequest: step.maxBlocksPerRequest.toString(),
    logChunkSizeUsed: step.logChunkSizeUsed.toString(),
    txAwareCatchupApplied: extras?.txAwareCatchupApplied === true,
    txAwareCatchupSteps: extras?.txAwareCatchupSteps ?? 1,
    targetDepositBlock: extras?.targetDepositBlock?.toString() ?? null,
    targetCaughtUp: extras?.targetCaughtUp ?? null,
  };
};

const syncCreditsSingleStepForUser = async (
  userAddress: Address,
  options?: { targetToBlock?: bigint | null },
): Promise<SyncCreditsStepResult> => {
  let conflictRetries = 0;

  for (;;) {
    const latestBlock = await publicClient.getBlockNumber();
    const effectiveLatestBlock =
      options?.targetToBlock != null && options.targetToBlock < latestBlock
        ? options.targetToBlock
        : latestBlock;

    const existingBalance = await getCreditBalance(userAddress);
    const persistedLastSyncedBlock = existingBalance?.lastSyncedBlock ?? 0n;
    const chainCursorAheadOfHead = persistedLastSyncedBlock > effectiveLatestBlock;
    const lastSyncedBlockBefore = chainCursorAheadOfHead ? 0n : persistedLastSyncedBlock;
    const fallbackResetFromBlock = (() => {
      const anchor = options?.targetToBlock ?? effectiveLatestBlock;
      if (anchor <= START_BLOCK) return START_BLOCK;
      const windowStart = anchor >= MAX_BLOCKS_PER_SYNC_REQUEST - 1n
        ? anchor - (MAX_BLOCKS_PER_SYNC_REQUEST - 1n)
        : 0n;
      return windowStart > START_BLOCK ? windowStart : START_BLOCK;
    })();
    const fromBlockCandidate = lastSyncedBlockBefore + 1n;
    const fromBlock = chainCursorAheadOfHead
      ? fallbackResetFromBlock
      : fromBlockCandidate > START_BLOCK
        ? fromBlockCandidate
        : START_BLOCK;
    const cappedToBlock =
      fromBlock <= effectiveLatestBlock
        ? (() => {
            const target = fromBlock + MAX_BLOCKS_PER_SYNC_REQUEST - 1n;
            return target < effectiveLatestBlock ? target : effectiveLatestBlock;
          })()
        : effectiveLatestBlock;
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
      {
        expectedLastSyncedBlock: persistedLastSyncedBlock,
        allowLastSyncedBlockRollback: chainCursorAheadOfHead,
      },
    );

    if (synced.conflict) {
      if (conflictRetries >= MAX_SYNC_DEPOSIT_WRITE_CONFLICT_RETRIES) {
        throw new Error("Credit sync conflict retries exceeded. Please retry sync.");
      }
      conflictRetries += 1;
      continue;
    }

    const partialSync = hasScannableRange && cappedToBlock < latestBlock;
    const remainingBlocks = partialSync ? latestBlock - cappedToBlock : 0n;

    return {
      userAddress,
      fromBlock,
      toBlock: cappedToBlock,
      headBlock: latestBlock,
      lastSyncedBlockBefore,
      lastSyncedBlock: synced.lastSyncedBlock,
      matchedDeposits: scan.matchedDeposits,
      depositedWeiSinceLastSync: scan.depositedWei,
      addedCredits: synced.added,
      credits: synced.after,
      partialSync,
      remainingBlocks,
      nextFromBlock: partialSync ? cappedToBlock + 1n : null,
      maxBlocksPerRequest: MAX_BLOCKS_PER_SYNC_REQUEST,
      logChunkSizeUsed: scan.chunkSizeUsed,
    };
  }
};

const syncCreditsForUser = async (
  userAddress: Address,
  requestOptions: SyncCreditsRequestOptions,
): Promise<SyncCreditsResponsePayload> => {
  const targetDepositBlock = await resolveDepositTargetBlock(requestOptions);

  if (targetDepositBlock == null) {
    const step = await syncCreditsSingleStepForUser(userAddress);
    return buildSyncCreditsResponse(step, {
      txAwareCatchupApplied: false,
      txAwareCatchupSteps: 1,
      targetDepositBlock: null,
      targetCaughtUp: null,
    });
  }

  let firstStep: SyncCreditsStepResult | null = null;
  let lastStep: SyncCreditsStepResult | null = null;
  let aggregateMatchedDeposits = 0;
  let aggregateDepositedWei = 0n;
  let aggregateAddedCredits = 0n;
  let previousLastSyncedBlock: bigint | null = null;
  let stepsExecuted = 0;

  for (let stepIndex = 0; stepIndex < MAX_TX_AWARE_CATCHUP_STEPS_PER_REQUEST; stepIndex += 1) {
    const step = await syncCreditsSingleStepForUser(userAddress, {
      targetToBlock: targetDepositBlock,
    });

    stepsExecuted += 1;
    if (!firstStep) firstStep = step;
    lastStep = step;

    aggregateMatchedDeposits += step.matchedDeposits;
    aggregateDepositedWei += step.depositedWeiSinceLastSync;
    aggregateAddedCredits += step.addedCredits;

    if (step.lastSyncedBlock >= targetDepositBlock) {
      break;
    }

    if (previousLastSyncedBlock != null && step.lastSyncedBlock <= previousLastSyncedBlock) {
      break;
    }

    previousLastSyncedBlock = step.lastSyncedBlock;
  }

  if (!firstStep || !lastStep) {
    const step = await syncCreditsSingleStepForUser(userAddress);
    return buildSyncCreditsResponse(step, {
      txAwareCatchupApplied: false,
      txAwareCatchupSteps: 1,
      targetDepositBlock,
      targetCaughtUp: step.lastSyncedBlock >= targetDepositBlock,
    });
  }

  return buildSyncCreditsResponse(lastStep, {
    txAwareCatchupApplied: true,
    txAwareCatchupSteps: stepsExecuted,
    targetDepositBlock,
    targetCaughtUp: lastStep.lastSyncedBlock >= targetDepositBlock,
    aggregateMatchedDeposits,
    aggregateDepositedWei,
    aggregateAddedCredits,
    aggregateFromBlock: firstStep.fromBlock,
    aggregateLastSyncedBlockBefore: firstStep.lastSyncedBlockBefore,
  });
};

const handle = async (request: NextRequest): Promise<NextResponse> => {
  const userAddress = await parseUserAddress(request);
  if (!userAddress) {
    return json({ error: "userAddress is required", code: 400 }, 400);
  }
  const requestOptions = parseSyncCreditsRequestOptions(request);

  try {
    const result = await syncCreditsForUser(userAddress, requestOptions);
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
