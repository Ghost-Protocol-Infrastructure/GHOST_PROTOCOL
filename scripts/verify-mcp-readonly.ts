type RpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

const DEFAULT_BASE_URL = "https://www.ghostprotocol.cc";
const DEFAULT_SERVICE_SLUG = "agent-18755";

const baseUrl = (process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const serviceSlug = (process.env.MCP_TEST_SERVICE_SLUG || DEFAULT_SERVICE_SLUG).trim();
const timeoutMs = Number.parseInt(process.env.MCP_VERIFY_TIMEOUT_MS || "15000", 10);

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const normalizeString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const timedFetch = async (input: string, init?: RequestInit): Promise<{ response: Response; elapsedMs: number }> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return {
      response,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const expectJson = async <T>(response: Response, context: string): Promise<T> => {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${context}: expected JSON response but received non-JSON payload`);
  }
};

const equivalentGhostHosts = (url: string): string[] => {
  const normalized = url.replace(/\/+$/, "");
  if (normalized.startsWith("https://www.ghostprotocol.cc")) {
    return [normalized, normalized.replace("https://www.ghostprotocol.cc", "https://ghostprotocol.cc")];
  }
  if (normalized.startsWith("https://ghostprotocol.cc")) {
    return [normalized, normalized.replace("https://ghostprotocol.cc", "https://www.ghostprotocol.cc")];
  }
  return [normalized];
};

const rpcCall = async (id: number, method: string, params?: Record<string, unknown>): Promise<RpcResponse> => {
  const { response, elapsedMs } = await timedFetch(`${baseUrl}/api/mcp/read-only`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    }),
  });

  assert(response.status === 200, `MCP RPC ${method} failed with HTTP ${response.status}`);
  const payload = await expectJson<RpcResponse>(response, `MCP RPC ${method}`);
  assert(!payload.error, `MCP RPC ${method} returned error: ${JSON.stringify(payload.error)}`);
  console.log(`[ok] rpc ${method} (${elapsedMs}ms)`);
  return payload;
};

const run = async (): Promise<void> => {
  console.log(`Verifying MCP endpoint at ${baseUrl}`);

  const metadataResult = await timedFetch(`${baseUrl}/api/mcp/read-only`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  assert(metadataResult.response.status === 200, `GET /api/mcp/read-only returned HTTP ${metadataResult.response.status}`);
  const metadata = await expectJson<{
    ok?: boolean;
    endpoint?: string;
    tools?: Array<{ name?: string }>;
    transport?: string;
  }>(metadataResult.response, "GET /api/mcp/read-only");
  assert(metadata.ok === true, "MCP metadata payload missing ok=true");
  assert(metadata.transport === "jsonrpc-http", "MCP metadata transport must be jsonrpc-http");
  assert(Array.isArray(metadata.tools), "MCP metadata missing tools array");
  const metadataToolNames = new Set((metadata.tools ?? []).map((tool) => tool?.name).filter(Boolean));
  assert(metadataToolNames.has("list_agents"), "MCP metadata missing list_agents tool");
  assert(metadataToolNames.has("get_agent_details"), "MCP metadata missing get_agent_details tool");
  assert(metadataToolNames.has("get_payment_requirements"), "MCP metadata missing get_payment_requirements tool");
  assert(metadataToolNames.has("get_wire_quote"), "MCP metadata missing get_wire_quote tool");
  assert(metadataToolNames.has("get_wire_job_status"), "MCP metadata missing get_wire_job_status tool");
  console.log(`[ok] metadata (${metadataResult.elapsedMs}ms)`);

  const manifestResult = await timedFetch(`${baseUrl}/.well-known/mcp.json`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  assert(manifestResult.response.status === 200, `GET /.well-known/mcp.json returned HTTP ${manifestResult.response.status}`);
  const manifest = await expectJson<{
    transport?: { url?: string };
    tools?: Array<{ name?: string }>;
  }>(manifestResult.response, "GET /.well-known/mcp.json");
  const expectedUrl = `${baseUrl}/api/mcp/read-only`;
  const manifestUrl = normalizeString(manifest.transport?.url).replace(/\/+$/, "");
  const acceptableTransportUrls = new Set(equivalentGhostHosts(expectedUrl));
  assert(
    acceptableTransportUrls.has(manifestUrl),
    `MCP manifest transport URL mismatch: expected one of ${Array.from(acceptableTransportUrls).join(", ")}`,
  );
  const manifestToolNames = new Set((manifest.tools ?? []).map((tool) => tool?.name).filter(Boolean));
  assert(manifestToolNames.has("list_agents"), "MCP manifest missing list_agents tool");
  assert(manifestToolNames.has("get_agent_details"), "MCP manifest missing get_agent_details tool");
  assert(manifestToolNames.has("get_payment_requirements"), "MCP manifest missing get_payment_requirements tool");
  assert(manifestToolNames.has("get_wire_quote"), "MCP manifest missing get_wire_quote tool");
  assert(manifestToolNames.has("get_wire_job_status"), "MCP manifest missing get_wire_job_status tool");
  console.log(`[ok] manifest (${manifestResult.elapsedMs}ms)`);

  const initializeResponse = await rpcCall(1, "initialize", { protocolVersion: "2024-11-05" });
  const initializeResult = (initializeResponse.result || {}) as {
    serverInfo?: { name?: string; version?: string };
  };
  assert(initializeResult.serverInfo?.name === "ghost-protocol-readonly-mcp", "initialize returned unexpected server name");

  const toolsListResponse = await rpcCall(2, "tools/list");
  const toolsListResult = (toolsListResponse.result || {}) as {
    tools?: Array<{ name?: string }>;
  };
  const toolsListNames = new Set((toolsListResult.tools ?? []).map((tool) => tool?.name).filter(Boolean));
  assert(toolsListNames.has("list_agents"), "tools/list missing list_agents");
  assert(toolsListNames.has("get_agent_details"), "tools/list missing get_agent_details");
  assert(toolsListNames.has("get_payment_requirements"), "tools/list missing get_payment_requirements");
  assert(toolsListNames.has("get_wire_quote"), "tools/list missing get_wire_quote");
  assert(toolsListNames.has("get_wire_job_status"), "tools/list missing get_wire_job_status");

  const listAgentsResponse = await rpcCall(3, "tools/call", {
    name: "list_agents",
    arguments: {
      limit: 1,
      page: 1,
    },
  });
  const listAgentsResult = (listAgentsResponse.result || {}) as { structuredContent?: { agents?: unknown[] } };
  assert(Array.isArray(listAgentsResult.structuredContent?.agents), "list_agents response missing agents array");

  await rpcCall(4, "tools/call", {
    name: "get_payment_requirements",
    arguments: {
      service_slug: serviceSlug,
    },
  });

  console.log("MCP verification completed successfully.");
};

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MCP verification failed: ${message}`);
  process.exit(1);
});
