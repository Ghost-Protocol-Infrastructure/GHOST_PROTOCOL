import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

export type GhostAgentConfig = {
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

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "connect";
const DEFAULT_CREDIT_COST = 1;

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

export class GhostAgent {
  private apiKey: string | null = null;
  private readonly baseUrl: string;
  private readonly privateKey: `0x${string}` | null;
  private readonly chainId: number;
  private readonly serviceSlug: string;
  private readonly creditCost: number;

  constructor(config: GhostAgentConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.privateKey = config.privateKey ?? null;
    this.chainId = config.chainId ?? DEFAULT_CHAIN_ID;
    this.serviceSlug = (config.serviceSlug ?? DEFAULT_SERVICE_SLUG).trim() || DEFAULT_SERVICE_SLUG;
    this.creditCost = Number.isFinite(config.creditCost) && (config.creditCost ?? 0) > 0
      ? Math.trunc(config.creditCost as number)
      : DEFAULT_CREDIT_COST;
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

    this.apiKey = normalizedApiKey;

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
        "x-ghost-api-key": normalizedApiKey,
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });

    const responsePayload = await parsePayload(response);

    return {
      connected: response.ok,
      apiKeyPrefix: getApiKeyPrefix(normalizedApiKey),
      endpoint,
      status: response.status,
      payload: responsePayload,
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
