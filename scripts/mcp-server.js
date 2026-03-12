#!/usr/bin/env node

const SERVER_NAME = "ghost-protocol-readonly-mcp";
const SERVER_VERSION = "0.3.0";
const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LIST_LIMIT = 250;

const baseUrl = (process.env.GHOST_MCP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const timeoutMs = parsePositiveInt(process.env.GHOST_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

let buffer = Buffer.alloc(0);

function parsePositiveInt(raw, fallback) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, payload]));
}

function writeResult(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeError(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function parseHeaders(rawHeaders) {
  const headers = new Map();
  const lines = rawHeaders.split("\r\n");
  for (const line of lines) {
    if (!line) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers.set(key, value);
  }
  return headers;
}

function parseIncomingBuffer() {
  while (true) {
    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex < 0) return;

    const rawHeaders = buffer.slice(0, separatorIndex).toString("utf8");
    const headers = parseHeaders(rawHeaders);
    const contentLengthRaw = headers.get("content-length");
    const contentLength = Number.parseInt(contentLengthRaw || "", 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      buffer = Buffer.alloc(0);
      return;
    }

    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) return;

    const messageBody = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    try {
      const message = JSON.parse(messageBody);
      void handleMessage(message);
    } catch {
      // Ignore malformed payloads to keep the server process alive.
    }
  }
}

function toToolResponse(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parsePositiveAtomicAmount(value) {
  const normalized = normalizeString(value);
  if (!/^\d+$/.test(normalized)) return "";
  if (normalized === "0") return "";
  return normalized;
}

async function fetchJson(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = normalizeString(init.method || "GET") || "GET";
    const inputHeaders = init.headers && typeof init.headers === "object" ? init.headers : {};
    const headers = {
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

    let payload = null;
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
}

async function toolListAgents(argumentsObject = {}) {
  const query = normalizeString(argumentsObject.query);
  const limit = clampInteger(argumentsObject.limit, 20, 1, MAX_LIST_LIMIT);
  const page = clampInteger(argumentsObject.page, 1, 1, 10_000);
  const params = new URLSearchParams({
    limit: String(limit),
    page: String(page),
  });
  if (query) params.set("q", query);

  const payload = await fetchJson(`/api/agents?${params.toString()}`);
  const agents = Array.isArray(payload.agents) ? payload.agents : [];

  const summary = {
    source: `${baseUrl}/api/agents?${params.toString()}`,
    page: payload.page ?? page,
    limit: payload.limit ?? limit,
    filteredTotal: payload.filteredTotal ?? agents.length,
    totalAgents: payload.totalAgents ?? agents.length,
    activatedAgents: payload.activatedAgents ?? 0,
    agents: agents.map((agent) => ({
      rank: agent.rank ?? null,
      agentId: agent.agentId ?? null,
      name: agent.name ?? null,
      owner: agent.owner ?? agent.creator ?? null,
      gatewayReadinessStatus: agent.gatewayReadinessStatus ?? "UNCONFIGURED",
      rankScore: agent.rankScore ?? null,
      txCount: agent.txCount ?? null,
    })),
  };

  return toToolResponse(summary);
}

async function toolGetAgentDetails(argumentsObject = {}) {
  const agentId = normalizeString(argumentsObject.agent_id);
  if (!agentId) {
    throw new Error("agent_id is required.");
  }

  const params = new URLSearchParams({
    q: agentId,
    limit: "100",
    page: "1",
  });
  const payload = await fetchJson(`/api/agents?${params.toString()}`);
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const normalizedAgentId = agentId.toLowerCase();

  const match =
    agents.find((agent) => String(agent.agentId || "").toLowerCase() === normalizedAgentId) ??
    agents.find((agent) => String(agent.address || "").toLowerCase() === normalizedAgentId) ??
    agents[0];

  if (!match) {
    throw new Error(`No agent found for '${agentId}'.`);
  }

  const details = {
    source: `${baseUrl}/api/agents?${params.toString()}`,
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
  };

  return toToolResponse(details);
}

async function toolGetPaymentRequirements(argumentsObject = {}) {
  const serviceSlug = normalizeString(argumentsObject.service_slug);
  if (!serviceSlug) {
    throw new Error("service_slug is required.");
  }

  const params = new URLSearchParams({ service: serviceSlug });
  const payload = await fetchJson(`/api/pricing?${params.toString()}`);

  const requirements = {
    source: `${baseUrl}/api/pricing?${params.toString()}`,
    serviceSlug,
    gateEndpoint: `${baseUrl}/api/gate/${encodeURIComponent(serviceSlug)}`,
    preferredChainId: payload.preferredChainId ?? null,
    creditPriceWei: payload.creditPriceWei ?? null,
    requestCostCredits: payload.service?.cost ?? payload.gate?.defaultRequestCreditCost ?? null,
    requestCostSource: payload.service?.source ?? "default",
    x402CompatibilityEnabled: payload.gate?.x402CompatibilityEnabled ?? false,
    x402Scheme: payload.gate?.x402Scheme ?? "ghost-eip712-credit-v1",
  };

  return toToolResponse(requirements);
}

async function toolGetWireQuote(argumentsObject = {}) {
  const providerAddress = normalizeString(argumentsObject.provider_address);
  const evaluatorAddress = normalizeString(argumentsObject.evaluator_address);
  const principalAmount = parsePositiveAtomicAmount(argumentsObject.principal_amount);
  const chainId = clampInteger(argumentsObject.chain_id, 8453, 1, 10_000_000);
  const settlementAsset = normalizeString(argumentsObject.settlement_asset) || "USDC";
  const clientAddress = normalizeString(argumentsObject.client_address);

  if (!providerAddress || !evaluatorAddress || !principalAmount) {
    throw new Error("provider_address, evaluator_address, and positive principal_amount are required.");
  }

  const payload = await fetchJson("/api/wire/quote", {
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
  });

  return toToolResponse({
    source: `${baseUrl}/api/wire/quote`,
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
}

async function toolGetWireJobStatus(argumentsObject = {}) {
  const jobId = normalizeString(argumentsObject.job_id);
  if (!jobId) {
    throw new Error("job_id is required.");
  }

  const encodedJobId = encodeURIComponent(jobId);
  const payload = await fetchJson(`/api/wire/jobs/${encodedJobId}`);

  return toToolResponse({
    source: `${baseUrl}/api/wire/jobs/${encodedJobId}`,
    jobId,
    status: payload,
  });
}

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

async function handleToolCall(params) {
  const toolName = normalizeString(params?.name);
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};

  if (toolName === "list_agents") return toolListAgents(args);
  if (toolName === "get_agent_details") return toolGetAgentDetails(args);
  if (toolName === "get_payment_requirements") return toolGetPaymentRequirements(args);
  if (toolName === "get_wire_quote") return toolGetWireQuote(args);
  if (toolName === "get_wire_job_status") return toolGetWireJobStatus(args);
  throw new Error(`Unsupported tool '${toolName}'.`);
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (!method || typeof method !== "string") return;

  try {
    if (method === "initialize") {
      writeResult(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      writeResult(id, {
        tools: TOOL_DEFINITIONS,
      });
      return;
    }

    if (method === "tools/call") {
      const result = await handleToolCall(params || {});
      writeResult(id, result);
      return;
    }

    writeError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown MCP server error.";
    writeError(id, -32000, messageText);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  parseIncomingBuffer();
});

process.stdin.on("error", () => {
  process.exitCode = 1;
});
