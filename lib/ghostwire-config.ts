import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const parsePositiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveBigIntEnv = (raw: string | undefined, fallback: bigint): bigint => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : fallback;
};

export type GhostWireSupportedChainId = 8453 | 84532;
export type GhostWireSettlementAsset = "USDC";
export type GhostWireReserveAsset = "ETH";

export const GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID: GhostWireSupportedChainId = 8453;
export const GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID: GhostWireSupportedChainId = 84532;
export const GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET: GhostWireSettlementAsset = "USDC";
export const GHOSTWIRE_SUPPORTED_RESERVE_ASSET: GhostWireReserveAsset = "ETH";
export const GHOSTWIRE_PROTOCOL_FEE_BPS = 250;
export const GHOSTWIRE_ERC8183_PINNED_REPOSITORY = "t54-labs/ERC-ACP";
export const GHOSTWIRE_ERC8183_PINNED_CONTRACT = "contracts/AgenticCommerce.sol";
export const GHOSTWIRE_ERC8183_PINNED_COMMIT = "17f948b38c6d184571e4e23e1a2b459796f6ca2a";
export const GHOSTWIRE_QUOTE_TTL_SECONDS = parsePositiveIntEnv(process.env.GHOSTWIRE_QUOTE_TTL_SECONDS, 600);
export const GHOSTWIRE_JOB_EXPIRY_SECONDS = parsePositiveIntEnv(process.env.GHOSTWIRE_JOB_EXPIRY_SECONDS, 86_400);
export const GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET = parsePositiveIntEnv(
  process.env.GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET,
  2,
);
export const GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET = parsePositiveIntEnv(
  process.env.GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET,
  1,
);
export const GHOSTWIRE_WEBHOOK_REPLAY_WINDOW_SECONDS = parsePositiveIntEnv(
  process.env.GHOSTWIRE_WEBHOOK_REPLAY_WINDOW_SECONDS,
  300,
);
export const GHOSTWIRE_MAINNET_NETWORK_RESERVE_WEI = parsePositiveBigIntEnv(
  process.env.GHOSTWIRE_MAINNET_NETWORK_RESERVE_WEI,
  3_000_000_000_000_000n,
);
export const GHOSTWIRE_TESTNET_NETWORK_RESERVE_WEI = parsePositiveBigIntEnv(
  process.env.GHOSTWIRE_TESTNET_NETWORK_RESERVE_WEI,
  300_000_000_000_000n,
);
export const GHOSTWIRE_ETH_USDC_PRICE_MICRO = (() => {
  const trimmed = process.env.GHOSTWIRE_ETH_USDC_PRICE_MICRO?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
})();

const DEFAULT_BASE_MAINNET_RPC_URL = "https://mainnet.base.org";
const DEFAULT_BASE_TESTNET_RPC_URL = "https://sepolia.base.org";
const DEFAULT_BASE_MAINNET_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_BASE_TESTNET_USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const normalizeAddressEnv = (raw: string | undefined): Address | null => {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
};

const normalizePrivateKey = (raw: string | undefined): `0x${string}` | null => {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
};

export const isGhostWireSupportedChainId = (value: number): value is GhostWireSupportedChainId =>
  value === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID || value === GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID;

export const resolveGhostWireMinConfirmations = (chainId: GhostWireSupportedChainId): number =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID
    ? GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET
    : GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET;

export const resolveGhostWireNetworkReserveWei = (chainId: GhostWireSupportedChainId): bigint =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID
    ? GHOSTWIRE_MAINNET_NETWORK_RESERVE_WEI
    : GHOSTWIRE_TESTNET_NETWORK_RESERVE_WEI;

export const estimateGhostWireReserveUsdcMicro = (networkReserveWei: bigint): bigint | null => {
  if (!GHOSTWIRE_ETH_USDC_PRICE_MICRO) return null;
  return (networkReserveWei * GHOSTWIRE_ETH_USDC_PRICE_MICRO) / 10n ** 18n;
};

export const resolveGhostWireContractAddress = (chainId: GhostWireSupportedChainId): Address | null =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID
    ? normalizeAddressEnv(process.env.GHOSTWIRE_ACP_MAINNET_ADDRESS)
    : normalizeAddressEnv(process.env.GHOSTWIRE_ACP_TESTNET_ADDRESS);

export const resolveGhostWireRpcUrl = (chainId: GhostWireSupportedChainId): string => {
  if (chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID) {
    return (
      process.env.GHOSTWIRE_BASE_MAINNET_RPC_URL?.trim() ||
      process.env.BASE_RPC_URL?.trim() ||
      DEFAULT_BASE_MAINNET_RPC_URL
    );
  }

  return (
    process.env.GHOSTWIRE_BASE_TESTNET_RPC_URL?.trim() ||
    process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
    DEFAULT_BASE_TESTNET_RPC_URL
  );
};

export const resolveGhostWireOperatorPrivateKey = (): `0x${string}` | null =>
  normalizePrivateKey(process.env.GHOSTWIRE_OPERATOR_PRIVATE_KEY) ??
  normalizePrivateKey(process.env.GHOST_SETTLEMENT_OPERATOR_PRIVATE_KEY) ??
  normalizePrivateKey(process.env.PRIVATE_KEY);

export const getGhostWireOperatorAccount = () => {
  const privateKey = resolveGhostWireOperatorPrivateKey();
  return privateKey ? privateKeyToAccount(privateKey) : null;
};

export const resolveGhostWireContractBudgetAmount = (principalAmount: bigint): bigint => principalAmount;

export const resolveGhostWireUsdcAddress = (chainId: GhostWireSupportedChainId): Address =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID
    ? normalizeAddressEnv(process.env.GHOSTWIRE_USDC_MAINNET_ADDRESS) ?? getAddress(DEFAULT_BASE_MAINNET_USDC_ADDRESS)
    : normalizeAddressEnv(process.env.GHOSTWIRE_USDC_TESTNET_ADDRESS) ?? getAddress(DEFAULT_BASE_TESTNET_USDC_ADDRESS);
