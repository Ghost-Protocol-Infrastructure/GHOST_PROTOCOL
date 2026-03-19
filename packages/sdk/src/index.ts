import { randomUUID } from "node:crypto";
import { decodeXPaymentResponse, type PaymentRequirementsSelector, wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { privateKeyToAccount } from "viem/accounts";
import type { GhostFulfillmentMerchantConfig } from "./fulfillment.js";
import { GhostFulfillmentMerchant } from "./fulfillment.js";

export * from "./fulfillment.js";

export type GhostAgentConfig = {
  apiKey?: string;
  agentId?: string;
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  serviceSlug?: string;
  creditCost?: number;
};

export type ConnectResult = {
  connected: boolean;
  apiKeyPrefix: string;
  endpoint: string;
  status: number;
  payload: unknown;
};

export type TelemetryResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
};

export type PulseInput = {
  apiKey?: string;
  agentId?: string | null;
  serviceSlug?: string | null;
  metadata?: Record<string, unknown>;
};

export type OutcomeInput = PulseInput & {
  success: boolean;
  statusCode?: number | null;
};

export type HeartbeatOptions = PulseInput & {
  intervalMs?: number;
  immediate?: boolean;
  onResult?: (result: TelemetryResult) => void;
  onError?: (error: unknown) => void;
};

export type HeartbeatController = {
  stop: () => void;
};

export type CanaryPayload = {
  ghostgate: "ready";
  service: string;
};

export type GhostMerchantConfig = GhostFulfillmentMerchantConfig & {
  serviceSlug: string;
  ownerPrivateKey?: `0x${string}`;
};

export type X402Network = "base" | "base-sepolia";

export type X402RequestInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  maxAmountAtomic?: bigint | number | string | null;
  network?: X402Network;
  paymentRequirementsSelector?: PaymentRequirementsSelector;
};

export type X402RequestResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  paymentResponseHeader: string | null;
  paymentResponse: ReturnType<typeof decodeXPaymentResponse> | null;
};

export type X402SettlementReportInput = {
  agentId: string;
  serviceSlug: string;
  requestId: string;
  paymentReference: string;
  payerIdentity: string;
  payerAddress?: `0x${string}` | string | null;
  scheme?: string;
  network?: string | null;
  chainId?: number | null;
  asset?: string;
  amountAtomic: bigint | number | string;
  decimals?: number;
  success: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  occurredAt?: string | Date;
  metadata?: Record<string, unknown>;
};

export type X402SettlementReportResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  countedForRank: boolean;
  relatedParty: boolean;
  duplicate: boolean;
};

type MerchantGatewayAuthAction =
  | "config"
  | "verify"
  | "delegated_signer_register"
  | "x402_settlement_report";

type MerchantGatewayAuthPayload = {
  scope: "agent_gateway";
  version: "1";
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  nonce: string;
  issuedAt: number;
};

type MerchantGatewayConfigResponse = {
  configured: boolean;
  config: {
    ownerAddress: string;
    readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  };
};

type MerchantGatewayVerifyResponse = {
  verified?: boolean;
  readinessStatus?: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  error?: string;
  canaryUrl?: string;
  statusCode?: number | null;
  latencyMs?: number | null;
};

type MerchantGatewayDelegatedSignerRegisterResponse = {
  ok?: boolean;
  created?: boolean;
  alreadyActive?: boolean;
  error?: string;
};

export type MerchantActivateOptions = {
  agentId: string;
  serviceSlug: string;
  endpointUrl: string;
  canaryPath?: string;
  canaryMethod?: string;
  signerLabel?: string;
};

export type ActivateResult = {
  status: "LIVE";
  readiness: "LIVE";
  config: MerchantGatewayConfigResponse["config"];
  verify: MerchantGatewayVerifyResponse;
  signerRegistration: MerchantGatewayDelegatedSignerRegisterResponse;
  heartbeat: HeartbeatController;
};

export type WirePricingAmount = {
  asset: string;
  amount: string;
  decimals: number;
  bps?: number;
  chainId?: number;
};

export type GhostWireWalletTxRequest = {
  to: `0x${string}` | string;
  data: `0x${string}` | string;
  value: `0x${string}` | string;
  chainId: number;
};

export type GhostWireBalanceAnalysis = {
  asset: string;
  amount: string;
  decimals: number;
  requiredAmount?: string;
  sufficient?: boolean;
};

export type GhostWireDirectPrepare = {
  approvalMode: "exact" | "unlimited";
  contractAddress: string;
  paymentTokenAddress: string;
  expectedBudgetAmount: string;
  description?: string;
  allowance: GhostWireBalanceAnalysis;
  balance: GhostWireBalanceAnalysis;
  nativeBalance: GhostWireBalanceAnalysis;
  approveTxRequest: GhostWireWalletTxRequest | null;
  createTxRequest?: GhostWireWalletTxRequest | null;
  setBudgetTxRequest?: GhostWireWalletTxRequest | null;
  fundTxRequest?: GhostWireWalletTxRequest | null;
  nextAction: "submit_create_artifact" | "submit_fund_artifact";
};

export type WireQuoteResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  quoteId: string | null;
  expiresAt: string | null;
  chainId: number | null;
  contractAddress: string | null;
  paymentTokenAddress: string | null;
  pricing: {
    principal: WirePricingAmount;
    protocolFee: WirePricingAmount;
    networkReserve: WirePricingAmount;
    display?: unknown;
  } | null;
  confirmations: {
    min: number;
  } | null;
  directExecution: {
    customerFundsEscrow: boolean;
    customerPaysGas: boolean;
    sponsorshipSupported: boolean;
  } | null;
};

