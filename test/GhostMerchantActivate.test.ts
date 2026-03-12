import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { GhostMerchant } from "../packages/sdk/src/index";

const OWNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945387dc9ce6468f4b4c0f2b7f36f58b6c0e88" as const;
const DELEGATED_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca5f90f0e8f7f967f6d8f84be0b9d16f5dfec2d01fef16" as const;
const OWNER_ADDRESS = privateKeyToAccount(OWNER_PRIVATE_KEY).address.toLowerCase();
const DELEGATED_ADDRESS = privateKeyToAccount(DELEGATED_PRIVATE_KEY).address.toLowerCase();
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

describe("GhostMerchant.activate", () => {
  it("runs configure -> verify -> signer registration in order and starts heartbeat", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const responses = [
      createJsonResponse(200, {
        configured: false,
        config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "UNCONFIGURED" },
      }),
      createJsonResponse(200, {
        ok: true,
        config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "CONFIGURED" },
      }),
      createJsonResponse(200, {
        ok: true,
        verified: true,
        readinessStatus: "LIVE",
        latencyMs: 132,
      }),
      createJsonResponse(200, {
        ok: true,
        created: true,
        alreadyActive: false,
      }),
    ];

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: method === "POST" ? parseJsonBody(init?.body) : null,
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch call.");
      return response;
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-123",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
      delegatedPrivateKey: DELEGATED_PRIVATE_KEY,
    });

    const result = await merchant.activate({
      agentId: "123",
      serviceSlug: "agent-123",
      endpointUrl: "https://merchant.example.com",
      canaryPath: "/canary",
    });

    assert.equal(result.status, "LIVE");
    assert.equal(result.readiness, "LIVE");
    assert.equal(result.signerRegistration.alreadyActive, false);

    assert.equal(calls.length, 4);
    assert.match(calls[0]!.url, /\/api\/agent-gateway\/config\?agentId=123$/);
    assert.equal(calls[0]!.method, "GET");

    assert.equal(calls[1]!.method, "POST");
    assert.match(calls[1]!.url, /\/api\/agent-gateway\/config$/);
    assert.equal(calls[1]!.body?.agentId, "123");
    assert.equal(calls[1]!.body?.serviceSlug, "agent-123");

    assert.equal(calls[2]!.method, "POST");
    assert.match(calls[2]!.url, /\/api\/agent-gateway\/verify$/);

    assert.equal(calls[3]!.method, "POST");
    assert.match(calls[3]!.url, /\/api\/agent-gateway\/delegated-signers\/register$/);
    assert.equal(calls[3]!.body?.signerAddress, DELEGATED_ADDRESS);

    result.heartbeat.stop();
  });

  it("throws actionable error when verify step does not become LIVE", async () => {
    const responses = [
      createJsonResponse(200, {
        configured: true,
        config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "CONFIGURED" },
      }),
      createJsonResponse(200, {
        ok: true,
        config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "CONFIGURED" },
      }),
      createJsonResponse(422, {
        ok: false,
        verified: false,
        readinessStatus: "DEGRADED",
        error: "Canary endpoint returned HTTP 500.",
      }),
    ];

    globalThis.fetch = async (): Promise<Response> => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch call.");
      return response;
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-321",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    await assert.rejects(
      merchant.activate({
        agentId: "321",
        serviceSlug: "agent-321",
        endpointUrl: "https://merchant.example.com",
      }),
      (error: unknown) => {
        assert.match(String(error), /\[activate:verify\]/);
        assert.match(String(error), /Canary endpoint returned HTTP 500/i);
        return true;
      },
    );
  });

  it("supports idempotent re-activation when signer already active", async () => {
    const responses = [
      createJsonResponse(200, { configured: true, config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "LIVE" } }),
      createJsonResponse(200, { ok: true, config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "CONFIGURED" } }),
      createJsonResponse(200, { ok: true, verified: true, readinessStatus: "LIVE" }),
      createJsonResponse(200, { ok: true, created: true, alreadyActive: false }),
      createJsonResponse(200, { configured: true, config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "LIVE" } }),
      createJsonResponse(200, { ok: true, config: { ownerAddress: OWNER_ADDRESS, readinessStatus: "CONFIGURED" } }),
      createJsonResponse(200, { ok: true, verified: true, readinessStatus: "LIVE" }),
      createJsonResponse(200, { ok: true, created: false, alreadyActive: true }),
    ];

    globalThis.fetch = async (): Promise<Response> => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch call.");
      return response;
    };

    const merchant = new GhostMerchant({
      baseUrl: BASE_URL,
      serviceSlug: "agent-777",
      ownerPrivateKey: OWNER_PRIVATE_KEY,
    });

    const first = await merchant.activate({
      agentId: "777",
      serviceSlug: "agent-777",
      endpointUrl: "https://merchant.example.com",
    });
    const second = await merchant.activate({
      agentId: "777",
      serviceSlug: "agent-777",
      endpointUrl: "https://merchant.example.com",
    });

    assert.equal(first.readiness, "LIVE");
    assert.equal(second.readiness, "LIVE");
    assert.equal(second.signerRegistration.alreadyActive, true);
    first.heartbeat.stop();
    second.heartbeat.stop();
  });
});
