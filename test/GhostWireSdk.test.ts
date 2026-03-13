import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GhostAgent } from "../packages/sdk/src/index";

const originalFetch = globalThis.fetch;

const createJsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GHOSTWIRE_EXEC_SECRET;
});

describe("GhostAgent GhostWire helpers", () => {
  it("creates a GhostWire quote with provider attribution hints", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method, body });

      return createJsonResponse(200, {
        ok: true,
        apiVersion: 1,
        quoteId: "wq_123",
        expiresAt: new Date().toISOString(),
      });
    };

    const agent = new GhostAgent({ privateKey: "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" });
    const result = await agent.createWireQuote({
      provider: "0x2222222222222222222222222222222222222222",
      evaluator: "0x3333333333333333333333333333333333333333",
      principalAmount: "1000000",
      providerAgentId: "18755",
      providerServiceSlug: "agent-18755",
    });

    assert.equal(result.ok, true);
    assert.equal(result.quoteId, "wq_123");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/wire\/quote$/);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.body?.providerAgentId, "18755");
    assert.equal(calls[0]!.body?.providerServiceSlug, "agent-18755");
  });

  it("creates a hosted GhostWire job with execution auth", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body: Record<string, unknown> | null }> = [];
    process.env.GHOSTWIRE_EXEC_SECRET = "super-secret";

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({
        url,
        method,
        auth: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        body,
      });

      return createJsonResponse(200, {
        ok: true,
        apiVersion: 1,
        jobId: "wj_123",
        quoteId: "wq_123",
        chainId: 8453,
        state: "OPEN",
        contractState: "OPEN",
        pricing: {},
        operator: {},
      });
    };

    const agent = new GhostAgent({ privateKey: "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" });
    const result = await agent.createWireJob({
      quoteId: "wq_123",
      client: "0x1111111111111111111111111111111111111111",
      provider: "0x2222222222222222222222222222222222222222",
      evaluator: "0x3333333333333333333333333333333333333333",
      providerAgentId: "18755",
      providerServiceSlug: "agent-18755",
      specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadataUri: "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_123",
    });

    assert.equal(result.ok, true);
    assert.equal(result.jobId, "wj_123");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/wire\/jobs$/);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.auth, "Bearer super-secret");
    assert.equal(calls[0]!.body?.quoteId, "wq_123");
    assert.equal(calls[0]!.body?.providerAgentId, "18755");
    assert.equal(calls[0]!.body?.providerServiceSlug, "agent-18755");
  });

  it("resolves a completed GhostWire deliverable from the job locator", async () => {
    const responses = [
      createJsonResponse(200, {
        ok: true,
        apiVersion: 1,
        job: {
          id: "1",
          jobId: "wj_456",
          quoteId: "wq_456",
          chainId: 8453,
          jobExpiresAt: new Date().toISOString(),
          state: "COMPLETED",
          contractState: "COMPLETED",
          terminalDisposition: "COMPLETED",
          clientAddress: "0x1111111111111111111111111111111111111111",
          providerAddress: "0x2222222222222222222222222222222222222222",
          evaluatorAddress: "0x3333333333333333333333333333333333333333",
          specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          metadataUri: "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_456",
          contractAddress: null,
          contractJobId: null,
          createTxHash: null,
          fundTxHash: null,
          terminalTxHash: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pricing: {
            principal: { asset: "USDC", amount: "1000000", decimals: 6 },
            protocolFee: { asset: "USDC", amount: "25000", decimals: 6, bps: 250 },
            networkReserve: { asset: "ETH", amount: "3000000000000000", decimals: 18, chainId: 8453 },
          },
          operator: {
            createStatus: "SUCCEEDED",
            fundStatus: "SUCCEEDED",
            confirmationStatus: "SUCCEEDED",
            reconcileStatus: "SUCCEEDED",
            retryCount: 0,
            nextRetryAt: null,
            lastError: null,
          },
          deliverable: {
            available: true,
            locatorUrl: "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_456",
            mode: "merchant_locator",
            state: "READY",
          },
        },
      }),
      new Response(JSON.stringify({ roast: "GhostWire cleared escrow before your alpha did." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    globalThis.fetch = async (): Promise<Response> => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch call.");
      return response;
    };

    const agent = new GhostAgent({ privateKey: "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" });
    const result = await agent.getWireDeliverable("wj_456");

    assert.equal(result.ok, true);
    assert.equal(result.sourceUrl, "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_456");
    assert.deepEqual(result.bodyJson, { roast: "GhostWire cleared escrow before your alpha did." });
  });
});
