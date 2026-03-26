import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "x402/types";
import {
  GhostMerchant,
  createGhostHttpMonetizationKit,
  createGhostMcpProxy,
  defineGhostConfig,
  type X402SettlementReporterConfig,
} from "../packages/sdk/src/index";
import {
  buildFulfillmentTicketEnvelope,
  buildFulfillmentTicketHeaders,
  buildFulfillmentTicketTypedData,
  normalizeFulfillmentTicketMessage,
} from "../packages/sdk/src/fulfillment-eip712";
import { hashCanonicalFulfillmentBodyJson, hashCanonicalFulfillmentQuery } from "../packages/sdk/src/fulfillment-hash";

const OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" as const;
const DELEGATED_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca85829c77ff5f37b1dbfa6cb3f8df6ed0f0d31e3d8c8b" as const;
const PROTOCOL_PRIVATE_KEY = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f6ed0b48c5d6f32d4f" as const;
const OWNER_ADDRESS = privateKeyToAccount(OWNER_PRIVATE_KEY).address.toLowerCase();
const PROTOCOL_ADDRESS = privateKeyToAccount(PROTOCOL_PRIVATE_KEY).address.toLowerCase();
const BASE_URL = "https://ghostprotocol.cc";
const UPSTREAM_URL = "https://upstream.mcp.test/rpc";
const BASE_USDC = "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createJsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const parseJsonBody = (body: BodyInit | null | undefined): Record<string, unknown> => {
  if (typeof body !== "string") throw new Error("Expected JSON string body.");
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body.");
  }
  return parsed as Record<string, unknown>;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for asynchronous MCP proxy work.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const paymentRequirements: PaymentRequirements[] = [
  {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "1000000",
    resource: "/mcp",
    description: "Paid MCP tool execution",
    mimeType: "application/json",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 300,
    asset: BASE_USDC,
    extra: {
      name: "USD Coin",
      version: "2",
    },
  },
];

const paymentPayload: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base",
  payload: {
    signature: "0xsigned",
    authorization: {
      from: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
      to: "0x1111111111111111111111111111111111111111",
      value: "1000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x1234",
    },
  },
};

const verifyResponse: VerifyResponse = {
  isValid: true,
  payer: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
};

const settleResponse: SettleResponse = {
  success: true,
  transaction: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  network: "base",
  payer: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
};

const createMerchant = () =>
  new GhostMerchant({
    baseUrl: BASE_URL,
    serviceSlug: "agent-123",
    ownerPrivateKey: OWNER_PRIVATE_KEY,
    delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    protocolSignerAddresses: [PROTOCOL_ADDRESS],
  });

const createFulfillmentHeaders = async (input: {
  serviceSlug: string;
  path: string;
  method?: string;
  body?: unknown;
  cost?: number;
}) => {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const message = normalizeFulfillmentTicketMessage({
    ticketId: `0x${"cd".repeat(32)}`,
    consumer: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
    merchantOwner: OWNER_ADDRESS,
    gatewayConfigIdHash: `0x${"11".repeat(32)}`,
    serviceSlug: input.serviceSlug,
    method: input.method ?? "POST",
    path: input.path,
    queryHash: hashCanonicalFulfillmentQuery(""),
    bodyHash: hashCanonicalFulfillmentBodyJson(input.body ?? {}),
    cost: input.cost ?? 5,
    issuedAt,
    expiresAt: issuedAt + 300n,
  });
  const signature = await privateKeyToAccount(PROTOCOL_PRIVATE_KEY).signTypedData(buildFulfillmentTicketTypedData(message));
  return buildFulfillmentTicketHeaders({
    ticketId: message.ticketId,
    ticket: buildFulfillmentTicketEnvelope(message, signature),
    clientRequestId: "fx-mcp-123",
  });
};

