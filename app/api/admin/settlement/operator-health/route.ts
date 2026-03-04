import { NextRequest } from "next/server";
import { GHOST_VAULT_ABI, GHOST_VAULT_ADDRESS } from "@/lib/constants";
import {
  createSettlementPublicClient,
  getSettlementOperatorAccount,
} from "@/lib/merchant-settlement-chain";
import {
  isSettlementOperatorAuthorized,
  settlementJson,
} from "@/lib/merchant-settlement-route";

export const runtime = "nodejs";

const DEFAULT_MIN_BALANCE_WEI = 1_000_000_000_000_000n;

const parseThresholdWei = (value: string | null): bigint | null => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed >= 0n ? parsed : null;
};

export async function GET(request: NextRequest) {
  if (!isSettlementOperatorAuthorized(request)) {
    return settlementJson(
      { code: 401, error: "Unauthorized settlement operator request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const operatorAccount = getSettlementOperatorAccount();
  if (!operatorAccount) {
    return settlementJson(
      {
        code: 503,
        error: "Settlement operator private key is not configured in the hosted runtime.",
        errorCode: "SETTLEMENT_OPERATOR_KEY_MISSING",
      },
      503,
    );
  }

  const thresholdWei =
    parseThresholdWei(request.nextUrl.searchParams.get("thresholdWei")) ??
    parseThresholdWei(process.env.GHOST_SETTLEMENT_OPERATOR_MIN_BALANCE_WEI ?? null) ??
    DEFAULT_MIN_BALANCE_WEI;

  try {
    const client = createSettlementPublicClient();
    const [balanceWei, ownerAddressRaw, operatorAllowed] = await Promise.all([
      client.getBalance({ address: operatorAccount.address }),
      client.readContract({
        address: GHOST_VAULT_ADDRESS,
        abi: GHOST_VAULT_ABI,
        functionName: "owner",
      }),
      client.readContract({
        address: GHOST_VAULT_ADDRESS,
        abi: GHOST_VAULT_ABI,
        functionName: "settlementOperators",
        args: [operatorAccount.address],
      }),
    ]);

    const ownerAddress = String(ownerAddressRaw);
    const isOwnerOperator = ownerAddress.toLowerCase() === operatorAccount.address.toLowerCase();
    const isRegistered = Boolean(operatorAllowed) || isOwnerOperator;
    const lowBalance = balanceWei < thresholdWei;
    const healthy = isRegistered && !lowBalance;

    return settlementJson(
      {
        ok: healthy,
        authMode: "bearer-secret",
        operator: {
          address: operatorAccount.address,
          ownerAddress,
          isOwnerOperator,
          isRegistered,
          balanceWei: balanceWei.toString(),
          thresholdWei: thresholdWei.toString(),
          lowBalance,
        },
        vaultAddress: GHOST_VAULT_ADDRESS,
      },
      healthy ? 200 : 503,
    );
  } catch (error) {
    return settlementJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to read settlement operator health.",
        errorCode: "SETTLEMENT_OPERATOR_HEALTH_FAILED",
      },
      500,
    );
  }
}
