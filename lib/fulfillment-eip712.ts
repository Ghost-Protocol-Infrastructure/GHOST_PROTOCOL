import { Buffer } from "node:buffer";
import { hashTypedData, type Hex } from "viem";
import {
  assertFulfillmentPath,
  FULFILLMENT_API_VERSION,
  FULFILLMENT_DEFAULT_CHAIN_ID,
  FULFILLMENT_EIP712_DOMAIN_NAME,
  FULFILLMENT_EIP712_DOMAIN_VERSION,
  FULFILLMENT_EIP712_VERIFIYING_CONTRACT_SENTINEL,
  FULFILLMENT_TICKET_HEADER_CLIENT_REQUEST_ID,
  FULFILLMENT_TICKET_HEADER_PAYLOAD,
  FULFILLMENT_TICKET_HEADER_SIGNATURE,
  FULFILLMENT_TICKET_HEADER_TICKET_ID,
  FULFILLMENT_TICKET_HEADER_VERSION,
  FULFILLMENT_TICKET_REQUEST_ACTION,
  normalizeFulfillmentMethod,
  parseFulfillmentChainId,
  type FulfillmentDeliveryProofEnvelope,
  type FulfillmentDeliveryProofMessage,
  type FulfillmentTicketEnvelope,
  type FulfillmentTicketHeaderRecord,
  type FulfillmentTicketMessage,
  type FulfillmentTicketRequestAuthMessage,
  type Hex32,
  type HexString,
} from "@/lib/fulfillment-types";
import { FULFILLMENT_ZERO_HASH_32 } from "@/lib/fulfillment-hash";

type UintLike = bigint | number | string;
type MaybeString = string | null | undefined;

const LOWER_HEX32_PATTERN = /^0x[a-f0-9]{64}$/;
const LOWER_HEX_PATTERN = /^0x[a-f0-9]+$/;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;

