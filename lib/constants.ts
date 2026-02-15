import type { Abi, Address } from "viem";
import { getAddress } from "viem";
import ghostVaultAbi from "@/lib/abi/GhostVault.json";

const FALLBACK_GHOST_VAULT_ADDRESS = "0xE968393bd003331Db6D62DEb614d2B073C9C151C";
const FALLBACK_PROTOCOL_TREASURY = "0x6D1F2814fC91971dB8b58A124eBfeB8bC7504c6f";

const resolveAddress = (rawAddress: string | undefined, fallbackAddress: string): Address => {
  if (rawAddress) {
    try {
      return getAddress(rawAddress);
    } catch {
      // Fallback to known address when env var is malformed.
    }
  }

  return getAddress(fallbackAddress);
};

export const GHOST_VAULT_ADDRESS: Address = resolveAddress(
  process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS,
  FALLBACK_GHOST_VAULT_ADDRESS,
);

export const PROTOCOL_TREASURY_FALLBACK_ADDRESS: Address = resolveAddress(
  process.env.NEXT_PUBLIC_PROTOCOL_TREASURY,
  FALLBACK_PROTOCOL_TREASURY,
);

export const GHOST_VAULT_ABI = ghostVaultAbi as Abi;
