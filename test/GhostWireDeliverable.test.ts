import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGhostWireDeliverableSummaryWithLookup,
  resolveGhostWireDeliverableLocatorWithLookup,
} from "../lib/ghostwire-deliverable";

const emptyLookup = {
  findGatewayEndpointUrl: async () => null,
};

describe("GhostWire deliverable locator resolution", () => {
  it("uses explicit https metadata locators directly", async () => {
    const summary = await buildGhostWireDeliverableSummaryWithLookup(emptyLookup, {
      jobId: "wj_123",
      metadataUri: "https://merchant.example.com/ghostwire/deliverable?jobId=wj_123",
      contractState: "COMPLETED",
    });

    assert.deepEqual(summary, {
      available: true,
      locatorUrl: "https://merchant.example.com/ghostwire/deliverable?jobId=wj_123",
      mode: "merchant_locator",
      state: "READY",
    });
  });

  it("converts explicit ipfs metadata locators into fetchable gateway URLs", async () => {
    const summary = await buildGhostWireDeliverableSummaryWithLookup(emptyLookup, {
      jobId: "wj_123",
      metadataUri: "ipfs://bafybeigdyrzt4/example.json",
      contractState: "COMPLETED",
    });

    assert.deepEqual(summary, {
      available: true,
      locatorUrl: "https://ipfs.io/ipfs/bafybeigdyrzt4/example.json",
      mode: "ipfs_gateway",
      state: "READY",
    });
  });

  it("resolves relative merchant locator paths against the registered gateway endpoint", async () => {
    const lookup = {
      findGatewayEndpointUrl: async () => "https://merchant.example.com/agent-18755",
    };

    const summary = await buildGhostWireDeliverableSummaryWithLookup(lookup, {
      jobId: "wj_123",
      metadataUri: "/wire/deliverable?jobId=wj_123",
      contractState: "OPEN",
      providerServiceSlug: "agent-18755",
      contractAddress: "0xabc",
      contractJobId: "7",
    });

    assert.deepEqual(summary, {
      available: false,
      locatorUrl: "https://merchant.example.com/agent-18755/wire/deliverable?jobId=wj_123",
      mode: "merchant_locator",
      state: "PENDING",
    });
  });

  it("surfaces explicit ipfs locators before considering gateway fallback", async () => {
    const lookup = {
      findGatewayEndpointUrl: async () => "https://merchant.example.com/agent-18755",
    };

    const resolved = await resolveGhostWireDeliverableLocatorWithLookup(lookup, {
      jobId: "wj_456",
      metadataUri: "ipfs://booski-ghostwire-mainnet-e2e-proof",
      providerServiceSlug: "agent-18755",
      contractAddress: "0xCA0c1834c5Ab5cb3778C36649cCBF76879780623",
      contractJobId: "3",
    });

    assert.deepEqual(resolved, {
      locatorUrl: "https://ipfs.io/ipfs/booski-ghostwire-mainnet-e2e-proof",
      mode: "ipfs_gateway",
    });
  });

  it("builds a standard merchant locator when no explicit deliverable URI exists", async () => {
    const lookup = {
      findGatewayEndpointUrl: async () => "https://merchant.example.com/agent-18755",
    };

    const summary = await buildGhostWireDeliverableSummaryWithLookup(lookup, {
      jobId: "wj_789",
      metadataUri: null,
      contractState: "COMPLETED",
      providerAddress: "0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe",
      contractAddress: "0xCA0c1834c5Ab5cb3778C36649cCBF76879780623",
      contractJobId: "9",
    });

    assert.deepEqual(summary, {
      available: true,
      locatorUrl:
        "https://merchant.example.com/agent-18755/wire/deliverable?contract=0xCA0c1834c5Ab5cb3778C36649cCBF76879780623&job=9&jobId=wj_789",
      mode: "gateway_standard",
      state: "READY",
    });
  });
});
