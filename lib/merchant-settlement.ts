import { getAddress, keccak256, stringToHex, type Address } from "viem";

import { GHOST_CREDIT_PRICE_WEI, GHOST_PROTOCOL_FEE_BPS } from "./constants";

const SETTLEMENT_ID_NAMESPACE = "ghost:settlement:v1";
const BPS_DENOMINATOR = 10_000n;

const normalizeWalletAddress = (walletAddress: Address | string): string => getAddress(walletAddress).toLowerCase();

const normalizeRequestId = (requestId: string): string => {
  const normalized = requestId.trim();
  if (!normalized) {
    throw new Error("requestId is required to derive a gate settlement id.");
  }
  return normalized;
};

const normalizeTicketId = (ticketId: string): string => {
  const normalized = ticketId.trim().toLowerCase();
  if (!normalized) {
    throw new Error("ticketId is required to derive a fulfillment settlement id.");
  }
  return normalized;
};

const buildSettlementId = (sourceType: string, sourceKey: string): `0x${string}` => {
  return keccak256(stringToHex(`${SETTLEMENT_ID_NAMESPACE}:${sourceType}:${sourceKey}`));
};

export const buildGateSettlementId = (input: {
  walletAddress: Address | string;
  requestId: string;
}): `0x${string}` => {
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const requestId = normalizeRequestId(input.requestId);
  const sourceKey = `gate:${walletAddress}:${requestId}`;

  return buildSettlementId("gate_debit", sourceKey);
};

export const buildFulfillmentCaptureSettlementId = (input: { ticketId: string }): `0x${string}` => {
  const ticketId = normalizeTicketId(input.ticketId);
  const sourceKey = `fulfillment_capture:${ticketId}`;

  return buildSettlementId("fulfillment_capture", sourceKey);
};

export type SettlementAmountBreakdown = {
  grossCredits: bigint;
  creditPriceWei: bigint;
  feeBps: number;
  grossWei: bigint;
  feeWei: bigint;
  netWei: bigint;
};

export const calculateSettlementAmounts = (input: {
  grossCredits: bigint;
  feeBps?: number;
  creditPriceWei?: bigint;
}): SettlementAmountBreakdown => {
  if (input.grossCredits <= 0n) {
    throw new Error("grossCredits must be greater than zero.");
  }

  const creditPriceWei = input.creditPriceWei ?? GHOST_CREDIT_PRICE_WEI;
  if (creditPriceWei <= 0n) {
    throw new Error("creditPriceWei must be greater than zero.");
  }

  const feeBps = input.feeBps ?? GHOST_PROTOCOL_FEE_BPS;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > Number(BPS_DENOMINATOR)) {
    throw new Error("feeBps must be an integer between 0 and 10000.");
  }

  const grossWei = input.grossCredits * creditPriceWei;
  const feeWei = (grossWei * BigInt(feeBps)) / BPS_DENOMINATOR;
  const netWei = grossWei - feeWei;

  return {
    grossCredits: input.grossCredits,
    creditPriceWei,
    feeBps,
    grossWei,
    feeWei,
    netWei,
  };
};
