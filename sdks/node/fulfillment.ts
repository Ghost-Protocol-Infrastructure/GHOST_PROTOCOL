import { randomBytes, randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, verifyTypedData, type Address } from "viem";
import {
  buildFulfillmentDeliveryProofEnvelope,
  buildFulfillmentDeliveryProofTypedData,
  buildFulfillmentTicketHeaders,
  buildFulfillmentTicketRequestAuthTypedData,
  buildFulfillmentTicketTypedData,
  encodeTypedPayloadBase64Url,
  parseFulfillmentTicketHeaders,
  parseWireFulfillmentTicketMessage,
  hashFulfillmentDeliveryProofTypedData,
  normalizeFulfillmentDeliveryProofMessage,
  normalizeFulfillmentTicketRequestAuthMessage,
  redactFulfillmentDeliveryProofEnvelopeDebug,
  redactFulfillmentTicketEnvelopeDebug,
} from "../../lib/fulfillment-eip712";
import {
  FULFILLMENT_DEFAULT_CHAIN_ID,
  type FulfillmentDeliveryProofEnvelope,
  type FulfillmentTicketEnvelope,
  type FulfillmentTicketHeaderRecord,
  type Hex32,
} from "../../lib/fulfillment-types";
import {
  FULFILLMENT_ZERO_HASH_32,
  hashCanonicalFulfillmentBodyJson,
  hashCanonicalFulfillmentQuery,
  sha256HexUtf8,
} from "../../lib/fulfillment-hash";

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_TICKET_COST = 1;
export const DEFAULT_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES = [
  "0xf879f5e26aa52663887f97a51d3444afef8df3fc",
] as const satisfies readonly `0x${string}`[];

type QueryInput =
  | string
  | URLSearchParams
  | Record<string, string | number | boolean | null | undefined>;

export type GhostFulfillmentConsumerConfig = {
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  defaultServiceSlug?: string;
};

export type GhostFulfillmentMerchantConfig = {
  baseUrl?: string;
  delegatedPrivateKey?: `0x${string}`;
  protocolSignerAddresses?: Array<`0x${string}` | string>;
  chainId?: number;
};

export type FulfillmentExecuteInput = {
  serviceSlug?: string;
  method?: string;
  path: string;
  query?: QueryInput | null;
  body?: unknown;
  cost?: number;
  clientRequestId?: string | null;
  headers?: Record<string, string>;
};

export type FulfillmentTicketRequestResult = {
  status: number;
  endpoint: string;
  payload: unknown;
  ok: boolean;
  ticketId: Hex32 | null;
  ticket: FulfillmentTicketEnvelope | null;
  merchantTargetUrl: string | null;
  clientRequestId: string | null;
};

export type FulfillmentExecuteResult = {
  ticket: FulfillmentTicketRequestResult;
  merchant: {
    attempted: boolean;
    status: number | null;
    url: string | null;
    bodyText: string | null;
    bodyJson: unknown;
    headers: Record<string, string> | null;
  };
};

export type FulfillmentTicketBindingInput = {
  method?: string;
  path?: string;
  query?: QueryInput | null;
  body?: unknown;
  serviceSlug?: string;
};

export type VerifiedFulfillmentTicket = {
  ticketId: Hex32;
  ticket: FulfillmentTicketEnvelope;
  payload: ReturnType<typeof parseWireFulfillmentTicketMessage>;
  signer: `0x${string}`;
  clientRequestId: string | null;
};

export type CaptureCompletionInput = {
  ticketId: Hex32 | string;
  serviceSlug: string;
  statusCode: number;
  latencyMs: number;
  responseBodyJson?: unknown;
  responseBodyText?: string | null;
  completedAtMs?: number;
  deliveryProofId?: Hex32 | string;
};

