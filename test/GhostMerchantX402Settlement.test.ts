import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createSettlementEvidence, GhostMerchant } from "../packages/sdk/src/index";

const OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" as const;
const DELEGATED_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca5f90f0e8f7f967f6d8f84be0b9d16f5dfec2d01fef16" as const;
const OWNER_ADDRESS = privateKeyToAccount(OWNER_PRIVATE_KEY).address.toLowerCase();
const BASE_URL = "https://ghostprotocol.cc";

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

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createSettlementEvidence", () => {
  it("normalizes valid settlement evidence to the receiver contract", () => {
    const occurredAt = new Date("2026-03-25T19:15:00.000Z");
    const evidence = createSettlementEvidence({
      requestId: "req_123",
      paymentReference: "pay_123",
      payerIdentity: "0xabc123",
      payerAddress: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
      scheme: "X402",
      network: "base",
      chainId: 8453,
      asset: "usdc",
      amountAtomic: "1000000",
      decimals: 6,
      success: true,
      statusCode: 200,
      latencyMs: 245,
      occurredAt,
      metadata: { rail: "x402" },
    });

    assert.deepEqual(evidence, {
      requestId: "req_123",
      paymentReference: "pay_123",
      payerIdentity: "0xabc123",
      payerAddress: "0x40dd75406eb154980ec17fadbfae4c6f841ac0fc",
      scheme: "x402",
      network: "base",
      chainId: 8453,
      asset: "USDC",
      amountAtomic: "1000000",
      decimals: 6,
      success: true,
      statusCode: 200,
      latencyMs: 245,
      occurredAt: occurredAt.toISOString(),
      metadata: { rail: "x402" },
    });
  });

  it("rejects values the receiver would reject", () => {
    const baseInput = {
      requestId: "req_123",
      paymentReference: "pay_123",
      payerIdentity: "payer_123",
      amountAtomic: "1000000",
      success: true,
    } as const;

    const invalidCases: Array<{
      input: Record<string, unknown>;
      pattern: RegExp;
    }> = [
      { input: { ...baseInput, chainId: 0 }, pattern: /chainId/i },
      { input: { ...baseInput, decimals: 19 }, pattern: /decimals/i },
      { input: { ...baseInput, statusCode: 99 }, pattern: /statusCode/i },
      { input: { ...baseInput, latencyMs: -1 }, pattern: /latencyMs/i },
      { input: { ...baseInput, amountAtomic: 0 }, pattern: /amountAtomic/i },
    ];

    for (const testCase of invalidCases) {
      assert.throws(
        () => createSettlementEvidence(testCase.input as Parameters<typeof createSettlementEvidence>[0]),
        testCase.pattern,
      );
    }
  });
});

describe("GhostMerchant.reportX402Settlement", () => {
  it("sends the canonical normalized settlement evidence payload", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: method === "POST" ? parseJsonBody(init?.body) : null,
      });

      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      return createJsonResponse(200, {
        ok: true,
        countedForRank: true,
        relatedParty: false,
        duplicate: false,
      });
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const result = await merchant.reportX402Settlement({
      agentId: "123",
      serviceSlug: "agent-123",
      requestId: "req_456",
      paymentReference: "pay_456",
      payerIdentity: "0xPayer",
      payerAddress: "0x40dD75406eB154980ec17fadbFAe4C6F841ac0FC",
      scheme: "X402",
      network: "base",
      chainId: 8453,
      asset: "usdc",
      amountAtomic: 1000000,
      decimals: 6,
      success: true,
      statusCode: 204,
      latencyMs: 125,
      occurredAt: "2026-03-25T20:00:00.000Z",
      metadata: { route: "/paid" },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/api\/agent-gateway\/config\?agentId=123$/);
    assert.match(calls[1]!.url, /\/api\/telemetry\/x402\/settlements$/);

    const body = calls[1]!.body;
    assert.ok(body);
    assert.equal(body?.requestId, "req_456");
    assert.equal(body?.paymentReference, "pay_456");
    assert.equal(body?.payerIdentity, "0xPayer");
    assert.equal(body?.payerAddress, "0x40dd75406eb154980ec17fadbfae4c6f841ac0fc");
    assert.equal(body?.scheme, "x402");
    assert.equal(body?.network, "base");
    assert.equal(body?.chainId, 8453);
    assert.equal(body?.asset, "USDC");
    assert.equal(body?.amountAtomic, "1000000");
    assert.equal(body?.decimals, 6);
    assert.equal(body?.success, true);
    assert.equal(body?.statusCode, 204);
    assert.equal(body?.latencyMs, 125);
    assert.equal(body?.occurredAt, "2026-03-25T20:00:00.000Z");
    assert.deepEqual(body?.metadata, { route: "/paid" });
    assert.equal(body?.agentId, "123");
    assert.equal(body?.serviceSlug, "agent-123");
    assert.equal(body?.ownerAddress, OWNER_ADDRESS);
    assert.equal(typeof body?.authPayload, "object");
    assert.equal(typeof body?.authSignature, "string");
  });
});