const setupMcpFetchMock = () => {
  const settlementBodies: Record<string, unknown>[] = [];
  const captureBodies: Record<string, unknown>[] = [];
  const upstreamBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    if (method === "GET" && /\/api\/agent-gateway\/config\?agentId=123$/.test(url)) {
      return createJsonResponse(200, {
        configured: true,
        config: {
          ownerAddress: OWNER_ADDRESS,
          readinessStatus: "LIVE",
        },
      });
    }

    if (method === "POST" && /\/api\/telemetry\/x402\/settlements$/.test(url)) {
      settlementBodies.push(parseJsonBody(init?.body));
      return createJsonResponse(200, {
        ok: true,
        countedForRank: true,
        relatedParty: false,
        duplicate: false,
      });
    }

    if (method === "POST" && /\/api\/fulfillment\/capture$/.test(url)) {
      captureBodies.push(parseJsonBody(init?.body));
      return createJsonResponse(200, {
        ok: true,
        status: "CAPTURED",
      });
    }

    if (method === "POST" && url === UPSTREAM_URL) {
      const body = parseJsonBody(init?.body);
      upstreamBodies.push(body);
      const rpcMethod = String(body.method ?? "");
      if (rpcMethod === "initialize") {
        return createJsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "upstream-mcp",
              version: "0.1.0",
            },
          },
        });
      }
      if (rpcMethod === "tools/list") {
        return createJsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            tools: [
              {
                name: "ask_wallet",
                description: "Ask about a wallet.",
                inputSchema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                  },
                },
              },
              {
                name: "managed_wallet",
                description: "Managed wallet tool.",
                inputSchema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                  },
                },
              },
            ],
          },
        });
      }
      if (rpcMethod === "tools/call") {
        return createJsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: `ok:${String((body.params as Record<string, unknown> | undefined)?.name ?? "")}`,
              },
            ],
            structuredContent: {
              ok: true,
            },
          },
        });
      }
      return createJsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          ok: true,
        },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  return { settlementBodies, captureBodies, upstreamBodies };
};

const createProxy = (input?: {
  reporter?: ReturnType<GhostMerchant["createX402SettlementReporter"]>;
  reporterConfig?: Omit<X402SettlementReporterConfig, "runtime">;
  x402ReportingRuntime?: X402SettlementReporterConfig["runtime"];
}) => {
  const merchant = createMerchant();
  const kit = createGhostHttpMonetizationKit({
    merchant,
    config: defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        mcp_x402: {
          method: "POST",
          path: "/mcp",
          rail: "x402",
          x402: {
            paymentRequirements,
            reportingRuntime: input?.x402ReportingRuntime,
          },
        },
        mcp_express: {
          method: "POST",
          path: "/mcp",
          rail: "express",
          express: {
            creditCost: 5,
          },
        },
      },
    }),
    x402: {
      x402Client: {} as never,
      reporter: input?.reporter,
      reporterConfig: input?.reporterConfig,
      decodePaymentHeader: () => paymentPayload,
      verifyPayment: async () => verifyResponse,
      settlePayment: async () => settleResponse,
    },
  });

  return {
    merchant,
    proxy: createGhostMcpProxy({
      kit,
      config: {
        upstream: {
          url: UPSTREAM_URL,
        },
        tools: {
          ask_wallet: {
            route: "mcp_x402",
            descriptionFallbackText: true,
          },
          managed_wallet: {
            route: "mcp_express",
          },
        },
      },
    }),
  };
};

