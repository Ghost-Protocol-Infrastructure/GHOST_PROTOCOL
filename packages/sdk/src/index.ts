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
};

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "connect";
const DEFAULT_CREDIT_COST = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

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

const deriveAgentId = (serviceSlug: string | null): string | null => {
  if (!serviceSlug) return null;
  const match = /^agent-(.+)$/i.exec(serviceSlug);
  return match?.[1] ?? null;
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
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-ghost-sig": signature,
        "x-ghost-payload": JSON.stringify(headerPayload),
        "x-ghost-credit-cost": String(this.creditCost),
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
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

  constructor(config: GhostMerchantConfig) {
    super(config);
    const normalizedServiceSlug = normalizeOptionalString(config.serviceSlug);
    if (!normalizedServiceSlug) {
      throw new Error("GhostMerchant.serviceSlug is required.");
    }
    this.merchantServiceSlug = normalizedServiceSlug;
  }

  canaryPayload(): CanaryPayload {
    return buildCanaryPayload(this.merchantServiceSlug);
  }

  canaryHandler() {
    return createCanaryHandler(this.merchantServiceSlug);
  }
}

export default GhostAgent;
