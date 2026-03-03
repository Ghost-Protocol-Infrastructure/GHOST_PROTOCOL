import { NextRequest } from "next/server";
import { parseAbi } from "viem";
import { GHOST_CREDIT_PRICE_WEI } from "@/lib/constants";
import { createSettlementPublicClient, resolveLegacyVaultAddress } from "@/lib/merchant-settlement-chain";
import { settlementJson, isSettlementOperatorAuthorized } from "@/lib/merchant-settlement-route";

export const runtime = "nodejs";

const LEGACY_GHOST_VAULT_ABI = parseAbi([
  "function totalLiability() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
]);

export async function GET(request: NextRequest) {
  if (!isSettlementOperatorAuthorized(request)) {
    return settlementJson(
      { code: 401, error: "Unauthorized settlement operator request.", errorCode: "UNAUTHORIZED" },
      401,
    );
  }

  const legacyVaultAddress = resolveLegacyVaultAddress();
  if (!legacyVaultAddress) {
    return settlementJson(
      {
        code: 400,
        error: "Legacy GhostVault address is not configured.",
        errorCode: "LEGACY_VAULT_ADDRESS_MISSING",
      },
      400,
    );
  }

  try {
    const client = createSettlementPublicClient();
    const [legacyTotalLiability, legacyAccruedFees, legacyBalanceWei] = await Promise.all([
      client.readContract({
        address: legacyVaultAddress,
        abi: LEGACY_GHOST_VAULT_ABI,
        functionName: "totalLiability",
      }),
      client.readContract({
        address: legacyVaultAddress,
        abi: LEGACY_GHOST_VAULT_ABI,
        functionName: "accruedFees",
      }),
      client.getBalance({ address: legacyVaultAddress }),
    ]);

    const recordedLiabilityWei = legacyTotalLiability + legacyAccruedFees;
    const zeroLiability = legacyTotalLiability === 0n && legacyAccruedFees === 0n;
    const balanceMatchesRecordedLiability = legacyBalanceWei === recordedLiabilityWei;

    return settlementJson(
      {
        ok: true,
        authMode: "bearer-secret",
        legacyVaultAddress,
        legacy: {
          totalLiabilityWei: legacyTotalLiability.toString(),
          accruedFeesWei: legacyAccruedFees.toString(),
          balanceWei: legacyBalanceWei.toString(),
          balanceMatchesRecordedLiability,
          zeroLiability,
        },
        replacement: {
          expectedCreditPriceWei: GHOST_CREDIT_PRICE_WEI.toString(),
        },
        canDirectCutover: zeroLiability && balanceMatchesRecordedLiability,
      },
      200,
    );
  } catch (error) {
    return settlementJson(
      {
        code: 500,
        error: error instanceof Error ? error.message : "Failed to read legacy GhostVault preflight state.",
        errorCode: "VAULT_PREFLIGHT_FAILED",
      },
      500,
    );
  }
}