describe("Task 9 MCP payment-aware proxy", () => {
  it("keeps tools/list free and augments tools with structured Ghost pricing metadata", async () => {
    const { upstreamBodies } = setupMcpFetchMock();
    const { proxy } = createProxy();

    const response = await proxy.handleRequest(
      new Request("https://merchant.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );

    const payload = (await response.json()) as {
      result?: {
        tools?: Array<Record<string, unknown>>;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "tools/list");
    const askTool = payload.result?.tools?.find((tool) => tool.name === "ask_wallet");
    const managedTool = payload.result?.tools?.find((tool) => tool.name === "managed_wallet");
    assert.ok(askTool);
    assert.ok(managedTool);
    assert.equal(
      ((askTool?.annotations as Record<string, unknown>)?.ghost as Record<string, unknown>)?.pricing != null,
      true,
    );
    assert.match(String(askTool?.description ?? ""), /Ghost pricing:/i);
    assert.equal(
      ((((managedTool?.annotations as Record<string, unknown>)?.ghost as Record<string, unknown>)?.pricing as Record<string, unknown>)?.rail),
      "express",
    );
  });

  it("rejects JSON-RPC batch requests instead of forwarding them upstream", async () => {
    const { upstreamBodies } = setupMcpFetchMock();
    const { proxy } = createProxy();

    const response = await proxy.handleRequest(
      new Request("https://merchant.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 99,
            method: "tools/call",
            params: {
              name: "ask_wallet",
              arguments: {
                prompt: "hello",
              },
            },
          },
        ]),
      }),
    );

    assert.equal(response.status, 400);
    assert.equal(upstreamBodies.length, 0);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported by the Ghost MCP proxy.",
      },
    });
  });

  it("passes initialize through to the upstream MCP server unchanged", async () => {
    const { upstreamBodies } = setupMcpFetchMock();
    const { proxy } = createProxy();

    const response = await proxy.handleRequest(
      new Request("https://merchant.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init-1",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
          },
        }),
      }),
    );

    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "initialize");
    assert.deepEqual(payload, {
      jsonrpc: "2.0",
      id: "init-1",
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "upstream-mcp",
          version: "0.1.0",
        },
      },
    });
  });

  it("gates tools/call behind x402 and forwards the upstream result after settlement reporting", async () => {
    const { settlementBodies, upstreamBodies } = setupMcpFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "next_node",
      retryDelaysMs: [0],
    });
    const { proxy } = createProxy({ reporter });

    const response = await proxy.handleRequest(
      new Request("https://merchant.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payment": "paid-header",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ask_wallet",
            arguments: {
              prompt: "hello",
            },
          },
        }),
      }),
    );

    await reporter.flush();

    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "tools/call");
    assert.equal(
      ((upstreamBodies[0]?.params as Record<string, unknown> | undefined)?.name),
      "ask_wallet",
    );
    assert.equal(settlementBodies.length, 1);
    assert.equal(settlementBodies[0]?.paymentReference, settleResponse.transaction);
    assert.deepEqual(payload, {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          {
            type: "text",
            text: "ok:ask_wallet",
          },
        ],
        structuredContent: {
          ok: true,
        },
      },
    });
  });

  it("gates tools/call behind Express fulfillment tickets and captures the upstream result", async () => {
    const { captureBodies, upstreamBodies } = setupMcpFetchMock();
    const { proxy } = createProxy();
    const headers = await createFulfillmentHeaders({
      serviceSlug: "agent-123",
      path: "/mcp",
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "managed_wallet",
          arguments: {
            prompt: "hello",
          },
        },
      },
      cost: 5,
    });

    const response = await proxy.handleRequest(
      new Request("https://merchant.test/mcp", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "managed_wallet",
            arguments: {
              prompt: "hello",
            },
          },
        }),
      }),
    );

    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(
      ((upstreamBodies[0]?.params as Record<string, unknown> | undefined)?.name),
      "managed_wallet",
    );
    assert.equal(captureBodies.length, 1);
    assert.equal(captureBodies[0]?.ticketId, `0x${"cd".repeat(32)}`);
    assert.equal(response.headers.has("x-ghost-fulfillment-delivery-proof-id"), true);
    assert.deepEqual(payload, {
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          {
            type: "text",
            text: "ok:managed_wallet",
          },
        ],
        structuredContent: {
          ok: true,
        },
      },
    });
  });

  it("routes Hono tool calls through the framework-specific x402 binding", async () => {
    const { settlementBodies, upstreamBodies } = setupMcpFetchMock();
    const events: Array<{ name?: string; runtime?: string }> = [];
    const { proxy } = createProxy({
      reporterConfig: {
        retryDelaysMs: [0],
        onEvent: (event) => {
          events.push({
            name: event.name,
            runtime: event.runtime,
          });
        },
      },
    });

    const handler = proxy.withHono();
    const response = await handler({
      req: {
        raw: new Request("https://merchant.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-payment": "paid-header",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "hono-1",
            method: "tools/call",
            params: {
              name: "ask_wallet",
              arguments: {
                prompt: "hello",
              },
            },
          }),
        }),
      },
    });

    await waitFor(() => events.some((event) => event.name === "report_accepted"));

    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "tools/call");
    assert.equal(settlementBodies.length, 1);
    assert.equal(events.find((event) => event.name === "payment_verified")?.runtime, "node_server");
  });

  it("routes Express tool calls through the framework-specific x402 binding", async () => {
    const { settlementBodies, upstreamBodies } = setupMcpFetchMock();
    const events: Array<{ name?: string; runtime?: string }> = [];
    const { proxy } = createProxy({
      reporterConfig: {
        retryDelaysMs: [0],
        onEvent: (event) => {
          events.push({
            name: event.name,
            runtime: event.runtime,
          });
        },
      },
    });

    const handler = proxy.withExpress();
    const responseState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: "",
    };

    await handler(
      {
        method: "POST",
        originalUrl: "/mcp",
        protocol: "https",
        headers: {
          host: "merchant.test",
          "content-type": "application/json",
          "x-payment": "paid-header",
        },
        body: {
          jsonrpc: "2.0",
          id: "express-1",
          method: "tools/call",
          params: {
            name: "ask_wallet",
            arguments: {
              prompt: "hello",
            },
          },
        },
      },
      {
        status(code: number) {
          responseState.statusCode = code;
          return this;
        },
        setHeader(name: string, value: string) {
          responseState.headers.set(name.toLowerCase(), value);
        },
        send(body: string | Buffer) {
          responseState.body = typeof body === "string" ? body : body.toString("utf8");
          return this;
        },
        end(body?: string | Buffer) {
          responseState.body = body == null ? "" : typeof body === "string" ? body : body.toString("utf8");
          return this;
        },
      },
    );

    await waitFor(() => events.some((event) => event.name === "report_accepted"));

    assert.equal(responseState.statusCode, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "tools/call");
    assert.equal(settlementBodies.length, 1);
    assert.equal(events.find((event) => event.name === "payment_verified")?.runtime, "node_server");
    assert.deepEqual(JSON.parse(responseState.body), {
      jsonrpc: "2.0",
      id: "express-1",
      result: {
        content: [
          {
            type: "text",
            text: "ok:ask_wallet",
          },
        ],
        structuredContent: {
          ok: true,
        },
      },
    });
  });

  it("routes Fastify tool calls through the framework-specific x402 binding", async () => {
    const { settlementBodies, upstreamBodies } = setupMcpFetchMock();
    const events: Array<{ name?: string; runtime?: string }> = [];
    const { proxy } = createProxy({
      reporterConfig: {
        retryDelaysMs: [0],
        onEvent: (event) => {
          events.push({
            name: event.name,
            runtime: event.runtime,
          });
        },
      },
    });
    const handler = proxy.withFastify();
    const replyState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: null as unknown,
    };

    await handler(
      {
        method: "POST",
        url: "/mcp",
        protocol: "https",
        headers: {
          host: "merchant.test",
          "content-type": "application/json",
          "x-payment": "paid-header",
        },
        body: {
          jsonrpc: "2.0",
          id: "fastify-1",
          method: "tools/call",
          params: {
            name: "ask_wallet",
            arguments: {
              prompt: "hello",
            },
          },
        },
      },
      {
        code(statusCode: number) {
          replyState.statusCode = statusCode;
          return this;
        },
        header(name: string, value: string) {
          replyState.headers.set(name.toLowerCase(), value);
          return this;
        },
        send(body: unknown) {
          replyState.body = body;
          return this;
        },
      },
    );

    await waitFor(() => events.some((event) => event.name === "report_accepted"));

    assert.equal(replyState.statusCode, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0]?.method, "tools/call");
    assert.equal(settlementBodies.length, 1);
    assert.deepEqual(replyState.body, {
      jsonrpc: "2.0",
      id: "fastify-1",
      result: {
        content: [
          {
            type: "text",
            text: "ok:ask_wallet",
          },
        ],
        structuredContent: {
          ok: true,
        },
      },
    });
  });
});
