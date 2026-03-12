import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const SERVER_NAME = "ghost-protocol-readonly-mcp";
const SERVER_VERSION = "0.3.0";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LIST_LIMIT = 250;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown> | null;
};

const TOOL_DEFINITIONS = [
  {
    name: "list_agents",
    description: "List GhostRank agents with optional search query and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: 20 },
        page: { type: "integer", minimum: 1, default: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_agent_details",
    description: "Fetch details for one agent by agent_id (or address).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID or agent address." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_payment_requirements",
    description: "Fetch authoritative payment requirements for a service slug.",
    inputSchema: {
      type: "object",
      properties: {
        service_slug: { type: "string", description: "Service slug such as agent-18755." },
      },
      required: ["service_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_wire_quote",
    description: "Create a GhostWire quote for a potential escrow job.",
    inputSchema: {
      type: "object",
      properties: {
        provider_address: { type: "string", description: "Provider wallet address." },
        evaluator_address: { type: "string", description: "Evaluator wallet address." },
        principal_amount: { type: "string", description: "USDC amount in atomic units (6 decimals)." },
        chain_id: { type: "integer", description: "Target chain id (8453 for Base mainnet)." },
        settlement_asset: { type: "string", description: "Settlement asset symbol. Default USDC." },
        client_address: { type: "string", description: "Optional client wallet address." },
      },
      required: ["provider_address", "evaluator_address", "principal_amount"],
      additionalProperties: false,
    },
  },
  {
    name: "get_wire_job_status",
    description: "Fetch current status for one GhostWire job by job_id.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "GhostWire job id (example: wj_...)." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
];

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const normalizeString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
};

const parsePositiveAtomicAmount = (value: unknown): string => {
  const normalized = normalizeString(value);
  if (!/^\d+$/.test(normalized)) return "";
  if (normalized === "0") return "";
  return normalized;
};

const noStoreJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });

const buildResult = (id: JsonRpcId, result: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  result,
});

const buildError = (id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  },
});

const toToolResponse = (value: unknown): Record<string, unknown> => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(value, null, 2),
    },
  ],
  structuredContent: value,
});

const resolveBaseUrl = (request: NextRequest): string =>
  (process.env.GHOST_MCP_BASE_URL?.trim() || request.nextUrl.origin).replace(/\/+$/, "");

const fetchJson = async (baseUrl: string, path: string, timeoutMs: number, init?: RequestInit): Promise<any> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = normalizeString(init?.method || "GET") || "GET";
    const inputHeaders = (init?.headers || {}) as Record<string, string>;
    const headers: Record<string, string> = {
      accept: "application/json",
      "cache-control": "no-store",
      ...inputHeaders,
    };

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      method,
      headers,
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = await response.text();
    }

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}): ${JSON.stringify(payload)}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
};

const toolListAgents = async (
  argumentsObject: Record<string, unknown>,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const query = normalizeString(argumentsObject.query);
  const limit = clampInteger(argumentsObject.limit, 20, 1, MAX_LIST_LIMIT);
  const page = clampInteger(argumentsObject.page, 1, 1, 10_000);
  const params = new URLSearchParams({
    limit: String(limit),
    page: String(page),
  });
  if (query) params.set("q", query);

  const payload = await fetchJson(context.baseUrl, `/api/agents?${params.toString()}`, context.timeoutMs);
  const agents = Array.isArray(payload.agents) ? payload.agents : [];

  return toToolResponse({
    source: `${context.baseUrl}/api/agents?${params.toString()}`,
    page: payload.page ?? page,
    limit: payload.limit ?? limit,
    filteredTotal: payload.filteredTotal ?? agents.length,
    totalAgents: payload.totalAgents ?? agents.length,
    activatedAgents: payload.activatedAgents ?? 0,
    agents: agents.map((agent: any) => ({
      rank: agent.rank ?? null,
      agentId: agent.agentId ?? null,
      name: agent.name ?? null,
      owner: agent.owner ?? agent.creator ?? null,
      gatewayReadinessStatus: agent.gatewayReadinessStatus ?? "UNCONFIGURED",
      rankScore: agent.rankScore ?? null,
      txCount: agent.txCount ?? null,
    })),
  });
};

const toolGetAgentDetails = async (
  argumentsObject: Record<string, unknown>,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const agentId = normalizeString(argumentsObject.agent_id);
  if (!agentId) {
    throw new Error("agent_id is required.");
  }

  const params = new URLSearchParams({
    q: agentId,
    limit: "100",
    page: "1",
  });
  const payload = await fetchJson(context.baseUrl, `/api/agents?${params.toString()}`, context.timeoutMs);
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const normalizedAgentId = agentId.toLowerCase();

  const match =
    agents.find((agent: any) => String(agent.agentId || "").toLowerCase() === normalizedAgentId) ??
    agents.find((agent: any) => String(agent.address || "").toLowerCase() === normalizedAgentId) ??
    agents[0];

  if (!match) {
    throw new Error(`No agent found for '${agentId}'.`);
  }

  return toToolResponse({
    source: `${context.baseUrl}/api/agents?${params.toString()}`,
    query: agentId,
    rank: match.rank ?? null,
    agentId: match.agentId ?? null,
    name: match.name ?? null,
    address: match.address ?? null,
    owner: match.owner ?? match.creator ?? null,
    status: match.status ?? null,
    tier: match.tier ?? null,
    txCount: match.txCount ?? null,
    reputation: match.reputation ?? null,
    rankScore: match.rankScore ?? null,
    gatewayReadinessStatus: match.gatewayReadinessStatus ?? "UNCONFIGURED",
    gatewayLastCanaryCheckedAt: match.gatewayLastCanaryCheckedAt ?? null,
    gatewayLastCanaryPassedAt: match.gatewayLastCanaryPassedAt ?? null,
  });
};

