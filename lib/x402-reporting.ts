import { getAddress } from "viem";
import { deriveAgentServiceSlug, normalizeAgentId, normalizeOwnerAddress } from "@/lib/agent-gateway";
import { PROTOCOL_TREASURY_FALLBACK_ADDRESS } from "@/lib/constants";
import { isRankEligibleX402Asset, isSupportedX402Scheme } from "@/lib/x402-interop";

export const X402_SCORE_WINDOW_DAYS = 30;
export const X402_RAW_RETENTION_DAYS = 90;
export const X402_DEFAULT_PER_PAYER_COUNT_CAP = 3;
export const X402_DEFAULT_PER_PAYER_AMOUNT_MULTIPLIER = 3n;

export type X402SettlementReportAuth = {
  payload: unknown;
  signature: string;
};

export type NormalizedX402SettlementReport = {
  agentId: string;
  serviceSlug: string;
  requestId: string;
  paymentReference: string;
  payerIdentity: string;
  payerAddress: string | null;
  scheme: string;
  network: string | null;
  chainId: number | null;
  asset: string;
  amountAtomic: bigint;
  decimals: number;
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  occurredAt: Date;
  metadata: Record<string, unknown> | null;
  auth: X402SettlementReportAuth;
};

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEXISH_PATTERN = /^0x[a-fA-F0-9]+$/;

const parsePositiveIntEnv = (raw: string | undefined, fallbackValue: number, max = 10_000): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallbackValue;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
  return Math.min(parsed, max);
};

const parsePositiveBigIntEnv = (raw: string | undefined, fallbackValue: bigint): bigint => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallbackValue;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : fallbackValue;
};

const normalizePrintableString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return null;
  return trimmed;
};

const normalizeAddressLower = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) return null;
  try {
    return getAddress(trimmed).toLowerCase();
  } catch {
    return null;
  }
};

const normalizeAddressLikeKey = (value: string | null): string | null => {
  if (!value) return null;
  return normalizeAddressLower(value);
};

const normalizeAgentIdForX402 = (value: unknown): string | null => {
  const normalized = normalizeAgentId(value);
  if (!normalized) return null;
  if (normalized.startsWith("agent-")) {
    const stripped = normalized.slice("agent-".length).trim();
    return stripped || null;
  }
  return normalized;
};

const normalizeNullableInteger = (value: unknown, minValue: number, maxValue: number): number | null => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < minValue || value > maxValue) return null;
  return value;
};

const normalizeOccurredAt = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const normalizeMetadata = (value: unknown): Record<string, unknown> | null => {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const normalizePaymentReference = (value: unknown): string | null => {
  const normalized = normalizePrintableString(value, 256);
  if (!normalized) return null;
  return HEXISH_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
};

const normalizePayerIdentity = (value: unknown, payerAddress: string | null): string | null => {
  if (payerAddress) return payerAddress;
  const normalized = normalizePrintableString(value, 256);
  if (!normalized) return null;
  return normalizeAddressLikeKey(normalized) ?? normalized.toLowerCase();
};

const normalizeScheme = (value: unknown): string | null => {
  const normalized = normalizePrintableString(value, 64);
  return normalized ? normalized.toLowerCase() : null;
};

const normalizeAsset = (value: unknown): string | null => {
  const normalized = normalizePrintableString(value, 32);
  return normalized ? normalized.toUpperCase() : null;
};

const normalizeAmountAtomic = (value: unknown): bigint | null => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || normalized === "0") return null;
  return BigInt(normalized);
};

const normalizeAuth = (value: unknown): X402SettlementReportAuth | null => {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const signature = typeof record.signature === "string" ? record.signature.trim() : "";
  if (!/^0x[a-fA-F0-9]+$/.test(signature)) return null;
  if (record.payload == null) return null;
  return {
    payload: record.payload,
    signature,
  };
};

export const getX402PerPayerCountCap = (): number =>
  parsePositiveIntEnv(process.env.GHOST_X402_PER_PAYER_COUNT_CAP, X402_DEFAULT_PER_PAYER_COUNT_CAP, 50);

export const getX402PerPayerAmountMultiplier = (): bigint =>
  parsePositiveBigIntEnv(
    process.env.GHOST_X402_PER_PAYER_AMOUNT_MULTIPLIER,
    X402_DEFAULT_PER_PAYER_AMOUNT_MULTIPLIER,
  );