const parseUintLike = (value: UintLike, field: string): bigint => {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} must be non-negative.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${field} must be an unsigned integer string.`);
  return BigInt(trimmed);
};

const normalizeLowerHex = (value: string, field: string): HexString => {
  const normalized = value.trim().toLowerCase();
  if (!LOWER_HEX_PATTERN.test(normalized)) throw new Error(`${field} must be a lowercase 0x-prefixed hex string.`);
  return normalized as HexString;
};

const normalizeAddress = (value: string, field: string): HexString => {
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) throw new Error(`${field} must be a lowercase 20-byte address.`);
  return normalized as HexString;
};

const normalizeHex32 = (value: string, field: string): Hex32 => {
  const normalized = value.trim().toLowerCase();
  if (!LOWER_HEX32_PATTERN.test(normalized)) throw new Error(`${field} must be a lowercase bytes32 hex string.`);
  return normalized as Hex32;
};

const normalizeAsciiString = (value: string, field: string, maxLen: number): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  if (trimmed.length > maxLen) throw new Error(`${field} exceeds max length ${maxLen}.`);
  if (!/^[\x20-\x7E]+$/.test(trimmed)) throw new Error(`${field} must be printable ASCII.`);
  return trimmed;
};

const serializeBigIntJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entryValue) => (typeof entryValue === "bigint" ? entryValue.toString() : entryValue));

const parseBase64UrlJson = (payload: string): unknown => {
  const text = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(text);
};

export const FULFILLMENT_EIP712_TYPES = {
  FulfillmentTicket: [
    { name: "ticketId", type: "bytes32" },
    { name: "consumer", type: "address" },
    { name: "merchantOwner", type: "address" },
    { name: "gatewayConfigIdHash", type: "bytes32" },
    { name: "serviceSlug", type: "string" },
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "queryHash", type: "bytes32" },
    { name: "bodyHash", type: "bytes32" },
    { name: "cost", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
  FulfillmentDeliveryProof: [
    { name: "ticketId", type: "bytes32" },
    { name: "deliveryProofId", type: "bytes32" },
    { name: "merchantSigner", type: "address" },
    { name: "serviceSlug", type: "string" },
    { name: "completedAt", type: "uint256" },
    { name: "statusCode", type: "uint256" },
    { name: "latencyMs", type: "uint256" },
    { name: "responseHash", type: "bytes32" },
  ],
  FulfillmentTicketRequestAuth: [
    { name: "action", type: "string" },
    { name: "serviceSlug", type: "string" },
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "queryHash", type: "bytes32" },
    { name: "bodyHash", type: "bytes32" },
    { name: "cost", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

export const buildFulfillmentEip712Domain = (chainId: number = parseFulfillmentChainId(undefined)): {
  name: typeof FULFILLMENT_EIP712_DOMAIN_NAME;
  version: typeof FULFILLMENT_EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: typeof FULFILLMENT_EIP712_VERIFIYING_CONTRACT_SENTINEL;
} => ({
  name: FULFILLMENT_EIP712_DOMAIN_NAME,
  version: FULFILLMENT_EIP712_DOMAIN_VERSION,
  chainId,
  verifyingContract: FULFILLMENT_EIP712_VERIFIYING_CONTRACT_SENTINEL,
});

export const normalizeFulfillmentTicketMessage = (input: {
  ticketId: string;
  consumer: string;
  merchantOwner: string;
  gatewayConfigIdHash: string;
  serviceSlug: string;
  method: string;
  path: string;
  queryHash: string;
  bodyHash: string;
  cost: UintLike;
  issuedAt: UintLike;
  expiresAt: UintLike;
}): FulfillmentTicketMessage => ({
  ticketId: normalizeHex32(input.ticketId, "ticketId"),
  consumer: normalizeAddress(input.consumer, "consumer"),
  merchantOwner: normalizeAddress(input.merchantOwner, "merchantOwner"),
  gatewayConfigIdHash: normalizeHex32(input.gatewayConfigIdHash, "gatewayConfigIdHash"),
  serviceSlug: normalizeAsciiString(input.serviceSlug, "serviceSlug", 256),
  method: normalizeFulfillmentMethod(input.method),
  path: assertFulfillmentPath(input.path),
  queryHash: normalizeHex32(input.queryHash, "queryHash"),
  bodyHash: normalizeHex32(input.bodyHash, "bodyHash"),
  cost: parseUintLike(input.cost, "cost"),
  issuedAt: parseUintLike(input.issuedAt, "issuedAt"),
  expiresAt: parseUintLike(input.expiresAt, "expiresAt"),
});

export const normalizeFulfillmentDeliveryProofMessage = (input: {
  ticketId: string;
  deliveryProofId: string;
  merchantSigner: string;
  serviceSlug: string;
  completedAt: UintLike;
  statusCode: UintLike;
  latencyMs: UintLike;
  responseHash?: string | null;
}): FulfillmentDeliveryProofMessage => ({
  ticketId: normalizeHex32(input.ticketId, "ticketId"),
  deliveryProofId: normalizeHex32(input.deliveryProofId, "deliveryProofId"),
  merchantSigner: normalizeAddress(input.merchantSigner, "merchantSigner"),
  serviceSlug: normalizeAsciiString(input.serviceSlug, "serviceSlug", 256),
  completedAt: parseUintLike(input.completedAt, "completedAt"),
  statusCode: parseUintLike(input.statusCode, "statusCode"),
  latencyMs: parseUintLike(input.latencyMs, "latencyMs"),
  responseHash:
    input.responseHash == null ? FULFILLMENT_ZERO_HASH_32 : normalizeHex32(input.responseHash, "responseHash"),
});

export const normalizeFulfillmentTicketRequestAuthMessage = (input: {
  action?: string;
  serviceSlug: string;
  method: string;
  path: string;
  queryHash: string;
  bodyHash: string;
  cost: UintLike;
  issuedAt: UintLike;
  nonce: string;
}): FulfillmentTicketRequestAuthMessage => ({
  action: FULFILLMENT_TICKET_REQUEST_ACTION,
  serviceSlug: normalizeAsciiString(input.serviceSlug, "serviceSlug", 256),
  method: normalizeFulfillmentMethod(input.method),
  path: assertFulfillmentPath(input.path),
  queryHash: normalizeHex32(input.queryHash, "queryHash"),
  bodyHash: normalizeHex32(input.bodyHash, "bodyHash"),
  cost: parseUintLike(input.cost, "cost"),
  issuedAt: parseUintLike(input.issuedAt, "issuedAt"),
  nonce: normalizeAsciiString(input.nonce, "nonce", 256),
});

export const buildFulfillmentTicketTypedData = (message: FulfillmentTicketMessage, options?: { chainId?: number }) => ({
  domain: buildFulfillmentEip712Domain(options?.chainId ?? FULFILLMENT_DEFAULT_CHAIN_ID),
  types: { FulfillmentTicket: FULFILLMENT_EIP712_TYPES.FulfillmentTicket },
  primaryType: "FulfillmentTicket" as const,
  message,
});

export const buildFulfillmentDeliveryProofTypedData = (
  message: FulfillmentDeliveryProofMessage,
  options?: { chainId?: number },
) => ({
  domain: buildFulfillmentEip712Domain(options?.chainId ?? FULFILLMENT_DEFAULT_CHAIN_ID),
  types: { FulfillmentDeliveryProof: FULFILLMENT_EIP712_TYPES.FulfillmentDeliveryProof },
  primaryType: "FulfillmentDeliveryProof" as const,
  message,
});

export const buildFulfillmentTicketRequestAuthTypedData = (
  message: FulfillmentTicketRequestAuthMessage,
  options?: { chainId?: number },
) => ({
  domain: buildFulfillmentEip712Domain(options?.chainId ?? FULFILLMENT_DEFAULT_CHAIN_ID),
  types: { FulfillmentTicketRequestAuth: FULFILLMENT_EIP712_TYPES.FulfillmentTicketRequestAuth },
  primaryType: "FulfillmentTicketRequestAuth" as const,
  message,
});

export const hashFulfillmentTicketTypedData = (message: FulfillmentTicketMessage, options?: { chainId?: number }): Hex32 =>
  hashTypedData(buildFulfillmentTicketTypedData(message, options) as Parameters<typeof hashTypedData>[0]) as Hex32;

export const hashFulfillmentDeliveryProofTypedData = (
  message: FulfillmentDeliveryProofMessage,
  options?: { chainId?: number },
): Hex32 => hashTypedData(buildFulfillmentDeliveryProofTypedData(message, options) as Parameters<typeof hashTypedData>[0]) as Hex32;

export const hashFulfillmentTicketRequestAuthTypedData = (
  message: FulfillmentTicketRequestAuthMessage,
  options?: { chainId?: number },
): Hex32 => hashTypedData(buildFulfillmentTicketRequestAuthTypedData(message, options) as Parameters<typeof hashTypedData>[0]) as Hex32;

export const encodeTypedPayloadBase64Url = <T extends object>(payload: T): string =>
  Buffer.from(serializeBigIntJson(payload), "utf8").toString("base64url");

export const decodeTypedPayloadBase64Url = <T = unknown>(encoded: string): T => parseBase64UrlJson(encoded) as T;

export const buildFulfillmentTicketEnvelope = (payload: FulfillmentTicketMessage, signature: string): FulfillmentTicketEnvelope => ({
  version: FULFILLMENT_API_VERSION,
  payload: encodeTypedPayloadBase64Url(payload),
  signature: normalizeLowerHex(signature, "ticket.signature"),
});

export const buildFulfillmentDeliveryProofEnvelope = (
  payload: FulfillmentDeliveryProofMessage,
  signature: string,
): FulfillmentDeliveryProofEnvelope => ({
  payload: encodeTypedPayloadBase64Url(payload),
  signature: normalizeLowerHex(signature, "deliveryProof.signature"),
});

export const buildFulfillmentTicketHeaders = (input: {
  ticketId: string;
  ticket: FulfillmentTicketEnvelope;
  clientRequestId?: MaybeString;
}): FulfillmentTicketHeaderRecord => {
  const headers: FulfillmentTicketHeaderRecord = {
    [FULFILLMENT_TICKET_HEADER_VERSION]: String(input.ticket.version),
    [FULFILLMENT_TICKET_HEADER_PAYLOAD]: input.ticket.payload,
    [FULFILLMENT_TICKET_HEADER_SIGNATURE]: normalizeLowerHex(input.ticket.signature, "ticket.signature"),
    [FULFILLMENT_TICKET_HEADER_TICKET_ID]: normalizeHex32(input.ticketId, "ticketId"),
  };
  const clientRequestId = input.clientRequestId?.trim();
  if (clientRequestId) {
    headers[FULFILLMENT_TICKET_HEADER_CLIENT_REQUEST_ID] = clientRequestId;
  }
  return headers;
};

type HeadersLike = Pick<Headers, "get"> | Record<string, string | undefined | null>;

const getHeaderValue = (headers: HeadersLike, key: string): string | null => {
  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    return (headers as Pick<Headers, "get">).get(key);
  }
  const record = headers as Record<string, string | undefined | null>;
  const direct = record[key];
  if (typeof direct === "string") return direct;
  const fallback = record[key.toLowerCase()];
  return typeof fallback === "string" ? fallback : null;
};

export const parseFulfillmentTicketHeaders = (
  headers: HeadersLike,
): {
  ticketId: Hex32;
  ticket: FulfillmentTicketEnvelope;
  clientRequestId: string | null;
} | null => {
  const versionRaw = getHeaderValue(headers, FULFILLMENT_TICKET_HEADER_VERSION)?.trim();
  const payloadRaw = getHeaderValue(headers, FULFILLMENT_TICKET_HEADER_PAYLOAD)?.trim();
  const sigRaw = getHeaderValue(headers, FULFILLMENT_TICKET_HEADER_SIGNATURE)?.trim();
  const ticketIdRaw = getHeaderValue(headers, FULFILLMENT_TICKET_HEADER_TICKET_ID)?.trim();
  if (!versionRaw || !payloadRaw || !sigRaw || !ticketIdRaw) return null;
  if (versionRaw !== String(FULFILLMENT_API_VERSION)) return null;

  try {
    return {
      ticketId: normalizeHex32(ticketIdRaw, "ticketId"),
      ticket: {
        version: FULFILLMENT_API_VERSION,
        payload: payloadRaw,
        signature: normalizeLowerHex(sigRaw, "ticket.signature"),
      },
      clientRequestId: getHeaderValue(headers, FULFILLMENT_TICKET_HEADER_CLIENT_REQUEST_ID)?.trim() ?? null,
    };
  } catch {
    return null;
  }
};

export const redactFulfillmentTicketEnvelopeDebug = (envelope: FulfillmentTicketEnvelope): Record<string, unknown> => ({
  version: envelope.version,
  payloadLength: envelope.payload.length,
  signaturePrefix: envelope.signature.slice(0, 10),
});

export const redactFulfillmentDeliveryProofEnvelopeDebug = (
  envelope: FulfillmentDeliveryProofEnvelope,
): Record<string, unknown> => ({
  payloadLength: envelope.payload.length,
  signaturePrefix: envelope.signature.slice(0, 10),
});

export const parseWireFulfillmentTicketMessage = (encodedPayload: string): FulfillmentTicketMessage => {
  const decoded = decodeTypedPayloadBase64Url<Record<string, unknown>>(encodedPayload);
  return normalizeFulfillmentTicketMessage({
    ticketId: String(decoded.ticketId ?? ""),
    consumer: String(decoded.consumer ?? ""),
    merchantOwner: String(decoded.merchantOwner ?? ""),
    gatewayConfigIdHash: String(decoded.gatewayConfigIdHash ?? ""),
    serviceSlug: String(decoded.serviceSlug ?? ""),
    method: String(decoded.method ?? ""),
    path: String(decoded.path ?? ""),
    queryHash: String(decoded.queryHash ?? ""),
    bodyHash: String(decoded.bodyHash ?? ""),
    cost: decoded.cost as UintLike,
    issuedAt: decoded.issuedAt as UintLike,
    expiresAt: decoded.expiresAt as UintLike,
  });
};

export const parseWireFulfillmentDeliveryProofMessage = (encodedPayload: string): FulfillmentDeliveryProofMessage => {
  const decoded = decodeTypedPayloadBase64Url<Record<string, unknown>>(encodedPayload);
  return normalizeFulfillmentDeliveryProofMessage({
    ticketId: String(decoded.ticketId ?? ""),
    deliveryProofId: String(decoded.deliveryProofId ?? ""),
    merchantSigner: String(decoded.merchantSigner ?? ""),
    serviceSlug: String(decoded.serviceSlug ?? ""),
    completedAt: decoded.completedAt as UintLike,
    statusCode: decoded.statusCode as UintLike,
    latencyMs: decoded.latencyMs as UintLike,
    responseHash: typeof decoded.responseHash === "string" ? decoded.responseHash : undefined,
  });
};

export const parseWireFulfillmentTicketRequestAuthMessage = (
  encodedPayload: string,
): FulfillmentTicketRequestAuthMessage => {
  const decoded = decodeTypedPayloadBase64Url<Record<string, unknown>>(encodedPayload);
  return normalizeFulfillmentTicketRequestAuthMessage({
    action: typeof decoded.action === "string" ? decoded.action : undefined,
    serviceSlug: String(decoded.serviceSlug ?? ""),
    method: String(decoded.method ?? ""),
    path: String(decoded.path ?? ""),
    queryHash: String(decoded.queryHash ?? ""),
    bodyHash: String(decoded.bodyHash ?? ""),
    cost: decoded.cost as UintLike,
    issuedAt: decoded.issuedAt as UintLike,
    nonce: String(decoded.nonce ?? ""),
  });
};

export type FulfillmentFixtureDomain = ReturnType<typeof buildFulfillmentEip712Domain>;
export type FulfillmentTicketTypedHash = Hex;
