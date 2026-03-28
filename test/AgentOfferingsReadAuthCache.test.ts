import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearCachedAgentOfferingReadAuth,
  loadCachedAgentOfferingReadAuth,
  saveCachedAgentOfferingReadAuth,
} from "../lib/agent-offerings-read-auth";
import { createMerchantGatewayAuthPayload } from "../lib/agent-gateway-auth";

const createMemoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
};

const baseScope = {
  agentId: "18755",
  ownerAddress: "0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe",
  actorAddress: "0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe",
  serviceSlug: "agent-18755",
};

describe("agent offerings read auth cache", () => {
  it("loads a matching unexpired cached read auth record", () => {
    const storage = createMemoryStorage();
    saveCachedAgentOfferingReadAuth(storage, {
      ...baseScope,
      authPayload: createMerchantGatewayAuthPayload({
        action: "offerings_manage",
        ...baseScope,
        nonce: "abc123",
        issuedAt: Math.floor(Date.now() / 1000),
      }),
      authSignature: "0x1234",
      expiresAtMs: Date.now() + 60_000,
    });

    const cached = loadCachedAgentOfferingReadAuth(storage, baseScope);
    assert.ok(cached);
    assert.equal(cached.authSignature, "0x1234");
    assert.equal(cached.authPayload.action, "offerings_manage");
  });

  it("rejects a cached record when the scope does not match", () => {
    const storage = createMemoryStorage();
    saveCachedAgentOfferingReadAuth(storage, {
      ...baseScope,
      authPayload: createMerchantGatewayAuthPayload({
        action: "offerings_manage",
        ...baseScope,
        nonce: "abc123",
        issuedAt: Math.floor(Date.now() / 1000),
      }),
      authSignature: "0x1234",
      expiresAtMs: Date.now() + 60_000,
    });

    const cached = loadCachedAgentOfferingReadAuth(storage, {
      ...baseScope,
      serviceSlug: "agent-99999",
    });
    assert.equal(cached, null);
  });

  it("removes an expired cached record", () => {
    const storage = createMemoryStorage();
    saveCachedAgentOfferingReadAuth(storage, {
      ...baseScope,
      authPayload: createMerchantGatewayAuthPayload({
        action: "offerings_manage",
        ...baseScope,
        nonce: "abc123",
        issuedAt: Math.floor(Date.now() / 1000) - 300,
      }),
      authSignature: "0x1234",
      expiresAtMs: Date.now() - 1,
    });

    const cached = loadCachedAgentOfferingReadAuth(storage, baseScope);
    assert.equal(cached, null);

    clearCachedAgentOfferingReadAuth(storage, baseScope);
    assert.equal(loadCachedAgentOfferingReadAuth(storage, baseScope), null);
  });
});
