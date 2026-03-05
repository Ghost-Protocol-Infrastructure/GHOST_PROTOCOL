import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { isSettlementOperatorAuthorized, isSettlementSupportAuthorized } from "../lib/merchant-settlement-route";

const OPERATOR_SECRET = "operator-secret-value";
const SUPPORT_SECRET = "support-secret-value";

const makeRequest = (url: string, headers?: Record<string, string>) =>
  new NextRequest(url, {
    headers,
  });

afterEach(() => {
  delete process.env.GHOST_SETTLEMENT_OPERATOR_SECRET;
  delete process.env.GHOST_SETTLEMENT_SUPPORT_SECRET;
  delete process.env.GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET;
});

describe("merchant settlement route auth", () => {
  it("authorizes operator requests from bearer or custom header values", () => {
    process.env.GHOST_SETTLEMENT_OPERATOR_SECRET = OPERATOR_SECRET;

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          authorization: `Bearer ${OPERATOR_SECRET}`,
        }),
      ),
      true,
    );

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          "x-ghost-settlement-operator-secret": OPERATOR_SECRET,
        }),
      ),
      true,
    );
  });

  it("does not accept operator or support secrets via query parameters", () => {
    process.env.GHOST_SETTLEMENT_OPERATOR_SECRET = OPERATOR_SECRET;
    process.env.GHOST_SETTLEMENT_SUPPORT_SECRET = SUPPORT_SECRET;

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest(`https://ghost.local/api/admin/settlement/allocate?secret=${OPERATOR_SECRET}`),
      ),
      false,
    );

    assert.equal(
      isSettlementSupportAuthorized(
        makeRequest(`https://ghost.local/api/admin/settlement/reconcile?secret=${SUPPORT_SECRET}`),
      ),
      false,
    );
  });

  it("rejects mismatched secret lengths and wrong values", () => {
    process.env.GHOST_SETTLEMENT_OPERATOR_SECRET = OPERATOR_SECRET;

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          authorization: "Bearer short",
        }),
      ),
      false,
    );

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          authorization: "Bearer operator-secret-valuf",
        }),
      ),
      false,
    );
  });

  it("requires a dedicated settlement operator secret", () => {
    process.env.GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET = "expire-sweep-secret-value";

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          authorization: "Bearer expire-sweep-secret-value",
        }),
      ),
      false,
    );

    process.env.GHOST_SETTLEMENT_OPERATOR_SECRET = OPERATOR_SECRET;

    assert.equal(
      isSettlementOperatorAuthorized(
        makeRequest("https://ghost.local/api/admin/settlement/allocate", {
          authorization: `Bearer ${OPERATOR_SECRET}`,
        }),
      ),
      true,
    );
  });
});
