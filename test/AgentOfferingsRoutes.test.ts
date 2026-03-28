import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { GET as listOfferings, POST as createOffering } from "../app/api/agent-offerings/route";
import { PATCH as patchOffering } from "../app/api/agent-offerings/[id]/route";
import { POST as reorderOfferings } from "../app/api/agent-offerings/reorder/route";
import { agentOfferingsAuth, MAX_AGENT_OFFERINGS } from "../lib/agent-offerings";
import { prisma } from "../lib/db";

const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";

const jsonRequest = (url: string, method: string, body: Record<string, unknown>) =>
  new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const getRequest = (url: string, headers?: Record<string, string>) =>
  new NextRequest(url, {
    method: "GET",
    headers,
  });

const validCreateBody = () => ({
  agentId: "18755",
  ownerAddress: OWNER_A,
  actorAddress: OWNER_A,
  authPayload: {
    scope: "agent_gateway",
    version: "1",
    action: "offerings_manage",
    agentId: "18755",
    ownerAddress: OWNER_A,
    actorAddress: OWNER_A,
    serviceSlug: "agent-18755",
    nonce: "nonce123",
    issuedAt: 1234567890,
  },
  authSignature: "0x1234",
  title: "Wallet Risk Review",
  description: "Analyze this wallet and summarize the biggest risks.",
  consumerCommand: "Analyze this wallet and summarize the biggest risks",
  rail: "EXPRESS",
  targetKind: "SERVICE_SLUG",
  targetRef: "agent-18755",
  priceHint: "Starts at 2 credits",
  etaHint: "~5 min",
  isActive: true,
});

const originalGatewayFindUnique = prisma.agentGatewayConfig.findUnique;
const originalOfferingCount = prisma.agentOffering.count;
const originalOfferingFindUnique = prisma.agentOffering.findUnique;
const originalOfferingFindMany = prisma.agentOffering.findMany;

const stubGatewayFindUnique = (impl: any) => {
  (prisma.agentGatewayConfig as { findUnique: any }).findUnique = impl;
};

const stubOfferingCount = (impl: any) => {
  (prisma.agentOffering as { count: any }).count = impl;
};

const stubOfferingFindUnique = (impl: any) => {
  (prisma.agentOffering as { findUnique: any }).findUnique = impl;
};

const stubOfferingFindMany = (impl: any) => {
  (prisma.agentOffering as { findMany: any }).findMany = impl;
};

afterEach(() => {
  stubGatewayFindUnique(originalGatewayFindUnique);
  stubOfferingCount(originalOfferingCount);
  stubOfferingFindUnique(originalOfferingFindUnique);
  stubOfferingFindMany(originalOfferingFindMany);
  mock.restoreAll();
});

