import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  applyGhostExpressMinimumCreditCost,
  getGhostExpressDefaultRequestCost,
  resolveGhostExpressHeaderOverrideCost,
  resolveGhostExpressServiceCost,
} from "../lib/ghost-express-pricing";

const ORIGINAL_GHOST_GATE_DB_SERVICE_PRICING_ENABLED = process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED;
const ORIGINAL_GHOST_GATE_SERVICE_PRICING_JSON = process.env.GHOST_GATE_SERVICE_PRICING_JSON;
const ORIGINAL_GHOST_REQUEST_CREDIT_COST = process.env.GHOST_REQUEST_CREDIT_COST;

afterEach(() => {
  process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = ORIGINAL_GHOST_GATE_DB_SERVICE_PRICING_ENABLED;
  process.env.GHOST_GATE_SERVICE_PRICING_JSON = ORIGINAL_GHOST_GATE_SERVICE_PRICING_JSON;
  process.env.GHOST_REQUEST_CREDIT_COST = ORIGINAL_GHOST_REQUEST_CREDIT_COST;
});

describe("ghost express pricing policy", () => {
  it("floors the global default request cost to five credits", () => {
    process.env.GHOST_REQUEST_CREDIT_COST = "1";
    assert.equal(getGhostExpressDefaultRequestCost(), 5n);
    assert.equal(applyGhostExpressMinimumCreditCost(3n), 5n);
    assert.equal(applyGhostExpressMinimumCreditCost(7n), 7n);
  });

  it("floors request-scoped overrides below five credits", () => {
    assert.equal(resolveGhostExpressHeaderOverrideCost("4"), 5n);
    assert.equal(resolveGhostExpressHeaderOverrideCost("7"), 7n);
    assert.equal(resolveGhostExpressHeaderOverrideCost(""), null);
  });

  it("floors env service pricing below five credits", async () => {
    process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = "false";
    process.env.GHOST_GATE_SERVICE_PRICING_JSON = JSON.stringify({
      "agent-18755": 2,
    });
    process.env.GHOST_REQUEST_CREDIT_COST = "1";

    const pricing = await resolveGhostExpressServiceCost("agent-18755");
    assert.equal(pricing.source, "env");
    assert.equal(pricing.cost, 5n);
  });

  it("preserves higher explicit service pricing", async () => {
    process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED = "false";
    process.env.GHOST_GATE_SERVICE_PRICING_JSON = JSON.stringify({
      "agent-18755": 9,
    });
    process.env.GHOST_REQUEST_CREDIT_COST = "5";

    const pricing = await resolveGhostExpressServiceCost("agent-18755");
    assert.equal(pricing.source, "env");
    assert.equal(pricing.cost, 9n);
  });
});