describe("GhostMerchant.createX402SettlementReporter", () => {
  const makeSettlementInput = () => ({
    agentId: "123",
    serviceSlug: "agent-123",
    requestId: "req_async",
      paymentReference: "pay_async",
      payerIdentity: "payer_async",
      amountAtomic: 1000000,
      success: true,
    });

  it("records payment_verified and emits lifecycle events for accepted reports", async () => {
    const events: Array<Record<string, unknown>> = [];

    globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      return createJsonResponse(200, {
        ok: true,
        countedForRank: true,
        relatedParty: false,
        duplicate: false,
      });
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    reporter.recordPaymentVerified({
      agentId: "123",
      serviceSlug: "agent-123",
      requestId: "req_async",
      paymentReference: "0xABCD1234",
    });
    const enqueue = reporter.enqueue({
      ...makeSettlementInput(),
      paymentReference: "0xabcd1234",
    });

    assert.equal(enqueue.accepted, true);

    await reporter.flush();

    const snapshot = reporter.getSnapshot();
    assert.equal(snapshot.counters.paymentVerified, 1);
    assert.equal(snapshot.counters.reportEnqueued, 1);
    assert.equal(snapshot.counters.reportSent, 1);
    assert.equal(snapshot.counters.reportAccepted, 1);
    assert.equal(snapshot.counters.reportDropped, 0);
    assert.deepEqual(
      events.map((event) => event.name),
      ["payment_verified", "report_enqueued", "report_sent", "report_accepted"],
    );
    assert.equal(events[0]?.paymentReference, "0xabcd1234");
    assert.equal(events[0]?.dedupeKey, "123:0xabcd1234");
  });

  it("dedupes duplicate paymentReference values within the reporter lifecycle", () => {
    globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      return createJsonResponse(200, {
        ok: true,
        countedForRank: true,
        relatedParty: false,
        duplicate: false,
      });
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const first = reporter.enqueue(makeSettlementInput());
    const second = reporter.enqueue(makeSettlementInput());

    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal(reporter.getSnapshot().counters.reportEnqueued, 1);
    assert.equal(reporter.getSnapshot().counters.duplicate, 1);
  });

  it("emits a duplicate lifecycle event when the same payment is enqueued twice", () => {
    const events: Array<Record<string, unknown>> = [];
    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    reporter.enqueue(makeSettlementInput());
    reporter.enqueue(makeSettlementInput());

    const eventNames = events.map((event) => event.name);
    assert.equal(eventNames.includes("report_enqueued"), true);
    assert.equal(eventNames.includes("duplicate"), true);
    const duplicateEvent = events.find((event) => event.name === "duplicate");
    assert.equal(duplicateEvent?.dedupeKey, "123:pay_async");
  });

  it("retries transient network failures and eventually accepts the report", async () => {
    let postAttempts = 0;

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      postAttempts += 1;
      if (postAttempts === 1) {
        throw new Error("temporary network failure");
      }

      return createJsonResponse(200, {
        ok: true,
        countedForRank: true,
        relatedParty: false,
        duplicate: false,
      });
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const enqueue = reporter.enqueue(makeSettlementInput());
    assert.equal(enqueue.accepted, true);

    await reporter.flush();

    assert.equal(postAttempts, 2);
    assert.equal(reporter.getSnapshot().queueSize, 0);
    assert.equal(reporter.getSnapshot().counters.reportSent, 2);
    assert.equal(reporter.getSnapshot().counters.reportAccepted, 1);
    assert.equal(reporter.getSnapshot().counters.reportDropped, 0);
  });

  it("drops the report after retry exhaustion without breaking the merchant response path", async () => {
    globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      throw new Error("ghost unavailable");
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const merchantResponse = (() => {
      const enqueue = reporter.enqueue(makeSettlementInput());
      assert.equal(enqueue.accepted, true);
      return { ok: true };
    })();

    assert.deepEqual(merchantResponse, { ok: true });

    await reporter.flush();

    const snapshot = reporter.getSnapshot();
    assert.equal(snapshot.queueSize, 0);
    assert.equal(snapshot.counters.reportAccepted, 0);
    assert.equal(snapshot.counters.reportDropped, 1);
    assert.match(snapshot.lastError ?? "", /ghost unavailable/i);
  });

  it("surfaces manual-only behavior for unsupported runtimes", () => {
    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "edge",
    });

    const enqueue = reporter.enqueue(makeSettlementInput());

    assert.equal(enqueue.accepted, false);
    assert.equal(enqueue.mode, "manual_only");
    assert.equal(enqueue.requiresManualReporting, true);
    assert.equal(reporter.getSnapshot().queueSize, 0);
  });

  it("uses best-effort delivery without retries for short-lived runtimes", async () => {
    let postAttempts = 0;

    globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      postAttempts += 1;
      throw new Error("best effort failure");
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "serverless_node",
      retryDelaysMs: [0, 0],
    });

    const enqueue = reporter.enqueue(makeSettlementInput());
    assert.equal(enqueue.accepted, true);
    assert.equal(enqueue.mode, "best_effort");

    await reporter.flush();

    const snapshot = reporter.getSnapshot();
    assert.equal(postAttempts, 1);
    assert.equal(snapshot.counters.reportSent, 1);
    assert.equal(snapshot.counters.reportAccepted, 0);
    assert.equal(snapshot.counters.reportDropped, 1);
  });

  it("treats case-variant hex payment references as the same duplicate key", () => {
    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const first = reporter.enqueue({
      ...makeSettlementInput(),
      paymentReference: "0xABCD1234",
    });
    const second = reporter.enqueue({
      ...makeSettlementInput(),
      paymentReference: "0xabcd1234",
    });

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
  });

  it("allows re-enqueue after a terminal drop clears the in-memory dedupe lock", async () => {
    globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return createJsonResponse(200, {
          configured: true,
          config: {
            ownerAddress: OWNER_ADDRESS,
            readinessStatus: "LIVE",
          },
        });
      }

      throw new Error("still down");
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const reporter = merchant.createX402SettlementReporter({
      runtime: "node_server",
      retryDelaysMs: [0],
    });

    const first = reporter.enqueue(makeSettlementInput());
    assert.equal(first.accepted, true);

    await reporter.flush();

    const second = reporter.enqueue(makeSettlementInput());
    assert.equal(second.accepted, true);
    assert.equal(second.duplicate, false);
  });
});
