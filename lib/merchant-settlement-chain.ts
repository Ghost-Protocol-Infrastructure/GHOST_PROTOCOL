import { config as loadEnv } from "dotenv";
import { createPublicClient, createWalletClient, getAddress, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { GHOST_PREFERRED_CHAIN_ID } from "./constants";

if (!process.env.BASE_RPC_URL) {
  loadEnv({ path: ".env", quiet: true });
  loadEnv({ path: ".env.local", override: true, quiet: true });
}

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

const getSettlementChain = () => (GHOST_PREFERRED_CHAIN_ID === 84532 ? baseSepolia : base);

const normalizePrivateKey = (raw: string | undefined): `0x${string}` | null => {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
};

export const resolveSettlementOperatorPrivateKey = (): `0x${string}` | null =>
  normalizePrivateKey(process.env.GHOST_SETTLEMENT_OPERATOR_PRIVATE_KEY) ?? normalizePrivateKey(process.env.PRIVATE_KEY);

export const getSettlementOperatorAccount = () => {
  const privateKey = resolveSettlementOperatorPrivateKey();
  return privateKey ? privateKeyToAccount(privateKey) : null;
};

export const getSettlementRpcUrl = (): string => process.env.BASE_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL;

export const createSettlementPublicClient = () =>
  createPublicClient({
    chain: getSettlementChain(),
    transport: http(getSettlementRpcUrl(), {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });

export const createSettlementWalletClient = () => {
  const privateKey = resolveSettlementOperatorPrivateKey();
  if (!privateKey) {
    throw new Error("GHOST_SETTLEMENT_OPERATOR_PRIVATE_KEY is required for settlement allocation.");
  }

  const account = privateKeyToAccount(privateKey);

  return {
    account,
    walletClient: createWalletClient({
      account,
      chain: getSettlementChain(),
      transport: http(getSettlementRpcUrl(), {
        retryCount: 2,
        retryDelay: 250,
        timeout: 15_000,
      }),
    }),
  };
};

export const resolveLegacyVaultAddress = (): Address | null => {
  const rawAddress = process.env.GHOST_VAULT_LEGACY_ADDRESS?.trim() || process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS?.trim();
  if (!rawAddress) return null;

  try {
    return getAddress(rawAddress);
  } catch {
    return null;
  }
};
