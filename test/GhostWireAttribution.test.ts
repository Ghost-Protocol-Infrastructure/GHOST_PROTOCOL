import assert from "node:assert/strict";
import test from "node:test";
import {
  GhostWireProviderAttributionError,
  resolveGhostWireProviderAttributionWithLookup,
} from "../lib/ghostwire-attribution";

const buildLookup = (input: {
  agentsById?: Record<string, { agentId: string; owner: string }>;
  agentsByOwner?: Record<string, Array<{ agentId: string; owner: string }>>;
  gatewayByOwner?: Record<string, Array<{ agentId: string; ownerAddress: string; serviceSlug: string }>>;
  gatewayBySlug?: Record<string, Array<{ agentId: string; ownerAddress: string; serviceSlug: string }>>;
}) => ({
  findAgentByAgentId: async (agentId: string) => input.agentsById?.[agentId] ?? null,
  findAgentsByOwnerAddress: async (ownerAddress: string) => input.agentsByOwner?.[ownerAddress.toLowerCase()] ?? [],
  findGatewayConfigsByOwnerAddress: async (ownerAddress: string) =>
    input.gatewayByOwner?.[ownerAddress.toLowerCase()] ?? [],
  findGatewayConfigsByServiceSlug: async (serviceSlug: string) => input.gatewayBySlug?.[serviceSlug] ?? [],
});

test("explicit providerAgentId wins when it matches provider ownership", async () => {
  const result = await resolveGhostWireProviderAttributionWithLookup(
    buildLookup({
      agentsById: {
        "18755": { agentId: "18755", owner: "0x1111111111111111111111111111111111111111" },
      },
    }),
    {
      providerAddress: "0x1111111111111111111111111111111111111111",
      providerAgentId: "18755",
    },
  );

  assert.deepEqual(result, {
    providerAgentId: "18755",
    providerServiceSlug: "agent-18755",
    source: "explicit_agent",
  });
});

test("explicit providerServiceSlug derives agent attribution when ownership matches", async () => {
  const result = await resolveGhostWireProviderAttributionWithLookup(
    buildLookup({
      agentsById: {
        "18755": { agentId: "18755", owner: "0x1111111111111111111111111111111111111111" },
      },
    }),
    {
      providerAddress: "0x1111111111111111111111111111111111111111",
      providerServiceSlug: "agent-18755",
    },
  );

  assert.deepEqual(result, {
    providerAgentId: "18755",
    providerServiceSlug: "agent-18755",
    source: "explicit_service_slug",
  });
});

test("unique owner-wallet match auto-derives provider attribution", async () => {
  const result = await resolveGhostWireProviderAttributionWithLookup(
    buildLookup({
      agentsByOwner: {
        "0x1111111111111111111111111111111111111111": [
          { agentId: "18755", owner: "0x1111111111111111111111111111111111111111" },
        ],
      },
    }),
    {
      providerAddress: "0x1111111111111111111111111111111111111111",
    },
  );

  assert.deepEqual(result, {
    providerAgentId: "18755",
    providerServiceSlug: "agent-18755",
    source: "owner_wallet",
  });
});

test("ambiguous owner-wallet matches stay unattributed", async () => {
  const result = await resolveGhostWireProviderAttributionWithLookup(
    buildLookup({
      agentsByOwner: {
        "0x1111111111111111111111111111111111111111": [
          { agentId: "18755", owner: "0x1111111111111111111111111111111111111111" },
          { agentId: "20000", owner: "0x1111111111111111111111111111111111111111" },
        ],
      },
    }),
    {
      providerAddress: "0x1111111111111111111111111111111111111111",
    },
  );

  assert.deepEqual(result, {
    providerAgentId: null,
    providerServiceSlug: null,
    source: "none",
  });
});

test("mismatched explicit ownership throws", async () => {
  await assert.rejects(
    () =>
      resolveGhostWireProviderAttributionWithLookup(
        buildLookup({
          agentsById: {
            "18755": { agentId: "18755", owner: "0x2222222222222222222222222222222222222222" },
          },
        }),
        {
          providerAddress: "0x1111111111111111111111111111111111111111",
          providerAgentId: "18755",
        },
      ),
    (error: unknown) =>
      error instanceof GhostWireProviderAttributionError &&
      error.message === "providerAgentId does not belong to the supplied provider wallet.",
  );
});