export type CaptureCompletionResult = {
  status: number;
  endpoint: string;
  payload: unknown;
  ok: boolean;
  deliveryProof: FulfillmentDeliveryProofEnvelope;
  debug: Record<string, unknown>;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const parseJsonSafe = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const parseTextSafe = async (response: Response): Promise<string | null> => {
  try {
    return await response.text();
  } catch {
    return null;
  }
};

const assertPrivateKey = (value: `0x${string}` | undefined | null, name: string): `0x${string}` => {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return value;
};

const normalizeChainId = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.trunc(value as number) : FULFILLMENT_DEFAULT_CHAIN_ID;

const normalizeCost = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.trunc(value as number) : DEFAULT_TICKET_COST;

const normalizeMethod = (value: string | undefined): string => (value ?? "POST").trim().toUpperCase() || "POST";

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) throw new Error(`Fulfillment path must start with '/'. Received: ${value}`);
  if (trimmed.includes("?")) throw new Error(`Fulfillment path must not include a query string. Received: ${value}`);
  return trimmed;
};

const normalizeServiceSlug = (value: string | undefined, fallback = "agent-18755"): string => {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed;
};

const stringifyQuery = (query: QueryInput | null | undefined): string => {
  if (query == null) return "";
  if (typeof query === "string") return query;
  if (query instanceof URLSearchParams) return query.toString();
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue == null) continue;
    params.set(key, String(rawValue));
  }
  return params.toString();
};

const buildMerchantTargetUrl = (endpointUrl: string, path: string, query: string): string => {
  const base = new URL(`${normalizeBaseUrl(endpointUrl)}/`);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  const targetPath = path.trim();
  const normalizedTargetPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  base.pathname = `${basePath}${normalizedTargetPath}` || "/";
  if (query) {
    const source = query.startsWith("?") ? query.slice(1) : query;
    base.search = source;
  }
  return base.toString();
};

const extractTicketEnvelope = (payload: unknown): {
  ticketId: Hex32;
  ticket: FulfillmentTicketEnvelope;
  merchantTargetUrl: string | null;
  clientRequestId: string | null;
} | null => {
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const ticketId = typeof record.ticketId === "string" ? (record.ticketId.trim().toLowerCase() as Hex32) : null;
  if (!ticketId || !/^0x[a-f0-9]{64}$/.test(ticketId)) return null;
  const ticketObj = record.ticket;
  if (typeof ticketObj !== "object" || ticketObj == null || Array.isArray(ticketObj)) return null;
  const ticketRecord = ticketObj as Record<string, unknown>;
  const version = ticketRecord.version;
  const payloadRaw = typeof ticketRecord.payload === "string" ? ticketRecord.payload.trim() : "";
  const signature = typeof ticketRecord.signature === "string" ? ticketRecord.signature.trim().toLowerCase() : "";
  if (version !== 1 || !payloadRaw || !/^0x[a-f0-9]+$/.test(signature)) return null;

  let merchantTargetUrl: string | null = null;
  const merchantTarget = record.merchantTarget;
  if (typeof merchantTarget === "object" && merchantTarget != null && !Array.isArray(merchantTarget)) {
    const mt = merchantTarget as Record<string, unknown>;
    const endpointUrl = typeof mt.endpointUrl === "string" ? mt.endpointUrl : "";
    const path = typeof mt.path === "string" ? mt.path : "";
    if (endpointUrl && path) {
      merchantTargetUrl = buildMerchantTargetUrl(endpointUrl, path, "");
    }
  }

  const validated = typeof record.validated === "object" && record.validated != null && !Array.isArray(record.validated)
    ? (record.validated as Record<string, unknown>)
    : null;
  const clientRequestId =
    validated && typeof validated.clientRequestId === "string" ? validated.clientRequestId : null;

  return {
    ticketId,
    ticket: { version: 1, payload: payloadRaw, signature: signature as `0x${string}` },
    merchantTargetUrl,
    clientRequestId,
  };
};

const redactHeaders = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().includes("fulfillment-ticket")) {
      out[key] = value.length > 20 ? `${value.slice(0, 20)}...` : value;
      continue;
    }
    out[key] = value;
  }
  return out;
};

export class GhostFulfillmentConsumer {
  private readonly baseUrl: string;
  private readonly privateKey: `0x${string}`;
  private readonly chainId: number;
  private readonly defaultServiceSlug: string;

  constructor(config: GhostFulfillmentConsumerConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.privateKey = assertPrivateKey(config.privateKey ?? null, "GhostFulfillmentConsumer.privateKey");
    this.chainId = normalizeChainId(config.chainId);
    this.defaultServiceSlug = normalizeServiceSlug(config.defaultServiceSlug, "agent-18755");
  }

  async requestTicket(input: FulfillmentExecuteInput): Promise<FulfillmentTicketRequestResult> {
    const serviceSlug = normalizeServiceSlug(input.serviceSlug, this.defaultServiceSlug);
    const method = normalizeMethod(input.method);
    const path = normalizePath(input.path);
    const query = stringifyQuery(input.query);
    const cost = normalizeCost(input.cost);
    const bodyHash = hashCanonicalFulfillmentBodyJson(input.body ?? {});
    const queryHash = hashCanonicalFulfillmentQuery(query);
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = randomUUID().replace(/-/g, "");

    const authMessage = normalizeFulfillmentTicketRequestAuthMessage({
      action: "fulfillment_ticket",
      serviceSlug,
      method,
      path,
      queryHash,
      bodyHash,
      cost,
      issuedAt,
      nonce,
    });

    const account = privateKeyToAccount(this.privateKey);
    const authSignature = await account.signTypedData(buildFulfillmentTicketRequestAuthTypedData(authMessage, { chainId: this.chainId }));
    const clientRequestId = input.clientRequestId?.trim() || `fx-${Date.now()}`;

    const endpoint = `${this.baseUrl}/api/fulfillment/ticket`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        serviceSlug,
        method,
        path,
        cost,
        query,
        clientRequestId,
        ticketRequestAuth: {
          payload: encodeTypedPayloadBase64Url(authMessage),
          signature: String(authSignature).toLowerCase(),
        },
      }),
      cache: "no-store",
    });

    const payload = await parseJsonSafe(response);
    const envelope = extractTicketEnvelope(payload);
    const merchantTargetUrl = envelope?.merchantTargetUrl
      ? (() => {
          const parsed = payload as Record<string, unknown>;
          const mt = parsed.merchantTarget as Record<string, unknown>;
          const endpointUrl = String(mt.endpointUrl ?? "");
          const merchantPath = String(mt.path ?? path);
          return endpointUrl ? buildMerchantTargetUrl(endpointUrl, merchantPath, query) : envelope.merchantTargetUrl;
        })()
      : null;

    return {
      status: response.status,
      endpoint,
      payload,
      ok: response.ok,
      ticketId: envelope?.ticketId ?? null,
      ticket: envelope?.ticket ?? null,
      merchantTargetUrl,
      clientRequestId,
    };
  }

  async execute(input: FulfillmentExecuteInput): Promise<FulfillmentExecuteResult> {
    const ticket = await this.requestTicket(input);
    if (!ticket.ok || !ticket.ticketId || !ticket.ticket || !ticket.merchantTargetUrl) {
      return {
        ticket,
        merchant: {
          attempted: false,
          status: null,
          url: null,
          bodyText: null,
          bodyJson: null,
          headers: null,
        },
      };
    }

    const merchantHeaders = buildFulfillmentTicketHeaders({
      ticketId: ticket.ticketId,
      ticket: ticket.ticket,
      clientRequestId: ticket.clientRequestId,
    });
    const method = normalizeMethod(input.method);
    const customHeaders = input.headers ?? {};
    const headers: Record<string, string> = {
      ...merchantHeaders,
      accept: customHeaders.accept ?? "application/json, text/plain;q=0.9, */*;q=0.8",
      ...customHeaders,
    };

    let bodyInit: BodyInit | undefined;
    if (input.body != null) {
      if (typeof input.body === "string") {
        bodyInit = input.body;
      } else {
        bodyInit = JSON.stringify(input.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const merchantResponse = await fetch(ticket.merchantTargetUrl, {
      method,
      headers,
      body: bodyInit,
      cache: "no-store",
    });

    const bodyText = await parseTextSafe(merchantResponse);
    let bodyJson: unknown = null;
    if (bodyText != null) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }
    }

    return {
      ticket,
      merchant: {
        attempted: true,
        status: merchantResponse.status,
        url: ticket.merchantTargetUrl,
        bodyText,
        bodyJson,
        headers: redactHeaders(headers),
      },
    };
  }
}

