export type GhostAgentConfig = {
  baseUrl?: string;
};

export type ConnectResult = {
  connected: true;
  apiKeyPrefix: string;
};

const DEFAULT_BASE_URL = "https://ghost-rank.vercel.app";

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const getApiKeyPrefix = (apiKey: string): string => {
  if (apiKey.length <= 8) return apiKey;
  return `${apiKey.slice(0, 8)}...`;
};

export class GhostAgent {
  private apiKey: string | null = null;
  private readonly baseUrl: string;

  constructor(config: GhostAgentConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  }

  connect(apiKey: string): ConnectResult {
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new Error("connect(apiKey) requires a non-empty API key.");
    }

    this.apiKey = normalized;
    return {
      connected: true,
      apiKeyPrefix: getApiKeyPrefix(normalized),
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
