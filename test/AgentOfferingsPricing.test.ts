import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveCanonicalOfferingPrice } from "../lib/agent-offerings";

const ORIGINAL_GHOST_GATE_DB_SERVICE_PRICING_ENABLED = process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED;
const ORIGINAL_GHOST_GATE_SERVICE_PRICING_JSON = process.env.GHOST_GATE_SERVICE_PRICING_JSON;
const ORIGINAL_GHOST_REQUEST_CREDIT_COST = process.env.GHOST_REQUEST_CREDIT_COST;

afterEach(() => {
  process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = ORIGINAL_GHOST_GATE_DB_SERVICE_PRICING_ENABLED;
  process.env.GHOST_GATE_SERVICE_PRICING_JSON = ORIGINAL_GHOST_GATE_SERVICE_PRICING_JSON;
  process.env.GHOST_REQUEST_CREDIT_COST = ORIGINAL_GHOST_REQUEST_CREDIT_COST;
});

describe("resolveCanonicalOfferingPrice", () => {
  it("falls back to env service pricing when DB pricing is disabled or absent", async () => {
    process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = "false";
    process.env.GHOST_GATE_SERVICE_PRICING_JSON = JSON.stringify({
      "agent-18755": 7,
    });
    process.env.GHOST_REQUEST_CREDIT_COST = "1";

    const price = await resolveCanonicalOfferingPrice({
      targetKind: "SERVICE_SLUG",
      targetRef: "agent-18755",
    });

    assert.ok(price);
    assert.equal(price.credits, "7");
    assert.match(price.primaryDisplay, /7 credits/i);
  });

  it("falls back to the default request cost when no explicit service pricing exists", async () => {
    process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = "false";
    process.env.GHOST_GATE_SERVICE_PRICING_JSON = JSON.stringify({});
    process.env.GHOST_REQUEST_CREDIT_COST = "3";

    const price = await resolveCanonicalOfferingPrice({
      targetKind: "SERVICE_SLUG",
      targetRef: "agent-99999",
    });

    assert.ok(price);
    assert.equal(price.credits, "3");
    assert.match(price.primaryDisplay, /3 credits/i);
  });
});
