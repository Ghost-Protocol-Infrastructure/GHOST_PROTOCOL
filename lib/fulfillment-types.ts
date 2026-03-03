export const FULFILLMENT_API_VERSION = 1 as const;

export const FULFILLMENT_EIP712_DOMAIN_NAME = "GhostGateFulfillment" as const;
export const FULFILLMENT_EIP712_DOMAIN_VERSION = "1" as const;
export const FULFILLMENT_EIP712_VERIFIYING_CONTRACT_SENTINEL =
  "0x0000000000000000000000000000000000000000" as const;
const FALLBACK_FULFILLMENT_CHAIN_ID = 8453;

const resolveDefaultFulfillmentChainId = (): number => {
  const rawChainId = process.env.NEXT_PUBLIC_GHOST_PREFERRED_CHAIN_ID ?? process.env.GHOST_PREFERRED_CHAIN_ID;
  const trimmed = rawChainId?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return FALLBACK_FULFILLMENT_CHAIN_ID;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed !== 8453 && parsed !== 84532) {
    return FALLBACK_FULFILLMENT_CHAIN_ID;
  }

  return parsed;
};

export const FULFILLMENT_DEFAULT_CHAIN_ID = resolveDefaultFulfillmentChainId();

export const FULFILLMENT_TICKET_HEADER_VERSION = "x-ghost-fulfillment-ticket-version" as const;
export const FULFILLMENT_TICKET_HEADER_PAYLOAD = "x-ghost-fulfillment-ticket" as const;
export const FULFILLMENT_TICKET_HEADER_SIGNATURE = "x-ghost-fulfillment-ticket-sig" as const;
export const FULFILLMENT_TICKET_HEADER_TICKET_ID = "x-ghost-fulfillment-ticket-id" as const;
export const FULFILLMENT_TICKET_HEADER_CLIENT_REQUEST_ID = "x-ghost-fulfillment-client-request-id" as const;

export const FULFILLMENT_TICKET_REQUEST_ACTION = "fulfillment_ticket" as const;
export const FULFILLMENT_CAPTURE_DISPOSITIONS = ["CAPTURED", "IDEMPOTENT_REPLAY"] as const;

export type HexString = `0x${string}`;
export type Hex32 = `0x${string}`;
export type FulfillmentCaptureDisposition = (typeof FULFILLMENT_CAPTURE_DISPOSITIONS)[number];

export type FulfillmentTicketMessage = {
  ticketId: Hex32;
  consumer: HexString;
  merchantOwner: HexString;
  gatewayConfigIdHash: Hex32;
  serviceSlug: string;
  method: string;
  path: string;
  queryHash: Hex32;
  bodyHash: Hex32;
  cost: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
};

export type FulfillmentDeliveryProofMessage = {
  ticketId: Hex32;
  deliveryProofId: Hex32;
  merchantSigner: HexString;
  serviceSlug: string;
  completedAt: bigint;
  statusCode: bigint;
  latencyMs: bigint;
  responseHash: Hex32;
};

export type FulfillmentTicketRequestAuthMessage = {
  action: typeof FULFILLMENT_TICKET_REQUEST_ACTION;
  serviceSlug: string;
  method: string;
  path: string;
  queryHash: Hex32;
  bodyHash: Hex32;
  cost: bigint;
  issuedAt: bigint;
  nonce: string;
};

export type FulfillmentTicketEnvelope = {
  version: typeof FULFILLMENT_API_VERSION;
  payload: string; // base64url(JSON)
  signature: HexString;
};

export type FulfillmentDeliveryProofEnvelope = {
  payload: string; // base64url(JSON)
  signature: HexString;
};

export type FulfillmentTicketHeaderRecord = Record<string, string>;

export const parseFulfillmentChainId = (
  rawValue: string | undefined,
  fallback: number = FULFILLMENT_DEFAULT_CHAIN_ID,
): number => {
  const trimmed = rawValue?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export const normalizeFulfillmentMethod = (value: string): string => value.trim().toUpperCase();

export const assertFulfillmentPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Fulfillment path must start with '/'. Received: ${value}`);
  }
  if (trimmed.includes("?")) {
    throw new Error(`Fulfillment path must not include query string. Received: ${value}`);
  }
  return trimmed;
};

