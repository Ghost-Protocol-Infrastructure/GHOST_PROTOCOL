import { randomUUID } from "node:crypto";
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
  authMode?: "ghost-eip712" | "x402";
  x402Scheme?: string;
};

export type ConnectResult = {
  connected: boolean;
  apiKeyPrefix: string;
  endpoint: string;
  status: number;
  payload: unknown;
  x402?: {
    paymentRequired: unknown | null;
    paymentResponse: unknown | null;
  };
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

type MerchantGatewayAuthAction = "config" | "verify" | "delegated_signer_register";

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

export type WireQuoteResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  quoteId: string | null;
  expiresAt: string | null;
};

export type WireJobCreateInput = {
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
  execSecret?: string | null;
};

export type WireJobCreateResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  jobId: string | null;
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
  fundTxHash: string | null;
  terminalTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  pricing: {
    principal: WirePricingAmount;
    protocolFee: WirePricingAmount;
    networkReserve: WirePricingAmount;
  };
  operator: {
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
    mode: "merchant_locator" | "none";
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
const DEFAULT_AUTH_MODE: "ghost-eip712" | "x402" = "ghost-eip712";
const DEFAULT_X402_SCHEME = "ghost-eip712-credit-v1";
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

const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const decodeBase64Json = (value: string | null): unknown | null => {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
};

const deriveAgentId = (serviceSlug: string | null): string | null => {
  if (!serviceSlug) return null;
  const match = /^agent-(.+)$/i.exec(serviceSlug);
  return match?.[1] ?? null;
};

const resolveWireExecSecret = (explicitSecret?: string | null): string | null =>
  normalizeOptionalString(explicitSecret) ?? normalizeOptionalString(process.env.GHOSTWIRE_EXEC_SECRET);

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

const assertPrivateKey = (value: `0x${string}` | null | undefined, name: string): `0x${string}` => {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return value;
};

const normalizeAddressLower = (value: string): string => value.trim().toLowerCase();

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
  private readonly authMode: "ghost-eip712" | "x402";
  private readonly x402Scheme: string;

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
    this.authMode = config.authMode ?? DEFAULT_AUTH_MODE;
    this.x402Scheme = normalizeOptionalString(config.x402Scheme) ?? DEFAULT_X402_SCHEME;
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
    };
    if (this.authMode === "x402") {
      gateHeaders["payment-signature"] = encodeBase64Json({
        x402Version: 2,
        scheme: this.x402Scheme,
        network: `eip155:${this.chainId}`,
        payload: headerPayload,
        signature,
      });
    } else {
      gateHeaders["x-ghost-sig"] = signature;
      gateHeaders["x-ghost-payload"] = JSON.stringify(headerPayload);
      gateHeaders["x-ghost-credit-cost"] = String(this.creditCost);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: gateHeaders,
      cache: "no-store",
    });

    const responsePayload = await parsePayload(response);
    const paymentRequired = decodeBase64Json(response.headers.get("payment-required"));
    const paymentResponse = decodeBase64Json(response.headers.get("payment-response"));
    if (response.ok) {
      this.apiKey = normalizedApiKey;
    }

    return {
      connected: response.ok,
      apiKeyPrefix: getApiKeyPrefix(normalizedApiKey),
      endpoint,
      status: response.status,
      payload: responsePayload,
      ...(this.authMode === "x402" || paymentRequired || paymentResponse
        ? {
            x402: {
              paymentRequired,
              paymentResponse,
            },
          }
        : {}),
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
    client?: `0x${string}` | string | null;
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
        ? (payload as { quoteId?: unknown; expiresAt?: unknown })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      quoteId: typeof record?.quoteId === "string" ? record.quoteId : null,
      expiresAt: typeof record?.expiresAt === "string" ? record.expiresAt : null,
    };
  }

  async createWireJob(input: WireJobCreateInput): Promise<WireJobCreateResult> {
    const execSecret = resolveWireExecSecret(input.execSecret);
    if (!execSecret) {
      throw new Error("createWireJob requires execSecret or GHOSTWIRE_EXEC_SECRET.");
    }

    const endpoint = `${this.baseUrl}/api/wire/jobs`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        authorization: `Bearer ${execSecret}`,
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
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null && "jobId" in payload
        ? (payload as { jobId?: unknown })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      jobId: typeof record?.jobId === "string" ? record.jobId : null,
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
    this.ownerAddress = this.ownerPrivateKey ? privateKeyToAccount(this.ownerPrivateKey).address.toLowerCase() : null;
    this.delegatedSignerAddress = config.delegatedPrivateKey
      ? privateKeyToAccount(assertPrivateKey(config.delegatedPrivateKey, "delegatedPrivateKey")).address.toLowerCase()
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