describe("agent offerings routes", () => {
  it("rejects includeInactive reads without merchant authorization", async () => {
    const response = await listOfferings(
      getRequest("https://ghost.local/api/agent-offerings?agentId=18755&includeInactive=1"),
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 401);
    assert.match(String(payload.error), /merchant authorization/i);
  });

  it("does not accept draft-read auth material in query params", async () => {
    const params = new URLSearchParams({
      agentId: "18755",
      includeInactive: "1",
      ownerAddress: OWNER_A,
      actorAddress: OWNER_A,
      authPayload: JSON.stringify(validCreateBody().authPayload),
      authSignature: "0x1234",
    });

    const response = await listOfferings(getRequest(`https://ghost.local/api/agent-offerings?${params.toString()}`));
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 401);
    assert.match(String(payload.error), /merchant authorization/i);
  });

  it("rejects includeInactive reads when ownerAddress does not match the selected agent gateway owner", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));

    const authPayload = {
      ...validCreateBody().authPayload,
      ownerAddress: OWNER_B,
      actorAddress: OWNER_B,
    };
    const params = new URLSearchParams({
      agentId: "18755",
      includeInactive: "1",
    });

    const response = await listOfferings(
      getRequest(`https://ghost.local/api/agent-offerings?${params.toString()}`, {
        "x-ghost-offerings-owner-address": OWNER_B,
        "x-ghost-offerings-actor-address": OWNER_B,
        "x-ghost-offerings-auth-payload": JSON.stringify(authPayload),
        "x-ghost-offerings-auth-signature": "0x1234",
      }),
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.match(String(payload.error), /selected agent gateway owner/i);
  });

  it("allows includeInactive reads for the selected agent owner", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    stubOfferingFindMany(async () => [
      {
        id: "off_1",
        agentId: "18755",
        title: "Draft Wallet Review",
        description: "desc",
        consumerCommand: "cmd",
        rail: "EXPRESS",
        targetKind: "MCP_TOOL",
        targetRef: "wallet_review",
        priceHint: "Starts at 2 credits",
        etaHint: "~5 min",
        isActive: false,
        sortOrder: 0,
        createdAt: new Date("2026-03-28T00:00:00.000Z"),
        updatedAt: new Date("2026-03-28T00:00:00.000Z"),
      },
    ]);
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));

    const params = new URLSearchParams({
      agentId: "18755",
      includeInactive: "1",
    });

    const response = await listOfferings(
      getRequest(`https://ghost.local/api/agent-offerings?${params.toString()}`, {
        "x-ghost-offerings-owner-address": OWNER_A,
        "x-ghost-offerings-actor-address": OWNER_A,
        "x-ghost-offerings-auth-payload": JSON.stringify(validCreateBody().authPayload),
        "x-ghost-offerings-auth-signature": "0x1234",
      }),
    );
    const payload = (await response.json()) as { ok?: boolean; items?: Array<{ isActive: boolean; id: string }> };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.items?.length, 1);
    assert.equal(payload.items?.[0]?.id, "off_1");
    assert.equal(payload.items?.[0]?.isActive, false);
  });

  it("rejects create when ownerAddress does not match the selected agent gateway owner", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));

    const response = await createOffering(
      jsonRequest("https://ghost.local/api/agent-offerings", "POST", {
        ...validCreateBody(),
        ownerAddress: OWNER_B,
      }),
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.match(String(payload.error), /selected agent gateway owner/i);
  });

  it("rejects create when required fields are missing", async () => {
    const body = validCreateBody();
    delete (body as Record<string, unknown>).title;

    const response = await createOffering(jsonRequest("https://ghost.local/api/agent-offerings", "POST", body));
    const payload = (await response.json()) as { error?: string; field?: string };

    assert.equal(response.status, 400);
    assert.equal(payload.field, "title");
  });

  it("rejects invalid rail and target kind combinations", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));

    const response = await createOffering(
      jsonRequest("https://ghost.local/api/agent-offerings", "POST", {
        ...validCreateBody(),
        rail: "GHOSTWIRE",
        targetKind: "SERVICE_SLUG",
      }),
    );
    const payload = (await response.json()) as { error?: string; field?: string };

    assert.equal(response.status, 400);
    assert.equal(payload.field, "targetKind");
  });

  it("rejects SERVICE_SLUG offerings whose targetRef does not match the configured gateway slug", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));

    const response = await createOffering(
      jsonRequest("https://ghost.local/api/agent-offerings", "POST", {
        ...validCreateBody(),
        targetRef: "agent-99999",
      }),
    );
    const payload = (await response.json()) as { error?: string; field?: string };

    assert.equal(response.status, 409);
    assert.equal(payload.field, "targetRef");
  });

  it("enforces MAX_AGENT_OFFERINGS on create", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));
    stubOfferingCount(async () => MAX_AGENT_OFFERINGS);

    const response = await createOffering(jsonRequest("https://ghost.local/api/agent-offerings", "POST", validCreateBody()));
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 409);
    assert.match(String(payload.error), /at most/i);
  });

  it("rejects patch when the caller is not the owner of the target offering's agent", async () => {
    stubOfferingFindUnique(async () => ({
      id: "off_1",
      agentId: "18755",
      title: "Wallet Risk Review",
      description: "desc",
      consumerCommand: "cmd",
      rail: "EXPRESS",
      targetKind: "SERVICE_SLUG",
      targetRef: "agent-18755",
      priceHint: null,
      etaHint: null,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date("2026-03-28T00:00:00.000Z"),
      updatedAt: new Date("2026-03-28T00:00:00.000Z"),
    }));
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));

    const response = await patchOffering(
      jsonRequest("https://ghost.local/api/agent-offerings/off_1", "PATCH", {
        ownerAddress: OWNER_B,
        actorAddress: OWNER_B,
        authPayload: validCreateBody().authPayload,
        authSignature: "0x1234",
        title: "Updated title",
      }),
      { params: Promise.resolve({ id: "off_1" }) },
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.match(String(payload.error), /selected agent gateway owner/i);
  });

  it("rejects reorder payloads that cross agent boundaries", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));
    stubOfferingFindMany(async () => [{ id: "off_1" }, { id: "off_2" }]);

    const response = await reorderOfferings(
      jsonRequest("https://ghost.local/api/agent-offerings/reorder", "POST", {
        agentId: "18755",
        ownerAddress: OWNER_A,
        actorAddress: OWNER_A,
        authPayload: validCreateBody().authPayload,
        authSignature: "0x1234",
        orderedIds: ["off_1", "foreign_offering"],
      }),
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(String(payload.error), /complete set/i);
  });

  it("rejects reorder payloads that do not contain the complete set exactly once", async () => {
    stubGatewayFindUnique(async () => ({
      id: "cfg_1",
      agentId: "18755",
      ownerAddress: OWNER_A,
      serviceSlug: "agent-18755",
    }));
    mock.method(agentOfferingsAuth, "verifyMerchantGatewaySignedWrite", async () => ({
      ok: true as const,
      authPayload: validCreateBody().authPayload,
      signer: OWNER_A,
    }));
    stubOfferingFindMany(async () => [{ id: "off_1" }, { id: "off_2" }, { id: "off_3" }]);

    const response = await reorderOfferings(
      jsonRequest("https://ghost.local/api/agent-offerings/reorder", "POST", {
        agentId: "18755",
        ownerAddress: OWNER_A,
        actorAddress: OWNER_A,
        authPayload: validCreateBody().authPayload,
        authSignature: "0x1234",
        orderedIds: ["off_1", "off_1", "off_2"],
      }),
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(String(payload.error), /exactly once/i);
  });
});
