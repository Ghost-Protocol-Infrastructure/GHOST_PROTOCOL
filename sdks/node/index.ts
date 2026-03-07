import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

export * from "./fulfillment";

export type GhostAgentConfig = {
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

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "connect";
const DEFAULT_CREDIT_COST = 1;
const DEFAULT_AUTH_MODE: "ghost-eip712" | "x402" = "ghost-eip712";
const DEFAULT_X402_SCHEME = "ghost-eip712-credit-v1";

const ACCESS_TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

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

export class GhostAgent {
  private apiKey: string | null = null;
  private readonly baseUrl: string;
  private readonly privateKey: `0x${string}` | null;
  private readonly chainId: number;
  private readonly serviceSlug: string;
  private readonly creditCost: number;
  private readonly authMode: "ghost-eip712" | "x402";
  private readonly x402Scheme: string;

  constructor(config: GhostAgentConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.privateKey = config.privateKey ?? null;
    this.chainId = config.chainId ?? DEFAULT_CHAIN_ID;
    this.serviceSlug = (config.serviceSlug ?? DEFAULT_SERVICE_SLUG).trim() || DEFAULT_SERVICE_SLUG;
    this.creditCost = Number.isFinite(config.creditCost) && (config.creditCost ?? 0) > 0
      ? Math.trunc(config.creditCost as number)
      : DEFAULT_CREDIT_COST;
    this.authMode = config.authMode ?? DEFAULT_AUTH_MODE;
    this.x402Scheme = config.x402Scheme?.trim() || DEFAULT_X402_SCHEME;
  }

  async connect(apiKey: string): Promise<ConnectResult> {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      throw new Error("connect(apiKey) requires a non-empty API key.");
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
    const headers: Record<string, string> = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    };
    if (this.authMode === "x402") {
      headers["payment-signature"] = encodeBase64Json({
        x402Version: 2,
        scheme: this.x402Scheme,
        network: `eip155:${this.chainId}`,
        payload: headerPayload,
        signature,
      });
    } else {
      headers["x-ghost-sig"] = signature;
      headers["x-ghost-payload"] = JSON.stringify(headerPayload);
      headers["x-ghost-credit-cost"] = String(this.creditCost);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
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

  get isConnected(): boolean {
    return this.apiKey !== null;
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/gate`;
  }
}

export default GhostAgent;
