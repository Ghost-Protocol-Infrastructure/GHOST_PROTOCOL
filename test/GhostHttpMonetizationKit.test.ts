import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "x402/types";
import {
  GhostMerchant,
  createGhostHttpMonetizationKit,
  defineGhostConfig,
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

const paymentRequirements: PaymentRequirements[] = [
  {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "1000000",
    resource: "/paid",
    description: "Protected endpoint",
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
  transaction: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  network: "base",
  payer: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
};

const setupMerchantFetchMock = () => {
  const settlementBodies: Record<string, unknown>[] = [];
  const captureBodies: Record<string, unknown>[] = [];

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

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  return { settlementBodies, captureBodies };
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
  query?: string;
  body?: unknown;
  cost?: number;
}) => {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const message = normalizeFulfillmentTicketMessage({
    ticketId: `0x${"ab".repeat(32)}`,
    consumer: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
    merchantOwner: OWNER_ADDRESS,
    gatewayConfigIdHash: `0x${"11".repeat(32)}`,
    serviceSlug: input.serviceSlug,
    method: input.method ?? "POST",
    path: input.path,
    queryHash: hashCanonicalFulfillmentQuery(input.query ?? ""),
    bodyHash: hashCanonicalFulfillmentBodyJson(input.body ?? {}),
    cost: input.cost ?? 5,
    issuedAt,
    expiresAt: issuedAt + 300n,
  });
  const signature = await privateKeyToAccount(PROTOCOL_PRIVATE_KEY).signTypedData(buildFulfillmentTicketTypedData(message));
  return buildFulfillmentTicketHeaders({
    ticketId: message.ticketId,
    ticket: buildFulfillmentTicketEnvelope(message, signature),
    clientRequestId: "fx-test-123",
  });
};

describe("Task 8 HTTP monetization kit", () => {
  it("wraps a config-driven x402 route through the existing Next.js x402 path", async () => {
    const { settlementBodies } = setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "next_node",
      retryDelaysMs: [0],
    });
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        paid: {
          method: "POST",
          path: "/paid",
          rail: "x402",
          x402: {
            paymentRequirements,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
      x402: {
        x402Client: {} as never,
        reporter,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
    });

    const resolvedRoute = kit.resolveRoute("paid");
    assert.equal(resolvedRoute.rail, "x402");
    assert.equal(resolvedRoute.x402?.paymentRequirements[0]?.resource, "https://merchant.test/paid");

    const handler = kit.withNextNode("paid", async (args) => {
      assert.equal(args.rail, "x402");
      if (args.rail !== "x402") throw new Error("Expected x402 route.");
      return Response.json({
        ok: true,
        routeId: args.route.id,
        paymentReference: args.x402.paymentReference,
      });
    });

    const response = await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );

    await reporter.flush();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      routeId: "paid",
      paymentReference: settleResponse.transaction,
    });
    assert.equal(settlementBodies.length, 1);
    assert.equal(settlementBodies[0]?.serviceSlug, "agent-123");
    assert.equal(settlementBodies[0]?.paymentReference, settleResponse.transaction);
  });

  it("wraps a config-driven express route through fulfillment ticket verification and capture", async () => {
    const { captureBodies } = setupMerchantFetchMock();
    const merchant = createMerchant();
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        managed: {
          method: "POST",
          path: "/managed",
          rail: "express",
          express: {
            creditCost: 5,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
    });
    const headers = await createFulfillmentHeaders({
      serviceSlug: "agent-123",
      path: "/managed",
      method: "POST",
      query: "topic=ghost",
      body: {
        prompt: "hello",
      },
      cost: 5,
    });

    const handler = kit.withNextNode("managed", async (args) => {
      assert.equal(args.rail, "express");
      if (args.rail !== "express") throw new Error("Expected express route.");
      return Response.json({
        ok: true,
        routeId: args.route.id,
        ticketId: args.fulfillment.ticketId,
      });
    });

    const response = await handler(
      new Request("https://merchant.test/managed?topic=ghost", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: "hello",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.has("x-ghost-fulfillment-ticket-id"), true);
    assert.equal(response.headers.has("x-ghost-fulfillment-delivery-proof-id"), true);
    assert.deepEqual(await response.json(), {
      ok: true,
      routeId: "managed",
      ticketId: `0x${"ab".repeat(32)}`,
    });
    assert.equal(captureBodies.length, 1);
    assert.equal(captureBodies[0]?.ticketId, `0x${"ab".repeat(32)}`);
    assert.equal(
      (captureBodies[0]?.completionMeta as Record<string, unknown> | undefined)?.statusCode,
      200,
    );
  });

  it("rejects express-route tickets whose bound cost does not match ghost.config creditCost", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        managed: {
          method: "POST",
          path: "/managed",
          rail: "express",
          express: {
            creditCost: 5,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
    });
    const headers = await createFulfillmentHeaders({
      serviceSlug: "agent-123",
      path: "/managed",
      method: "POST",
      query: "topic=ghost",
      body: {
        prompt: "hello",
      },
      cost: 1,
    });

    const handler = kit.withNextNode("managed", async () => Response.json({ ok: true }));

    const response = await handler(
      new Request("https://merchant.test/managed?topic=ghost", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: "hello",
        }),
      }),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "invalid_fulfillment_ticket",
      detail: "Fulfillment ticket cost does not match expected cost.",
    });
  });

  it("requires explicit rail selection for hybrid routes and resolves both rails cleanly", () => {
    const merchant = createMerchant();
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        dual: {
          method: "POST",
          path: "/dual",
          rail: "hybrid",
          x402: {
            paymentRequirements,
          },
          express: {
            creditCost: 7,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
      x402: {
        x402Client: {} as never,
      },
    });

    assert.throws(() => kit.resolveRoute("dual"), /requires an explicit rail selection/i);
    assert.equal(kit.resolveRoute({ routeId: "dual", rail: "x402" }).rail, "x402");
    assert.equal(kit.resolveRoute({ routeId: "dual", rail: "express" }).rail, "express");
  });

  it("wraps a Hono binding through the monetization kit", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        paid: {
          method: "POST",
          path: "/paid",
          rail: "x402",
          x402: {
            paymentRequirements,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
      x402: {
        x402Client: {} as never,
        reporter,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
    });

    const handler = kit.withHono("paid", async ({ route, request, rail }) => {
      assert.equal(rail, "x402");
      return Response.json({ ok: true, routeId: route.id, url: request.url });
    });

    const response = await handler({
      req: {
        raw: new Request("https://merchant.test/paid", {
          method: "POST",
          headers: {
            "X-PAYMENT": "paid-header",
          },
        }),
      },
    });

    await reporter.flush();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      routeId: "paid",
      url: "https://merchant.test/paid",
    });
  });

  it("wraps an Express binding through the monetization kit", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        paid: {
          method: "POST",
          path: "/paid",
          rail: "x402",
          x402: {
            paymentRequirements,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
      x402: {
        x402Client: {} as never,
        reporter,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
    });

    const handler = kit.withExpress("paid", async ({ route, req, rail }) => {
      assert.equal(rail, "x402");
      return {
        ok: true,
        routeId: route.id,
        path: req.originalUrl,
      };
    });

    const responseState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: "",
    };

    await handler(
      {
        method: "POST",
        originalUrl: "/paid",
        protocol: "https",
        headers: {
          host: "merchant.test",
          "x-payment": "paid-header",
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

    await reporter.flush();

    assert.equal(responseState.statusCode, 200);
    assert.deepEqual(JSON.parse(responseState.body), {
      ok: true,
      routeId: "paid",
      path: "/paid",
    });
  });

  it("wraps a Fastify binding through the monetization kit", async () => {
    const { captureBodies } = setupMerchantFetchMock();
    const merchant = createMerchant();
    const config = defineGhostConfig({
      version: 1,
      service: {
        agentId: "123",
        serviceSlug: "agent-123",
        endpointUrl: "https://merchant.test",
      },
      routes: {
        managed: {
          method: "POST",
          path: "/managed",
          rail: "express",
          express: {
            creditCost: 5,
          },
        },
      },
    });
    const kit = createGhostHttpMonetizationKit({
      merchant,
      config,
    });
    const headers = await createFulfillmentHeaders({
      serviceSlug: "agent-123",
      path: "/managed",
      method: "POST",
      query: "topic=ghost",
      body: {
        prompt: "hello",
      },
      cost: 5,
    });

    const handler = kit.withFastify("managed", async ({ route, rail, request }) => {
      assert.equal(rail, "express");
      return {
        ok: true,
        routeId: route.id,
        method: request.method,
      };
    });

    const replyState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: null as unknown,
    };

    await handler(
      {
        method: "POST",
        url: "/managed?topic=ghost",
        protocol: "https",
        headers: {
          host: "merchant.test",
          ...headers,
          "content-type": "application/json",
        },
        body: {
          prompt: "hello",
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

    assert.equal(replyState.statusCode, 200);
    assert.deepEqual(replyState.body, {
      ok: true,
      routeId: "managed",
      method: "POST",
    });
    assert.equal(captureBodies.length, 1);
  });
});
