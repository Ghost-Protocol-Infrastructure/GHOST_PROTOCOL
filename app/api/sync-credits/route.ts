import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, parseEther, type AbiEvent, type Address } from "viem";
import { base } from "viem/chains";
import { GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "@/lib/constants";
import { getUserCredits, syncUserCreditsFromDeposits } from "@/lib/db";

export const runtime = "nodejs";

const DEFAULT_CREDIT_PRICE_WEI = 10_000_000_000_000n; // 0.00001 ETH

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

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org"),
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

const syncCreditsForUser = async (userAddress: Address) => {
  const logs = await publicClient.getLogs({
    address: GHOST_VAULT_ADDRESS,
    event: depositedEvent,
    args: { payer: userAddress },
    fromBlock: START_BLOCK,
    toBlock: "latest",
  });

  const totalDepositedWei = logs.reduce((sum, log) => {
    const args = log.args as { amount?: bigint };
    return sum + (args.amount ?? 0n);
  }, 0n);

  await syncUserCreditsFromDeposits(userAddress, totalDepositedWei, CREDIT_PRICE_WEI);
  const credits = await getUserCredits(userAddress);

  return {
    userAddress,
    vaultAddress: GHOST_VAULT_ADDRESS,
    fromBlock: START_BLOCK.toString(),
    matchedDeposits: logs.length,
    totalDepositedWei: totalDepositedWei.toString(),
    creditPriceWei: CREDIT_PRICE_WEI.toString(),
    credits: credits.toString(),
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