export const getX402RetentionCutoff = (now = new Date()): Date => {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - X402_RAW_RETENTION_DAYS);
  return cutoff;
};

export const normalizeX402SettlementReport = (body: unknown): NormalizedX402SettlementReport | null => {
  if (typeof body !== "object" || body == null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const agentId = normalizeAgentIdForX402(record.agentId);
  if (!agentId) return null;

  const serviceSlug = normalizePrintableString(record.serviceSlug, 128);
  if (!serviceSlug || serviceSlug !== deriveAgentServiceSlug(agentId)) return null;

  const requestId = normalizePrintableString(record.requestId, 256);
  const paymentReference = normalizePaymentReference(record.paymentReference);
  const payerAddress = normalizeAddressLower(record.payerAddress);
  const payerIdentity = normalizePayerIdentity(record.payerIdentity, payerAddress);
  const scheme = normalizeScheme(record.scheme);
  const network = normalizePrintableString(record.network, 64);
  const chainId = normalizeNullableInteger(record.chainId, 1, 100_000_000);
  const asset = normalizeAsset(record.asset);
  const amountAtomic = normalizeAmountAtomic(record.amountAtomic);
  const decimals = normalizeNullableInteger(record.decimals, 0, 18);
  const success = typeof record.success === "boolean" ? record.success : null;
  const statusCode = normalizeNullableInteger(record.statusCode, 100, 599);
  const latencyMs = normalizeNullableInteger(record.latencyMs, 0, 60 * 60 * 1000);
  const occurredAt = normalizeOccurredAt(record.occurredAt);
  const metadata = normalizeMetadata(record.metadata);
  const auth = normalizeAuth(record.auth);

  if (
    !requestId ||
    !paymentReference ||
    !payerIdentity ||
    !scheme ||
    !asset ||
    amountAtomic == null ||
    decimals == null ||
    success == null ||
    !occurredAt ||
    !auth
  ) {
    return null;
  }

  return {
    agentId,
    serviceSlug,
    requestId,
    paymentReference,
    payerIdentity,
    payerAddress,
    scheme,
    network,
    chainId,
    asset,
    amountAtomic,
    decimals,
    success,
    statusCode,
    latencyMs,
    occurredAt,
    metadata,
    auth,
  };
};

const getConfiguredRelatedPartyAddresses = (): Set<string> => {
  const relatedPartyAddresses = new Set<string>([PROTOCOL_TREASURY_FALLBACK_ADDRESS.toLowerCase()]);
  const raw = process.env.GHOST_X402_RELATED_PARTY_ADDRESSES?.trim();
  if (!raw) return relatedPartyAddresses;

  for (const candidate of raw.split(",")) {
    const normalized = normalizeOwnerAddress(candidate);
    if (normalized) relatedPartyAddresses.add(normalized);
  }

  return relatedPartyAddresses;
};

export const isRelatedPartyX402Traffic = (input: {
  payerIdentity: string;
  payerAddress?: string | null;
  ownerAddress: string;
  creatorAddress?: string | null;
  delegatedSignerAddresses?: Array<string | null | undefined>;
}): boolean => {
  const comparisonSet = getConfiguredRelatedPartyAddresses();
  comparisonSet.add(input.ownerAddress.toLowerCase());
  const creatorAddress = normalizeOwnerAddress(input.creatorAddress ?? null);
  if (creatorAddress) comparisonSet.add(creatorAddress);

  for (const signerAddress of input.delegatedSignerAddresses ?? []) {
    const normalized = normalizeOwnerAddress(signerAddress ?? null);
    if (normalized) comparisonSet.add(normalized);
  }

  const normalizedPayerAddress = normalizeOwnerAddress(input.payerAddress ?? null);
  if (normalizedPayerAddress && comparisonSet.has(normalizedPayerAddress)) {
    return true;
  }

  const normalizedPayerIdentityAddress = normalizeOwnerAddress(input.payerIdentity);
  if (normalizedPayerIdentityAddress && comparisonSet.has(normalizedPayerIdentityAddress)) {
    return true;
  }

  return false;
};

export const isX402SettlementRankEligible = (input: {
  scheme: string;
  asset: string;
  success: boolean;
  relatedParty: boolean;
}): boolean => input.success && !input.relatedParty && isSupportedX402Scheme(input.scheme) && isRankEligibleX402Asset(input.asset);