const normalizeProtocolSignerAddressSet = (addresses?: ReadonlyArray<string>): Set<`0x${string}`> => {
  const source = addresses ?? DEFAULT_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES;
  const normalized = new Set<`0x${string}`>();
  for (const raw of source) {
    const trimmed = raw.trim().toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(trimmed)) {
      normalized.add(trimmed as `0x${string}`);
    }
  }
  if (normalized.size === 0) {
    throw new Error("GhostFulfillmentMerchant requires at least one valid protocolSignerAddress.");
  }
  return normalized;
};

export class GhostFulfillmentMerchant {
  private readonly baseUrl: string;
  private readonly delegatedPrivateKey: `0x${string}` | null;
  private readonly protocolSignerAddresses: Set<`0x${string}`>;
  private readonly chainId: number;

  constructor(config: GhostFulfillmentMerchantConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.delegatedPrivateKey = config.delegatedPrivateKey ? assertPrivateKey(config.delegatedPrivateKey, "delegatedPrivateKey") : null;
    this.protocolSignerAddresses = normalizeProtocolSignerAddressSet(config.protocolSignerAddresses);
    this.chainId = normalizeChainId(config.chainId);
  }

  parseTicketHeaders(headers: Headers | Record<string, string | undefined | null>) {
    return parseFulfillmentTicketHeaders(headers);
  }

  async requireFulfillmentTicket(input: {
    headers: Headers | Record<string, string | undefined | null>;
    expected?: FulfillmentTicketBindingInput;
    nowMs?: number;
  }): Promise<VerifiedFulfillmentTicket> {
    const parsedHeaders = parseFulfillmentTicketHeaders(input.headers);
    if (!parsedHeaders) {
      throw new Error("Missing or invalid fulfillment ticket headers.");
    }

    const payload = parseWireFulfillmentTicketMessage(parsedHeaders.ticket.payload);
    if (payload.ticketId !== parsedHeaders.ticketId) {
      throw new Error("Ticket header ticketId does not match ticket payload ticketId.");
    }

    const typedData = buildFulfillmentTicketTypedData(payload, { chainId: this.chainId });
    const recoveredSigner = (await recoverTypedDataAddress({
      ...typedData,
      signature: parsedHeaders.ticket.signature,
    })).toLowerCase() as `0x${string}`;

    if (!this.protocolSignerAddresses.has(recoveredSigner)) {
      throw new Error("Fulfillment ticket signer is not an allowed protocol signer.");
    }

    const valid = await verifyTypedData({
      address: recoveredSigner as Address,
      ...typedData,
      signature: parsedHeaders.ticket.signature,
    });
    if (!valid) {
      throw new Error("Invalid fulfillment ticket signature.");
    }

    const nowSeconds = BigInt(Math.floor((input.nowMs ?? Date.now()) / 1000));
    if (nowSeconds > payload.expiresAt) {
      throw new Error("Fulfillment ticket has expired.");
    }

    const expected = input.expected;
    if (expected) {
      if (expected.serviceSlug && expected.serviceSlug.trim() !== payload.serviceSlug) {
        throw new Error("Fulfillment ticket serviceSlug does not match expected service.");
      }
      if (expected.method && normalizeMethod(expected.method) !== payload.method) {
        throw new Error("Fulfillment ticket method does not match request method.");
      }
      if (expected.path && normalizePath(expected.path) !== payload.path) {
        throw new Error("Fulfillment ticket path does not match request path.");
      }
      if (expected.query !== undefined) {
        const queryHash = hashCanonicalFulfillmentQuery(stringifyQuery(expected.query));
        if (queryHash !== payload.queryHash) {
          throw new Error("Fulfillment ticket queryHash does not match request query.");
        }
      }
      if (expected.body !== undefined) {
        const bodyHash = hashCanonicalFulfillmentBodyJson(expected.body);
        if (bodyHash !== payload.bodyHash) {
          throw new Error("Fulfillment ticket bodyHash does not match request body.");
        }
      }
    }

    return {
      ticketId: parsedHeaders.ticketId,
      ticket: parsedHeaders.ticket,
      payload,
      signer: recoveredSigner,
      clientRequestId: parsedHeaders.clientRequestId,
    };
  }