export type WireJobPrepareInput = {
  quoteId: string;
  client: `0x${string}` | string;
  provider: `0x${string}` | string;
  evaluator: `0x${string}` | string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  specHash: `0x${string}` | string;
  metadataUri?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  approvalMode?: "exact" | "unlimited";
};

export type WireJobPrepareResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  jobId: string | null;
  quoteId: string | null;
  chainId: number | null;
  jobExpiresAt: string | null;
  direct: GhostWireDirectPrepare | null;
};

export type WireArtifactRecordInput = {
  jobId: string;
  clientAddress: `0x${string}` | string;
  createTxHash?: `0x${string}` | string | null;
  fundTxHash?: `0x${string}` | string | null;
  createTxSender?: `0x${string}` | string | null;
  fundTxSender?: `0x${string}` | string | null;
  approvalMode?: "exact" | "unlimited";
  clientPrivateKey?: `0x${string}` | null;
};

export type WireArtifactRecordResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  job: WireJobSnapshot | null;
  direct: GhostWireDirectPrepare | null;
};

export type WireJobSnapshot = {
  id: string;
  jobId: string;
  quoteId: string;
  chainId: number;
  jobExpiresAt: string;
  state: string;
  contractState: string;
  terminalDisposition: string | null;
  clientAddress: string;
  providerAddress: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  evaluatorAddress: string;
  specHash: string;
  metadataUri: string | null;
  contractAddress: string | null;
  contractJobId: string | null;
  createTxHash: string | null;
  createTxSender?: string | null;
  fundTxHash: string | null;
  fundTxSender?: string | null;
  terminalTxHash: string | null;
  artifactsRecordedAt?: string | null;
  artifactValidationState?: string | null;
  artifactValidationError?: string | null;
  recoveryAction?: string | null;
  recoveryHint?: string | null;
  createdAt: string;
  updatedAt: string;
  pricing: {
    principal: WirePricingAmount;
    protocolFee: WirePricingAmount;
    networkReserve: WirePricingAmount;
  };
  operator: {
    artifactStatus?: string | null;
    artifactCheckedAt?: string | null;
    createStatus: string | null;
    fundStatus: string | null;
    confirmationStatus: string | null;
    reconcileStatus: string | null;
    retryCount: number | null;
    nextRetryAt: string | null;
    lastError: string | null;
    manualReviewRequired?: boolean | null;
    manualReviewReason?: string | null;
  };
  settlement?: unknown;
  deliverable?: {
    available: boolean;
    locatorUrl: string | null;
    mode: "merchant_locator" | "gateway_standard" | "ipfs_gateway" | "none";
    state: "READY" | "PENDING" | "UNCONFIGURED";
  };
};

export type WireJobResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  job: WireJobSnapshot | null;
};

export type WireDeliverableResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  job: WireJobSnapshot;
  contentType: string | null;
  bodyJson: unknown | null;
  bodyText: string | null;
  sourceUrl: string;
};

export type WireCompletionWaitOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "connect";
const DEFAULT_CREDIT_COST = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_X402_SCHEME = "exact";
const DEFAULT_X402_ASSET = "USDC";
const DEFAULT_X402_DECIMALS = 6;
const DEFAULT_X402_MAX_AMOUNT_ATOMIC = 100_000n;
const DEFAULT_ACTIVATE_CANARY_PATH = "/health";
const DEFAULT_ACTIVATE_CANARY_METHOD = "GET";
const DEFAULT_ACTIVATE_SIGNER_LABEL = "sdk-auto";
const MERCHANT_GATEWAY_AUTH_SCOPE = "agent_gateway" as const;
const MERCHANT_GATEWAY_AUTH_VERSION = "1" as const;

const ACCESS_TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const getApiKeyPrefix = (apiKey: string): string => {
  if (apiKey.length <= 8) return apiKey;
  return `${apiKey.slice(0, 8)}...`;
};

const parsePayload = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const parseTextPayload = async (response: Response): Promise<string | null> => {
  try {
    return await response.text();
  } catch {
    return null;
  }
};

const deriveAgentId = (serviceSlug: string | null): string | null => {
  if (!serviceSlug) return null;
  const match = /^agent-(.+)$/i.exec(serviceSlug);
  return match?.[1] ?? null;
};

