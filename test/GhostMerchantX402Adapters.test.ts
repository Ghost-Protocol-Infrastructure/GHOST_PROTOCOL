import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "x402/types";
import {
  GhostMerchant,
  withGhostX402Express,
  withGhostX402Fastify,
  withGhostX402Hono,
  withGhostX402NextNode,
} from "../packages/sdk/src/index";

const OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" as const;
const OWNER_ADDRESS = privateKeyToAccount(OWNER_PRIVATE_KEY).address.toLowerCase();
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
    resource: "https://merchant.test/paid",
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

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  return { settlementBodies };
};

const createMerchant = () =>
  new GhostMerchant({
    baseUrl: BASE_URL,
    serviceSlug: "agent-123",
    ownerPrivateKey: OWNER_PRIVATE_KEY,
  });

describe("Task 4 x402 Node adapters", () => {
  it("returns a canonical 402 challenge for Next.js node handlers when payment is missing", async () => {
    const merchant = createMerchant();

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        x402Client: {} as never,
      },
      async () => ({ ok: true }),
    );

    const response = await handler(new Request("https://merchant.test/paid", { method: "POST" }));
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 402);
    assert.equal(payload.x402Version, 1);
    assert.deepEqual(payload.accepts, paymentRequirements);
  });

  it("wraps a Next.js node handler through verify, settle, response, and async reporting", async () => {
    const { settlementBodies } = setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "next_node",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ x402 }) => {
        assert.equal(x402.requestId.length > 0, true);
        assert.equal(x402.paymentReference, settleResponse.transaction);
        return Response.json({ ok: true });
      },
    );

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
    assert.equal(response.headers.has("X-PAYMENT-RESPONSE"), true);
    assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-PAYMENT-RESPONSE");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(settlementBodies.length, 1);
    assert.equal(settlementBodies[0]?.scheme, "x402");
    assert.equal(settlementBodies[0]?.network, "base");
    assert.equal(settlementBodies[0]?.asset, "USDC");
    assert.equal(settlementBodies[0]?.amountAtomic, "1000000");
    assert.equal(settlementBodies[0]?.paymentReference, settleResponse.transaction);
    assert.equal(settlementBodies[0]?.statusCode, 200);
    assert.equal(settlementBodies[0]?.success, true);
  });

  it("records payment_verified before enqueueing async reporting for successful paid requests", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const events: Array<Record<string, unknown>> = [];
    const reporter = merchant.createX402SettlementReporter({
      runtime: "next_node",
      retryDelaysMs: [0],
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async () => ({ ok: true }),
    );

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
    assert.equal(reporter.getSnapshot().counters.paymentVerified, 1);
    assert.deepEqual(
      events.map((event) => event.name),
      ["payment_verified", "report_enqueued", "report_sent", "report_accepted"],
    );
  });

  it("records a local report_dropped event when metadata generation fails before enqueue", async () => {
    const merchant = createMerchant();
    const events: Array<Record<string, unknown>> = [];
    const reporter = merchant.createX402SettlementReporter({
      runtime: "next_node",
      retryDelaysMs: [0],
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
        getMetadata: async () => {
          throw new Error("metadata resolution failed");
        },
      },
      async () => ({ ok: true }),
    );

    const response = await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = reporter.getSnapshot();
    assert.equal(response.status, 200);
    assert.equal(snapshot.counters.paymentVerified, 1);
    assert.equal(snapshot.counters.reportEnqueued, 0);
    assert.equal(snapshot.counters.reportDropped, 1);
    assert.deepEqual(
      events.map((event) => event.name),
      ["payment_verified", "report_dropped"],
    );
    assert.match(String(events[1]?.error ?? ""), /metadata resolution failed/i);
  });

  it("wraps a Hono context without merchant payment plumbing", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402Hono(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ context }) => Response.json({ path: context.req!.raw!.url }),
    );

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
    assert.deepEqual(await response.json(), { path: "https://merchant.test/paid" });
  });

  it("wraps an Express-style handler and writes the settled response", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402Express(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ req }) => ({
        ok: true,
        path: req.originalUrl,
      }),
    );

    const responseState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: "",
    };

    const req = {
      method: "POST",
      originalUrl: "/paid",
      protocol: "https",
      headers: {
        host: "merchant.test",
        "x-payment": "paid-header",
      },
    };

    const res = {
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
    };

    await handler(req, res);
    await reporter.flush();

    assert.equal(responseState.statusCode, 200);
    assert.equal(responseState.headers.has("x-payment-response"), true);
    assert.deepEqual(JSON.parse(responseState.body), {
      ok: true,
      path: "/paid",
    });
  });

  it("forwards Express request bodies into the canonical Request", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402Express(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return { ok: true, body };
      },
    );

    const responseState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: "",
    };

    const req = {
      method: "POST",
      originalUrl: "/paid",
      protocol: "https",
      headers: {
        host: "merchant.test",
        "content-type": "application/json",
        "x-payment": "paid-header",
      },
      body: {
        hello: "world",
      },
    };

    const res = {
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
    };

    await handler(req, res);
    await reporter.flush();

    assert.equal(responseState.statusCode, 200);
    assert.deepEqual(JSON.parse(responseState.body), {
      ok: true,
      body: {
        hello: "world",
      },
    });
  });

  it("wraps a Fastify-style handler and writes the settled response", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402Fastify(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ request }) => ({
        ok: true,
        method: request.method,
      }),
    );

    const replyState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: null as unknown,
    };

    const request = {
      method: "POST",
      url: "/paid",
      protocol: "https",
      headers: {
        host: "merchant.test",
        "x-payment": "paid-header",
      },
    };

    const reply = {
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
    };

    await handler(request, reply);
    await reporter.flush();

    assert.equal(replyState.statusCode, 200);
    assert.equal(replyState.headers.has("x-payment-response"), true);
    assert.deepEqual(replyState.body, {
      ok: true,
      method: "POST",
    });
  });

  it("forwards Fastify request bodies into the canonical Request", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const handler = withGhostX402Fastify(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reporter,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async ({ rawRequest }) => {
        const body = (await rawRequest.json()) as Record<string, unknown>;
        return {
          ok: true,
          body,
        };
      },
    );

    const replyState = {
      statusCode: 200,
      headers: new Map<string, string>(),
      body: null as unknown,
    };

    const request = {
      method: "POST",
      url: "/paid",
      protocol: "https",
      headers: {
        host: "merchant.test",
        "content-type": "application/json",
        "x-payment": "paid-header",
      },
      body: {
        fastify: true,
      },
    };

    const reply = {
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
    };

    await handler(request, reply);
    await reporter.flush();

    assert.equal(replyState.statusCode, 200);
    assert.deepEqual(replyState.body, {
      ok: true,
      body: {
        fastify: true,
      },
    });
  });

  it("returns a controlled 502 response when verify throws", async () => {
    const merchant = createMerchant();

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => {
          throw new Error("rpc down");
        },
      },
      async () => ({ ok: true }),
    );

    const response = await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 502);
    assert.equal(payload.x402Version, 1);
    assert.equal(payload.error, "unexpected_verify_error");
    assert.deepEqual(payload.accepts, paymentRequirements);
  });

  it("returns a controlled 502 response when settle throws", async () => {
    const merchant = createMerchant();

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => {
          throw new Error("settlement unavailable");
        },
      },
      async () => ({ ok: true }),
    );

    const response = await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 502);
    assert.equal(payload.x402Version, 1);
    assert.equal(payload.error, "unexpected_settle_error");
    assert.deepEqual(payload.accepts, paymentRequirements);
  });

  it("creates the default reporter once per adapter instance instead of per request", async () => {
    setupMerchantFetchMock();
    const merchant = createMerchant();
    const originalFactory = merchant.createX402SettlementReporter.bind(merchant);
    let createdReporters = 0;

    (merchant as GhostMerchant & {
      createX402SettlementReporter: GhostMerchant["createX402SettlementReporter"];
    }).createX402SettlementReporter = ((config) => {
      createdReporters += 1;
      return originalFactory(config);
    }) as GhostMerchant["createX402SettlementReporter"];

    const handler = withGhostX402NextNode(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async () => ({ ok: true }),
    );

    await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );
    await handler(
      new Request("https://merchant.test/paid", {
        method: "POST",
        headers: {
          "X-PAYMENT": "paid-header",
        },
      }),
    );

    assert.equal(createdReporters, 1);
  });

  it("allows Hono to select best-effort or manual reporting runtimes instead of hardcoding node_server", async () => {
    const merchant = createMerchant();
    const originalFactory = merchant.createX402SettlementReporter.bind(merchant);
    let createdRuntime: string | null = null;

    (merchant as GhostMerchant & {
      createX402SettlementReporter: GhostMerchant["createX402SettlementReporter"];
    }).createX402SettlementReporter = ((config) => {
      createdRuntime = config.runtime;
      return originalFactory(config);
    }) as GhostMerchant["createX402SettlementReporter"];

    const handler = withGhostX402Hono(
      {
        merchant,
        agentId: "123",
        paymentRequirements,
        reportingRuntime: "edge",
        x402Client: {} as never,
        decodePaymentHeader: () => paymentPayload,
        verifyPayment: async () => verifyResponse,
        settlePayment: async () => settleResponse,
      },
      async () => Response.json({ ok: true }),
    );

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

    assert.equal(response.status, 200);
    assert.equal(createdRuntime, "edge");
  });
});