  async captureCompletion(input: CaptureCompletionInput): Promise<CaptureCompletionResult> {
    if (!this.delegatedPrivateKey) {
      throw new Error("GhostFulfillmentMerchant.captureCompletion requires delegatedPrivateKey.");
    }
    const ticketId = String(input.ticketId).trim().toLowerCase() as Hex32;
    if (!/^0x[a-f0-9]{64}$/.test(ticketId)) throw new Error("ticketId must be a bytes32 hex string.");

    const serviceSlug = normalizeServiceSlug(input.serviceSlug);
    if (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599) {
      throw new Error("statusCode must be an integer in the HTTP status range.");
    }
    if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0) {
      throw new Error("latencyMs must be a non-negative integer.");
    }

    const merchant = privateKeyToAccount(this.delegatedPrivateKey);
    const completedAtSeconds = Math.floor((input.completedAtMs ?? Date.now()) / 1000);
    const responseHash = input.responseBodyJson !== undefined
      ? hashCanonicalFulfillmentBodyJson(input.responseBodyJson)
      : typeof input.responseBodyText === "string"
        ? sha256HexUtf8(input.responseBodyText)
        : null;

    const proofMessage = normalizeFulfillmentDeliveryProofMessage({
      ticketId,
      deliveryProofId: input.deliveryProofId ?? (`0x${randomBytes(32).toString("hex")}` as Hex32),
      merchantSigner: merchant.address.toLowerCase(),
      serviceSlug,
      completedAt: completedAtSeconds,
      statusCode: input.statusCode,
      latencyMs: input.latencyMs,
      responseHash: responseHash ?? FULFILLMENT_ZERO_HASH_32,
    });

    const proofSignature = await merchant.signTypedData(
      buildFulfillmentDeliveryProofTypedData(proofMessage, { chainId: this.chainId }),
    );
    const envelope = buildFulfillmentDeliveryProofEnvelope(proofMessage, proofSignature);
    const proofTypedHash = hashFulfillmentDeliveryProofTypedData(proofMessage, { chainId: this.chainId });

    const endpoint = `${this.baseUrl}/api/fulfillment/capture`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ticketId,
        deliveryProof: envelope,
        completionMeta: {
          statusCode: input.statusCode,
          latencyMs: input.latencyMs,
          ...(responseHash ? { responseHash } : {}),
        },
      }),
      cache: "no-store",
    });

    const payload = await parseJsonSafe(response);
    return {
      status: response.status,
      endpoint,
      payload,
      ok: response.ok,
      deliveryProof: envelope,
      debug: {
        proofTypedHash,
        ticketId,
        deliveryProofId: proofMessage.deliveryProofId,
        envelope: redactFulfillmentDeliveryProofEnvelopeDebug(envelope),
      },
    };
  }
}

export const fulfillmentTicketHeadersToRecord = (input: {
  ticketId: string;
  ticket: FulfillmentTicketEnvelope;
  clientRequestId?: string | null;
}): FulfillmentTicketHeaderRecord => buildFulfillmentTicketHeaders(input);

export const parseFulfillmentTicketHeadersFromRecord = parseFulfillmentTicketHeaders;

export const debugFulfillmentTicketEnvelope = redactFulfillmentTicketEnvelopeDebug;
export const debugFulfillmentDeliveryProofEnvelope = redactFulfillmentDeliveryProofEnvelopeDebug;

export default GhostFulfillmentConsumer;