const resolveWireDeliverableLocator = (job: WireJobSnapshot): string | null => {
  const summaryLocator = normalizeOptionalString(job.deliverable?.locatorUrl ?? null);
  if (summaryLocator) return summaryLocator;

  const metadataLocator = normalizeOptionalString(job.metadataUri);
  if (!metadataLocator) return null;

  try {
    const parsed = new URL(metadataLocator);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const toOptionalMetadata = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  value && Object.keys(value).length > 0 ? value : undefined;

const assertTelemetryIdentity = (input: {
  apiKey: string | null;
  agentId: string | null;
  serviceSlug: string | null;
}): void => {
  if (input.apiKey || input.agentId || input.serviceSlug) return;
  throw new Error("Telemetry calls require at least one of apiKey, agentId, or serviceSlug.");
};

const normalizeTelemetryStatusCode = (value: number | null | undefined): number | null => {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("statusCode must be an integer in the HTTP status range.");
  }
  return value;
};

const buildCanaryHeaders = (): Record<string, string> => ({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

const CHAIN_ID_TO_X402_NETWORK: Partial<Record<number, X402Network>> = {
  8453: "base",
  84532: "base-sepolia",
};

const assertPrivateKey = (value: `0x${string}` | null | undefined, name: string): `0x${string}` => {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return value;
};

const normalizeAddressLower = (value: string): string => value.trim().toLowerCase();

const normalizePositiveBigInt = (
  value: bigint | number | string | null | undefined,
  fallback: bigint,
  fieldName: string,
): bigint => {
  if (value == null) return fallback;
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${fieldName} must be non-negative.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`${fieldName} must be a non-negative integer.`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a non-negative integer string.`);
  }
  return BigInt(trimmed);
};

const resolveX402Network = (network: X402Network | null | undefined, chainId: number): X402Network => {
  if (network) return network;
  const inferred = CHAIN_ID_TO_X402_NETWORK[chainId];
  if (inferred) return inferred;
  throw new Error(`Unsupported chainId ${chainId} for requestX402(). Pass network explicitly.`);
};

const normalizeX402Timestamp = (value: string | Date | null | undefined): string =>
  value instanceof Date ? value.toISOString() : normalizeOptionalString(value) ?? new Date().toISOString();

const normalizeOptionalInteger = (value: number | null | undefined, fieldName: string): number | null => {
  if (value == null) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer when provided.`);
  }
  return value;
};

const normalizeX402RequestBody = (input: {
  body: unknown;
  headers: Record<string, string>;
}): { body: BodyInit | undefined; headers: Record<string, string> } => {
  if (input.body == null) {
    return { body: undefined, headers: input.headers };
  }

  if (
    typeof input.body === "string" ||
    input.body instanceof ArrayBuffer ||
    ArrayBuffer.isView(input.body) ||
    input.body instanceof Blob ||
    input.body instanceof FormData ||
    input.body instanceof URLSearchParams ||
    input.body instanceof ReadableStream
  ) {
    return {
      body: input.body as BodyInit,
      headers: input.headers,
    };
  }

  const nextHeaders = { ...input.headers };
  if (!Object.keys(nextHeaders).some((key) => key.toLowerCase() === "content-type")) {
    nextHeaders["content-type"] = "application/json";
  }
  return {
    body: JSON.stringify(input.body),
    headers: nextHeaders,
  };
};

const createMerchantGatewayAuthPayload = (input: {
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
}): MerchantGatewayAuthPayload => ({
  scope: MERCHANT_GATEWAY_AUTH_SCOPE,
  version: MERCHANT_GATEWAY_AUTH_VERSION,
  action: input.action,
  agentId: input.agentId,
  ownerAddress: normalizeAddressLower(input.ownerAddress),
  actorAddress: normalizeAddressLower(input.actorAddress),
  serviceSlug: input.serviceSlug,
  nonce: randomUUID().replace(/-/g, ""),
  issuedAt: Math.floor(Date.now() / 1000),
});

const buildMerchantGatewayAuthMessage = (payload: MerchantGatewayAuthPayload): string =>
  [
    "Ghost Protocol Merchant Gateway Authorization",
    `scope:${payload.scope}`,
    `version:${payload.version}`,
    `action:${payload.action}`,
    `agentId:${payload.agentId}`,
    `serviceSlug:${payload.serviceSlug}`,
    `ownerAddress:${payload.ownerAddress}`,
    `actorAddress:${payload.actorAddress}`,
    `issuedAt:${payload.issuedAt}`,
    `nonce:${payload.nonce}`,
  ].join("\n");

const normalizeWireHash = (value: string | null | undefined): `0x${string}` | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

const buildWireArtifactAuthPayload = (input: {
  jobId: string;
  clientAddress: string;
  createTxHash?: string | null;
  fundTxHash?: string | null;
  issuedAt?: number;
  nonce?: string;
}) => ({
  scope: "ghostwire_artifacts" as const,
  version: "1" as const,
  jobId: input.jobId,
  clientAddress: normalizeAddressLower(input.clientAddress),
  createTxHash: normalizeWireHash(input.createTxHash ?? null),
  fundTxHash: normalizeWireHash(input.fundTxHash ?? null),
  issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
  nonce: input.nonce ?? randomUUID().replace(/-/g, ""),
});

const buildWireArtifactAuthMessage = (payload: ReturnType<typeof buildWireArtifactAuthPayload>): string =>
  [
    "Ghost Protocol GhostWire Artifact Authorization",
    `scope:${payload.scope}`,
    `version:${payload.version}`,
    `jobId:${payload.jobId}`,
    `clientAddress:${payload.clientAddress}`,
    `createTxHash:${payload.createTxHash ?? ""}`,
    `fundTxHash:${payload.fundTxHash ?? ""}`,
    `issuedAt:${payload.issuedAt}`,
    `nonce:${payload.nonce}`,
  ].join("\n");

export const buildCanaryPayload = (serviceSlug: string): CanaryPayload => {
  const normalized = normalizeOptionalString(serviceSlug);
  if (!normalized) throw new Error("serviceSlug is required for canary payloads.");
  return {
    ghostgate: "ready",
    service: normalized,
  };
};

export const createCanaryHandler = (serviceSlug: string) => {
  const payload = buildCanaryPayload(serviceSlug);
  return (_req?: unknown, res?: unknown): unknown => {
    const headers = buildCanaryHeaders();
    if (res && typeof res === "object") {
      const response = res as {
        setHeader?: (name: string, value: string) => unknown;
        status?: (statusCode: number) => { json?: (body: unknown) => unknown } | unknown;
        json?: (body: unknown) => unknown;
        writeHead?: (statusCode: number, headers?: Record<string, string>) => unknown;
        end?: (body?: string) => unknown;
      };

      if (typeof response.status === "function" && typeof response.json === "function") {
        for (const [key, value] of Object.entries(headers)) {
          response.setHeader?.(key, value);
        }
        response.status(200);
        return response.json(payload);
      }

      if (typeof response.writeHead === "function" && typeof response.end === "function") {
        response.writeHead(200, headers);
        return response.end(JSON.stringify(payload));
      }
    }

    return {
      status: 200,
      headers,
      body: payload,
    };
  };
};

export class GhostAgent {
  private apiKey: string | null;
  private readonly agentId: string | null;
  private readonly baseUrl: string;
  private readonly privateKey: `0x${string}` | null;
  private readonly chainId: number;
  private readonly telemetryServiceSlug: string | null;
  private readonly serviceSlug: string;
  private readonly creditCost: number;

  constructor(config: GhostAgentConfig = {}) {
    const normalizedServiceSlug = normalizeOptionalString(config.serviceSlug);
    this.apiKey = normalizeOptionalString(config.apiKey) ?? null;
    this.agentId = normalizeOptionalString(config.agentId);
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.privateKey = config.privateKey ?? null;
    this.chainId = config.chainId ?? DEFAULT_CHAIN_ID;
    this.telemetryServiceSlug = normalizedServiceSlug;
    this.serviceSlug = normalizedServiceSlug ?? DEFAULT_SERVICE_SLUG;
    this.creditCost = Number.isFinite(config.creditCost) && (config.creditCost ?? 0) > 0
      ? Math.trunc(config.creditCost as number)
      : DEFAULT_CREDIT_COST;
  }

  async connect(apiKey?: string): Promise<ConnectResult> {
    const normalizedApiKey = normalizeOptionalString(apiKey) ?? this.apiKey;
    if (!normalizedApiKey) {
      throw new Error("connect(apiKey?) requires a non-empty API key via argument or constructor config.");
    }
    if (!this.privateKey) {
      throw new Error(
        "GhostAgent requires a signing privateKey in constructor config to call /api/gate/[...slug].",
      );
    }

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const signedPayload = {
      service: this.serviceSlug,
      timestamp,
      nonce: randomUUID().replace(/-/g, ""),
    } as const;
    const headerPayload = {
      service: this.serviceSlug,
      timestamp: timestamp.toString(),
      nonce: signedPayload.nonce,
    } as const;

    const account = privateKeyToAccount(this.privateKey);
    const signature = await account.signTypedData({
      domain: {
        name: "GhostGate",
        version: "1",
        chainId: this.chainId,
      },
      types: ACCESS_TYPES,
      primaryType: "Access",
      message: signedPayload,
    });

    const endpoint = `${this.baseUrl}/api/gate/${encodeURIComponent(this.serviceSlug)}`;
    const gateHeaders: Record<string, string> = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "x-ghost-sig": signature,
      "x-ghost-payload": JSON.stringify(headerPayload),
      "x-ghost-credit-cost": String(this.creditCost),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: gateHeaders,
      cache: "no-store",
    });

    const responsePayload = await parsePayload(response);
    if (response.ok) {
      this.apiKey = normalizedApiKey;
    }

    return {
      connected: response.ok,
      apiKeyPrefix: getApiKeyPrefix(normalizedApiKey),
      endpoint,
      status: response.status,
      payload: responsePayload,
    };
  }

  async requestX402(input: X402RequestInput): Promise<X402RequestResult> {
    const privateKey = assertPrivateKey(this.privateKey, "privateKey");
    const network = resolveX402Network(input.network, this.chainId);
    const signer = await createSigner(network, privateKey);
    const maxAmountAtomic = normalizePositiveBigInt(
      input.maxAmountAtomic,
      DEFAULT_X402_MAX_AMOUNT_ATOMIC,
      "maxAmountAtomic",
    );
    const fetchWithPayment = wrapFetchWithPayment(
      globalThis.fetch,
      signer,
      maxAmountAtomic,
      input.paymentRequirementsSelector,
    );
    const method = normalizeOptionalString(input.method)?.toUpperCase() ?? "GET";
    const normalizedHeaders = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      ...(input.headers ?? {}),
    };
    const preparedBody = normalizeX402RequestBody({
      body: input.body,
      headers: normalizedHeaders,
    });
    const response = await fetchWithPayment(input.url, {
      method,
      headers: preparedBody.headers,
      ...(preparedBody.body !== undefined ? { body: preparedBody.body } : {}),
      cache: "no-store",
    });
    const paymentResponseHeader =
      normalizeOptionalString(response.headers.get("x-payment-response")) ??
      normalizeOptionalString(response.headers.get("X-PAYMENT-RESPONSE"));
    const payload = await parsePayload(response.clone());

    return {
      ok: response.ok,
      endpoint: response.url || input.url,
      status: response.status,
      payload,
      paymentResponseHeader,
      paymentResponse: paymentResponseHeader ? decodeXPaymentResponse(paymentResponseHeader) : null,
    };
  }

  async pulse(input: PulseInput = {}): Promise<TelemetryResult> {
    const apiKey = normalizeOptionalString(input.apiKey) ?? this.apiKey;
    const serviceSlug = normalizeOptionalString(input.serviceSlug) ?? this.telemetryServiceSlug;
    const agentId = normalizeOptionalString(input.agentId) ?? this.agentId ?? deriveAgentId(serviceSlug);

    assertTelemetryIdentity({ apiKey, agentId, serviceSlug });

    const endpoint = `${this.baseUrl}/api/telemetry/pulse`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(agentId ? { agentId } : {}),
        ...(serviceSlug ? { serviceSlug } : {}),
        ...(toOptionalMetadata(input.metadata) ? { metadata: input.metadata } : {}),
      }),
      cache: "no-store",
    });

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload: await parsePayload(response),
    };
  }

  async outcome(input: OutcomeInput): Promise<TelemetryResult> {
    const apiKey = normalizeOptionalString(input.apiKey) ?? this.apiKey;
    const serviceSlug = normalizeOptionalString(input.serviceSlug) ?? this.telemetryServiceSlug;
    const agentId = normalizeOptionalString(input.agentId) ?? this.agentId ?? deriveAgentId(serviceSlug);
    const statusCode = normalizeTelemetryStatusCode(input.statusCode);

    assertTelemetryIdentity({ apiKey, agentId, serviceSlug });

    const endpoint = `${this.baseUrl}/api/telemetry/outcome`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(agentId ? { agentId } : {}),
        ...(serviceSlug ? { serviceSlug } : {}),
        success: Boolean(input.success),
        ...(statusCode != null ? { statusCode } : {}),
        ...(toOptionalMetadata(input.metadata) ? { metadata: input.metadata } : {}),
      }),
      cache: "no-store",
    });

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload: await parsePayload(response),
    };
  }

  async createWireQuote(input: {
    provider: `0x${string}` | string;
    evaluator: `0x${string}` | string;
    principalAmount: string;
    chainId?: number;
    client: `0x${string}` | string;
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
  }): Promise<WireQuoteResult> {
    const endpoint = `${this.baseUrl}/api/wire/quote`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        provider: input.provider,
        evaluator: input.evaluator,
        principalAmount: input.principalAmount,
        settlementAsset: "USDC",
        chainId: input.chainId ?? this.chainId,
        ...(normalizeOptionalString(input.client ?? null) ? { client: input.client } : {}),
        ...(normalizeOptionalString(input.providerAgentId ?? null)
          ? { providerAgentId: input.providerAgentId }
          : {}),
        ...(normalizeOptionalString(input.providerServiceSlug ?? null)
          ? { providerServiceSlug: input.providerServiceSlug }
          : {}),
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null && "quoteId" in payload
        ? (payload as {
            quoteId?: unknown;
            expiresAt?: unknown;
            chainId?: unknown;
            contractAddress?: unknown;
            paymentTokenAddress?: unknown;
            pricing?: unknown;
            confirmations?: unknown;
            directExecution?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      quoteId: typeof record?.quoteId === "string" ? record.quoteId : null,
      expiresAt: typeof record?.expiresAt === "string" ? record.expiresAt : null,
      chainId: typeof record?.chainId === "number" ? record.chainId : null,
      contractAddress: typeof record?.contractAddress === "string" ? record.contractAddress : null,
      paymentTokenAddress: typeof record?.paymentTokenAddress === "string" ? record.paymentTokenAddress : null,
      pricing:
        typeof record?.pricing === "object" && record.pricing !== null
          ? (record.pricing as WireQuoteResult["pricing"])
          : null,
      confirmations:
        typeof record?.confirmations === "object" && record.confirmations !== null
          ? (record.confirmations as WireQuoteResult["confirmations"])
          : null,
      directExecution:
        typeof record?.directExecution === "object" && record.directExecution !== null
          ? (record.directExecution as WireQuoteResult["directExecution"])
          : null,
    };
  }

  async prepareWireJob(input: WireJobPrepareInput): Promise<WireJobPrepareResult> {
    const endpoint = `${this.baseUrl}/api/wire/jobs`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        quoteId: input.quoteId,
        client: input.client,
        provider: input.provider,
        evaluator: input.evaluator,
        ...(normalizeOptionalString(input.providerAgentId ?? null)
          ? { providerAgentId: input.providerAgentId }
          : {}),
        ...(normalizeOptionalString(input.providerServiceSlug ?? null)
          ? { providerServiceSlug: input.providerServiceSlug }
          : {}),
        specHash: input.specHash,
        ...(normalizeOptionalString(input.metadataUri ?? null) ? { metadataUri: input.metadataUri } : {}),
        ...(normalizeOptionalString(input.webhookUrl ?? null) ? { webhookUrl: input.webhookUrl } : {}),
        ...(normalizeOptionalString(input.webhookSecret ?? null) ? { webhookSecret: input.webhookSecret } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null && "jobId" in payload
        ? (payload as {
            jobId?: unknown;
            quoteId?: unknown;
            chainId?: unknown;
            jobExpiresAt?: unknown;
            direct?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      jobId: typeof record?.jobId === "string" ? record.jobId : null,
      quoteId: typeof record?.quoteId === "string" ? record.quoteId : null,
      chainId: typeof record?.chainId === "number" ? record.chainId : null,
      jobExpiresAt: typeof record?.jobExpiresAt === "string" ? record.jobExpiresAt : null,
      direct:
        typeof record?.direct === "object" && record.direct !== null
          ? (record.direct as GhostWireDirectPrepare)
          : null,
    };
  }

  async recordWireArtifacts(input: WireArtifactRecordInput): Promise<WireArtifactRecordResult> {
    const normalizedJobId = normalizeOptionalString(input.jobId);
    if (!normalizedJobId) {
      throw new Error("recordWireArtifacts(jobId, ...) requires a non-empty GhostWire job id.");
    }

    const createTxHash = normalizeWireHash(input.createTxHash ?? null);
    const fundTxHash = normalizeWireHash(input.fundTxHash ?? null);
    if (!createTxHash && !fundTxHash) {
      throw new Error("recordWireArtifacts requires at least one of createTxHash or fundTxHash.");
    }

    const clientPrivateKey = input.clientPrivateKey ?? this.privateKey;
    if (!clientPrivateKey) {
      throw new Error("recordWireArtifacts requires a clientPrivateKey or GhostAgent.privateKey.");
    }

    const clientAccount = privateKeyToAccount(clientPrivateKey);
    if (normalizeAddressLower(clientAccount.address) !== normalizeAddressLower(input.clientAddress)) {
      throw new Error("recordWireArtifacts clientPrivateKey does not match the provided clientAddress.");
    }

    const authPayload = buildWireArtifactAuthPayload({
      jobId: normalizedJobId,
      clientAddress: input.clientAddress,
      createTxHash,
      fundTxHash,
    });
    const authSignature = await clientAccount.signMessage({
      message: buildWireArtifactAuthMessage(authPayload),
    });

    const endpoint = `${this.baseUrl}/api/wire/jobs/${encodeURIComponent(normalizedJobId)}/artifacts`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(createTxHash ? { createTxHash } : {}),
        ...(fundTxHash ? { fundTxHash } : {}),
        ...(normalizeOptionalString(input.createTxSender ?? null) ? { createTxSender: input.createTxSender } : {}),
        ...(normalizeOptionalString(input.fundTxSender ?? null) ? { fundTxSender: input.fundTxSender } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
        authPayload,
        authSignature,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as {
            job?: unknown;
            direct?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      job:
        typeof record?.job === "object" && record.job !== null
          ? (record.job as WireJobSnapshot)
          : null,
      direct:
        typeof record?.direct === "object" && record.direct !== null
          ? (record.direct as GhostWireDirectPrepare)
          : null,
    };
  }

  async getWireJob(jobId: string): Promise<WireJobResult> {
    const normalizedJobId = normalizeOptionalString(jobId);
    if (!normalizedJobId) {
      throw new Error("getWireJob(jobId) requires a non-empty GhostWire job id.");
    }

    const endpoint = `${this.baseUrl}/api/wire/jobs/${encodeURIComponent(normalizedJobId)}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const job =
      typeof payload === "object" &&
      payload !== null &&
      "job" in payload &&
      typeof (payload as { job?: unknown }).job === "object" &&
      (payload as { job?: unknown }).job !== null
        ? ((payload as { job: WireJobSnapshot }).job)
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      job,
    };
  }

  async waitForWireTerminal(jobId: string, options: WireCompletionWaitOptions = {}): Promise<WireJobSnapshot> {
    const intervalMs =
      Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
        ? Math.trunc(options.intervalMs as number)
        : 5_000;
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
        ? Math.trunc(options.timeoutMs as number)
        : 5 * 60_000;
    const startedAt = Date.now();

    while (true) {
      const result = await this.getWireJob(jobId);
      if (!result.ok || !result.job) {
        throw new Error(`waitForWireTerminal failed to fetch job ${jobId} (status ${result.status}).`);
      }
      if (["COMPLETED", "REJECTED", "EXPIRED"].includes(result.job.contractState)) {
        return result.job;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`GhostWire job ${jobId} did not reach a terminal state before timeout.`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async getWireDeliverable(jobId: string): Promise<WireDeliverableResult> {
    const jobResult = await this.getWireJob(jobId);
    if (!jobResult.ok || !jobResult.job) {
      throw new Error(`getWireDeliverable failed to fetch job ${jobId} (status ${jobResult.status}).`);
    }

    const job = jobResult.job;
    if (job.contractState !== "COMPLETED") {
      throw new Error(`GhostWire job ${jobId} is not completed yet.`);
    }

    const sourceUrl = resolveWireDeliverableLocator(job);
    if (!sourceUrl) {
      throw new Error(`GhostWire job ${jobId} does not expose a deliverable locator.`);
    }

    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const contentType = normalizeOptionalString(response.headers.get("content-type"));
    const bodyText = await parseTextPayload(response);
    let bodyJson: unknown | null = null;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText) as unknown;
      } catch {
        bodyJson = null;
      }
    }

    if (!response.ok) {
      throw new Error(
        `GhostWire deliverable fetch failed for ${jobId} from ${sourceUrl} (status ${response.status}).`,
      );
    }

    return {
      ok: response.ok,
      endpoint: sourceUrl,
      status: response.status,
      job,
      contentType,
      bodyJson,
      bodyText,
      sourceUrl,
    };
  }

  startHeartbeat(options: HeartbeatOptions = {}): HeartbeatController {
    const intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
      ? Math.trunc(options.intervalMs as number)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const immediate = options.immediate ?? true;
    let stopped = false;
    let inFlight = false;

    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const result = await this.pulse(options);
        options.onResult?.(result);
      } catch (error) {
        options.onError?.(error);
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, intervalMs);

    if (immediate) {
      void tick();
    }

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  get isConnected(): boolean {
    return this.apiKey !== null;
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/gate`;
  }
}

export class GhostMerchant extends GhostFulfillmentMerchant {
  private readonly merchantServiceSlug: string;
  private readonly merchantBaseUrl: string;
  private readonly ownerPrivateKey: `0x${string}` | null;
  private readonly settlementDelegatedPrivateKey: `0x${string}` | null;
  private readonly ownerAddress: string | null;
  private readonly delegatedSignerAddress: string | null;
  private heartbeatController: HeartbeatController | null = null;

  constructor(config: GhostMerchantConfig) {
    super(config);
    const normalizedServiceSlug = normalizeOptionalString(config.serviceSlug);
    if (!normalizedServiceSlug) {
      throw new Error("GhostMerchant.serviceSlug is required.");
    }
    this.merchantServiceSlug = normalizedServiceSlug;
    this.merchantBaseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.ownerPrivateKey = config.ownerPrivateKey ? assertPrivateKey(config.ownerPrivateKey, "ownerPrivateKey") : null;
    this.settlementDelegatedPrivateKey = config.delegatedPrivateKey
      ? assertPrivateKey(config.delegatedPrivateKey, "delegatedPrivateKey")
      : null;
    this.ownerAddress = this.ownerPrivateKey ? privateKeyToAccount(this.ownerPrivateKey).address.toLowerCase() : null;
    this.delegatedSignerAddress = this.settlementDelegatedPrivateKey
      ? privateKeyToAccount(this.settlementDelegatedPrivateKey).address.toLowerCase()
      : null;
  }

  canaryPayload(): CanaryPayload {
    return buildCanaryPayload(this.merchantServiceSlug);
  }

  canaryHandler() {
    return createCanaryHandler(this.merchantServiceSlug);
  }

  async activate(options: MerchantActivateOptions): Promise<ActivateResult> {
    const agentId = normalizeOptionalString(options.agentId);
    const serviceSlug = normalizeOptionalString(options.serviceSlug);
    const endpointUrl = normalizeOptionalString(options.endpointUrl);
    const canaryPath = normalizeOptionalString(options.canaryPath) ?? DEFAULT_ACTIVATE_CANARY_PATH;
    const canaryMethod = (normalizeOptionalString(options.canaryMethod) ?? DEFAULT_ACTIVATE_CANARY_METHOD).toUpperCase();
    const signerLabel = normalizeOptionalString(options.signerLabel) ?? DEFAULT_ACTIVATE_SIGNER_LABEL;

    if (!agentId) throw new Error("[activate:validate] agentId is required.");
    if (!serviceSlug) throw new Error("[activate:validate] serviceSlug is required.");
    if (!endpointUrl) throw new Error("[activate:validate] endpointUrl is required.");
    if (!canaryPath.startsWith("/")) {
      throw new Error("[activate:validate] canaryPath must start with '/'.");
    }
    if (canaryMethod !== "GET") {
      throw new Error("[activate:validate] canaryMethod must be GET.");
    }
    if (!this.ownerPrivateKey || !this.ownerAddress) {
      throw new Error(
        "[activate:owner] ownerPrivateKey is required on GhostMerchant config and must match the indexed agent owner.",
      );
    }

    const ownerConfig = await this.fetchGatewayOwnerConfig(agentId);
    const indexedOwnerAddress = normalizeAddressLower(ownerConfig.config.ownerAddress);
    if (indexedOwnerAddress !== this.ownerAddress) {
      throw new Error(
        `[activate:owner] ownerPrivateKey address ${this.ownerAddress} does not match indexed owner ${indexedOwnerAddress} for agent ${agentId}.`,
      );
    }

    const configPayload = (await this.postMerchantSignedWrite("config", {
      path: "/api/agent-gateway/config",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {
        endpointUrl,
        canaryPath,
        canaryMethod: "GET",
      },
    })) as { config?: MerchantGatewayConfigResponse["config"] };

    const verifyPayload = (await this.postMerchantSignedWrite("verify", {
      path: "/api/agent-gateway/verify",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {},
    })) as MerchantGatewayVerifyResponse;

    const readiness = verifyPayload.readinessStatus;
    if (verifyPayload.verified !== true || readiness !== "LIVE") {
      const detailParts = [
        verifyPayload.error ? `error=${verifyPayload.error}` : null,
        verifyPayload.canaryUrl ? `canaryUrl=${verifyPayload.canaryUrl}` : null,
        typeof verifyPayload.statusCode === "number" ? `statusCode=${verifyPayload.statusCode}` : null,
        typeof verifyPayload.latencyMs === "number" ? `latencyMs=${verifyPayload.latencyMs}` : null,
      ].filter(Boolean);
      throw new Error(
        `[activate:verify] canary verification did not reach LIVE readiness${detailParts.length ? ` (${detailParts.join(", ")})` : ""}.`,
      );
    }

    const signerAddress = this.delegatedSignerAddress ?? indexedOwnerAddress;
    const signerRegistration = (await this.postMerchantSignedWrite("delegated_signer_register", {
      path: "/api/agent-gateway/delegated-signers/register",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {
        signerAddress,
        label: signerLabel,
      },
    })) as MerchantGatewayDelegatedSignerRegisterResponse;

    this.heartbeatController?.stop();
    const heartbeatAgent = new GhostAgent({
      baseUrl: this.merchantBaseUrl,
      agentId,
      serviceSlug,
    });
    this.heartbeatController = heartbeatAgent.startHeartbeat({
      agentId,
      serviceSlug,
      immediate: false,
    });

    return {
      status: "LIVE",
      readiness: "LIVE",
      config: configPayload.config ?? ownerConfig.config,
      verify: verifyPayload,
      signerRegistration,
      heartbeat: this.heartbeatController,
    };
  }

  async reportX402Settlement(input: X402SettlementReportInput): Promise<X402SettlementReportResult> {
    const agentId = normalizeOptionalString(input.agentId);
    const serviceSlug = normalizeOptionalString(input.serviceSlug);
    const requestId = normalizeOptionalString(input.requestId);
    const paymentReference = normalizeOptionalString(input.paymentReference);
    const payerIdentity = normalizeOptionalString(input.payerIdentity);
    const payerAddress = normalizeOptionalString(input.payerAddress ?? null);
    const scheme = normalizeOptionalString(input.scheme) ?? DEFAULT_X402_SCHEME;
    const asset = normalizeOptionalString(input.asset) ?? DEFAULT_X402_ASSET;
    const occurredAt = normalizeX402Timestamp(input.occurredAt);
    const statusCode = normalizeOptionalInteger(input.statusCode ?? null, "statusCode");
    const latencyMs = normalizeOptionalInteger(input.latencyMs ?? null, "latencyMs");
    const amountAtomic = normalizePositiveBigInt(input.amountAtomic, 0n, "amountAtomic");

    if (!agentId) throw new Error("reportX402Settlement(agentId) requires a non-empty agentId.");
    if (!serviceSlug) throw new Error("reportX402Settlement(serviceSlug) requires a non-empty serviceSlug.");
    if (!requestId) throw new Error("reportX402Settlement(requestId) requires a non-empty requestId.");
    if (!paymentReference) {
      throw new Error("reportX402Settlement(paymentReference) requires a non-empty paymentReference.");
    }
    if (!payerIdentity) throw new Error("reportX402Settlement(payerIdentity) requires a non-empty payerIdentity.");

    const ownerConfig = await this.fetchGatewayOwnerConfig(agentId);
    const ownerAddress = normalizeAddressLower(ownerConfig.config.ownerAddress);
    const actorKey = this.settlementDelegatedPrivateKey ?? this.ownerPrivateKey;
    if (!actorKey) {
      throw new Error(
        "reportX402Settlement requires delegatedPrivateKey or ownerPrivateKey on GhostMerchant config.",
      );
    }
    const actorAddress = privateKeyToAccount(actorKey).address.toLowerCase();
    const authPayload = createMerchantGatewayAuthPayload({
      action: "x402_settlement_report",
      agentId,
      ownerAddress,
      actorAddress,
      serviceSlug,
    });
    const authSignature = await privateKeyToAccount(actorKey).signMessage({
      message: buildMerchantGatewayAuthMessage(authPayload),
    });
    const endpoint = `${this.merchantBaseUrl}/api/telemetry/x402/settlements`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        agentId,
        ownerAddress,
        actorAddress,
        serviceSlug,
        requestId,
        paymentReference,
        payerIdentity,
        ...(payerAddress ? { payerAddress: normalizeAddressLower(payerAddress) } : {}),
        scheme,
        ...(normalizeOptionalString(input.network ?? null) ? { network: input.network } : {}),
        ...(typeof input.chainId === "number" ? { chainId: input.chainId } : {}),
        asset,
        amountAtomic: amountAtomic.toString(),
        decimals: input.decimals ?? DEFAULT_X402_DECIMALS,
        success: Boolean(input.success),
        ...(statusCode != null ? { statusCode } : {}),
        ...(latencyMs != null ? { latencyMs } : {}),
        occurredAt,
        ...(toOptionalMetadata(input.metadata) ? { metadata: input.metadata } : {}),
        authPayload,
        authSignature,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      countedForRank:
        typeof payload === "object" &&
        payload !== null &&
        "countedForRank" in payload &&
        typeof (payload as { countedForRank?: unknown }).countedForRank === "boolean"
          ? Boolean((payload as { countedForRank: boolean }).countedForRank)
          : false,
      relatedParty:
        typeof payload === "object" &&
        payload !== null &&
        "relatedParty" in payload &&
        typeof (payload as { relatedParty?: unknown }).relatedParty === "boolean"
          ? Boolean((payload as { relatedParty: boolean }).relatedParty)
          : false,
      duplicate:
        typeof payload === "object" &&
        payload !== null &&
        "duplicate" in payload &&
        typeof (payload as { duplicate?: unknown }).duplicate === "boolean"
          ? Boolean((payload as { duplicate: boolean }).duplicate)
          : false,
    };
  }

  async reportX402Settlements(inputs: X402SettlementReportInput[]): Promise<X402SettlementReportResult[]> {
    return Promise.all(inputs.map((input) => this.reportX402Settlement(input)));
  }

  private async fetchGatewayOwnerConfig(agentId: string): Promise<MerchantGatewayConfigResponse> {
    const params = new URLSearchParams({ agentId });
    const endpoint = `${this.merchantBaseUrl}/api/agent-gateway/config?${params.toString()}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    if (!response.ok) {
      const message = this.extractApiErrorMessage(payload, "Failed to load gateway owner config.");
      throw new Error(`[activate:config_lookup] ${message}`);
    }
    const config =
      typeof payload === "object" &&
      payload !== null &&
      "config" in payload &&
      typeof (payload as { config?: unknown }).config === "object" &&
      (payload as { config?: unknown }).config !== null
        ? ((payload as { config: MerchantGatewayConfigResponse["config"] }).config)
        : null;
    if (!config || !normalizeOptionalString(config.ownerAddress)) {
      throw new Error("[activate:config_lookup] gateway config response missing ownerAddress.");
    }
    return {
      configured:
        typeof payload === "object" && payload !== null && "configured" in payload
          ? Boolean((payload as { configured?: unknown }).configured)
          : false,
      config,
    };
  }

  private async postMerchantSignedWrite(
    action: MerchantGatewayAuthAction,
    input: {
      path: string;
      agentId: string;
      serviceSlug: string;
      ownerAddress: string;
      body: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const ownerKey = assertPrivateKey(this.ownerPrivateKey, "ownerPrivateKey");
    const ownerAddress = normalizeAddressLower(input.ownerAddress);
    const authPayload = createMerchantGatewayAuthPayload({
      action,
      agentId: input.agentId,
      ownerAddress,
      actorAddress: ownerAddress,
      serviceSlug: input.serviceSlug,
    });
    const account = privateKeyToAccount(ownerKey);
    const authSignature = await account.signMessage({
      message: buildMerchantGatewayAuthMessage(authPayload),
    });

    const endpoint = `${this.merchantBaseUrl}${input.path}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        agentId: input.agentId,
        ownerAddress,
        actorAddress: ownerAddress,
        serviceSlug: input.serviceSlug,
        authPayload,
        authSignature,
        ...input.body,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    if (!response.ok) {
      const message = this.extractApiErrorMessage(payload, `Request failed for ${action}.`);
      throw new Error(`[activate:${action}] ${message}`);
    }
    return payload;
  }

  private extractApiErrorMessage(payload: unknown, fallback: string): string {
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const maybeError = (payload as { error?: unknown }).error;
      if (typeof maybeError === "string" && maybeError.trim().length > 0) {
        return maybeError.trim();
      }
    }
    return fallback;
  }
}

export default GhostAgent;