const toolGetPaymentRequirements = async (
  argumentsObject: Record<string, unknown>,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const serviceSlug = normalizeString(argumentsObject.service_slug);
  if (!serviceSlug) {
    throw new Error("service_slug is required.");
  }

  const params = new URLSearchParams({ service: serviceSlug });
  const payload = await fetchJson(context.baseUrl, `/api/pricing?${params.toString()}`, context.timeoutMs);

  return toToolResponse({
    source: `${context.baseUrl}/api/pricing?${params.toString()}`,
    serviceSlug,
    gateEndpoint: `${context.baseUrl}/api/gate/${encodeURIComponent(serviceSlug)}`,
    preferredChainId: payload.preferredChainId ?? null,
    creditPriceWei: payload.creditPriceWei ?? null,
    requestCostCredits: payload.service?.cost ?? payload.gate?.defaultRequestCreditCost ?? null,
    requestCostSource: payload.service?.source ?? "default",
    x402CompatibilityEnabled: payload.gate?.x402CompatibilityEnabled ?? false,
    x402Scheme: payload.gate?.x402Scheme ?? "ghost-eip712-credit-v1",
  });
};

const toolGetWireQuote = async (
  argumentsObject: Record<string, unknown>,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const providerAddress = normalizeString(argumentsObject.provider_address);
  const evaluatorAddress = normalizeString(argumentsObject.evaluator_address);
  const principalAmount = parsePositiveAtomicAmount(argumentsObject.principal_amount);
  const chainId = clampInteger(argumentsObject.chain_id, 8453, 1, 10_000_000);
  const settlementAsset = normalizeString(argumentsObject.settlement_asset) || "USDC";
  const clientAddress = normalizeString(argumentsObject.client_address);

  if (!providerAddress || !evaluatorAddress || !principalAmount) {
    throw new Error("provider_address, evaluator_address, and positive principal_amount are required.");
  }

  const payload = await fetchJson(
    context.baseUrl,
    "/api/wire/quote",
    context.timeoutMs,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: providerAddress,
        evaluator: evaluatorAddress,
        client: clientAddress || undefined,
        principalAmount,
        settlementAsset,
        chainId,
      }),
    },
  );

  return toToolResponse({
    source: `${context.baseUrl}/api/wire/quote`,
    request: {
      providerAddress,
      evaluatorAddress,
      clientAddress: clientAddress || null,
      principalAmount,
      settlementAsset,
      chainId,
    },
    quote: payload,
  });
};

const toolGetWireJobStatus = async (
  argumentsObject: Record<string, unknown>,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const jobId = normalizeString(argumentsObject.job_id);
  if (!jobId) {
    throw new Error("job_id is required.");
  }

  const payload = await fetchJson(context.baseUrl, `/api/wire/jobs/${encodeURIComponent(jobId)}`, context.timeoutMs);

  return toToolResponse({
    source: `${context.baseUrl}/api/wire/jobs/${encodeURIComponent(jobId)}`,
    jobId,
    status: payload,
  });
};

const handleToolCall = async (
  params: Record<string, unknown> | null | undefined,
  context: { baseUrl: string; timeoutMs: number },
): Promise<Record<string, unknown>> => {
  const toolName = normalizeString(params?.name);
  const args =
    params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  if (toolName === "list_agents") return toolListAgents(args, context);
  if (toolName === "get_agent_details") return toolGetAgentDetails(args, context);
  if (toolName === "get_payment_requirements") return toolGetPaymentRequirements(args, context);
  if (toolName === "get_wire_quote") return toolGetWireQuote(args, context);
  if (toolName === "get_wire_job_status") return toolGetWireJobStatus(args, context);
  throw new Error(`Unsupported tool '${toolName}'.`);
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const baseUrl = resolveBaseUrl(request);
  return noStoreJson({
    ok: true,
    apiVersion: 1,
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    transport: "jsonrpc-http",
    endpoint: `${request.nextUrl.origin}/api/mcp/read-only`,
    upstreamBaseUrl: baseUrl,
    tools: TOOL_DEFINITIONS,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return noStoreJson(buildError(null, -32700, "Parse error"));
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return noStoreJson(buildError(null, -32600, "Invalid Request"));
  }

  const id: JsonRpcId = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  const baseUrl = resolveBaseUrl(request);
  const timeoutMs = parsePositiveInt(process.env.GHOST_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const context = { baseUrl, timeoutMs };

  if (!method) {
    return noStoreJson(buildError(id, -32600, "Invalid Request: missing method"));
  }

  try {
    if (method === "initialize") {
      return noStoreJson(
        buildResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        }),
      );
    }

    if (method === "notifications/initialized") {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
        },
      });
    }

    if (method === "tools/list") {
      return noStoreJson(buildResult(id, { tools: TOOL_DEFINITIONS }));
    }

    if (method === "tools/call") {
      const result = await handleToolCall(message.params as Record<string, unknown> | null | undefined, context);
      return noStoreJson(buildResult(id, result));
    }

    return noStoreJson(buildError(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown MCP server error.";
    return noStoreJson(buildError(id, -32000, messageText));
  }
}
