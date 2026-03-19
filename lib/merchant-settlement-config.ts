const GWEI = 1_000_000_000n;

const DEFAULT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT = 120_000n;
const DEFAULT_ALLOCATOR_MAX_GAS_PRICE_GWEI = 3n;
const DEFAULT_ROLLUP_MAX_AGE_MS = 15 * 60 * 1_000;
const DEFAULT_ROLLUP_MAX_EARNINGS_PER_ROLLUP = 100;

export const parsePositiveIntegerEnv = (value: string | undefined, fallback: number): number => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const parsePositiveBigIntEnv = (value: string | undefined, fallback: bigint): bigint => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : fallback;
};

const resolveDefaultRollupMinFeeWei = (): bigint => {
  const gasEstimatePerSettlement = parsePositiveBigIntEnv(
    process.env.GHOST_SETTLEMENT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT,
    DEFAULT_ALLOCATOR_GAS_ESTIMATE_PER_SETTLEMENT,
  );
  const maxGasPriceGwei = parsePositiveBigIntEnv(
    process.env.GHOST_SETTLEMENT_ALLOCATOR_MAX_GAS_PRICE_GWEI,
    DEFAULT_ALLOCATOR_MAX_GAS_PRICE_GWEI,
  );

  return gasEstimatePerSettlement * maxGasPriceGwei * GWEI;
};

export type MerchantSettlementRollupConfig = {
  minFeeWei: bigint;
  maxAgeMs: number;
  maxEarningsPerRollup: number;
};

export const resolveMerchantSettlementRollupConfig = (): MerchantSettlementRollupConfig => ({
  minFeeWei: parsePositiveBigIntEnv(
    process.env.GHOST_SETTLEMENT_ROLLUP_MIN_FEE_WEI,
    resolveDefaultRollupMinFeeWei(),
  ),
  maxAgeMs: parsePositiveIntegerEnv(process.env.GHOST_SETTLEMENT_ROLLUP_MAX_AGE_MS, DEFAULT_ROLLUP_MAX_AGE_MS),
  maxEarningsPerRollup: parsePositiveIntegerEnv(
    process.env.GHOST_SETTLEMENT_ROLLUP_MAX_EARNINGS_PER_ROLLUP,
    DEFAULT_ROLLUP_MAX_EARNINGS_PER_ROLLUP,
  ),
});
