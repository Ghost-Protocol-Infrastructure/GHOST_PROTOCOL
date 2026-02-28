# Agent Integration Playbook (Agent-First)

This guide is optimized for teams building autonomous agents that must reliably transact through Ghost Protocol.

Use this with:
- `docs/developer-portal/onboarding-and-configuration.md`
- `docs/fulfillment-operator-runbook.md`

## 1. Agent Roles In Ghost Protocol

### Consumer agent

Consumer agents request fulfillment tickets and execute merchant-bound requests.

Primary path:
1. `POST /api/fulfillment/ticket`
2. Call merchant endpoint with fulfillment ticket headers
3. Read capture outcome from merchant response payload

### Merchant runtime agent

Merchant runtimes verify ticket envelopes, execute task logic, and capture completion.

Primary path:
1. Verify request with `requireFulfillmentTicket(...)`
2. Execute task handler
3. Finalize with `POST /api/fulfillment/capture` via `captureCompletion(...)`

### Support agent (ops)

Support agents inspect timeline and aggregates for diagnosis:
- `GET /api/fulfillment/support/ticket`
- `GET /api/fulfillment/support/metrics`

## 2. Agent Capability Contract

Any agent integration should satisfy these capabilities:

1. Store and use runtime secrets safely.
2. Generate unique nonces for signed auth payloads.
3. Respect ticket/path/method/query/body binding contracts.
4. Implement deterministic retry policy (not blind retries).
5. Log correlation IDs for every transaction lifecycle.

Minimum identity/log fields:
- `serviceSlug`
- `ticketId`
- `clientRequestId`
- `deliveryProofId` (when available)
- `captureDisposition`
- `httpStatus`
- `errorCode`

## 3. Recommended Runtime Patterns

## Consumer agent execution pattern

Use `GhostFulfillmentConsumer.execute(...)` for most flows.

```ts
import { GhostFulfillmentConsumer } from "@ghostgate/sdk";

const consumer = new GhostFulfillmentConsumer({
  baseUrl: process.env.FULFILLMENT_BASE_URL!,
  privateKey: process.env.FULFILLMENT_CONSUMER_PRIVATE_KEY as `0x${string}`,
  defaultServiceSlug: "agent-18755",
});

const run = await consumer.execute({
  serviceSlug: "agent-18755",
  method: "POST",
  path: "/ask",
  query: { mode: "consumer" },
  cost: 1,
  body: { prompt: "agent task request" },
});

if (!run.ticket.ok) {
  // Handle ticket-level errors by status/errorCode policy table
}

if (!run.merchant.attempted || run.merchant.status !== 200) {
  // Merchant endpoint failed before successful capture path
}
```

## Merchant runtime pattern

Use `GhostFulfillmentMerchant.requireFulfillmentTicket(...)` and `captureCompletion(...)`.

```ts
const verified = await merchant.requireFulfillmentTicket({
  headers: request.headers,
  expected: {
    serviceSlug: "agent-18755",
    method: "POST",
    path: "/ask",
    query: request.nextUrl.search,
    body: requestBody,
  },
});

const resultBody = await runTask(requestBody);

const capture = await merchant.captureCompletion({
  ticketId: verified.ticketId,
  serviceSlug: "agent-18755",
  statusCode: 200,
  latencyMs: taskLatencyMs,
  responseBodyJson: resultBody,
});
```

## 4. Deterministic Error And Retry Policy

Treat fulfillment errors by class:

| HTTP / `errorCode` | Class | Agent action |
|---|---|---|
| `429 RATE_LIMITED` | Retryable | Retry only after `Retry-After` with backoff. |
| `500` route/internal errors | Retryable (bounded) | Retry with bounded attempts and jitter. Escalate if persistent. |
| `409 REPLAY` | Correctable | Generate new nonce and re-sign ticket auth. |
| `402 INSUFFICIENT_CREDITS` | Business block | Stop retries; trigger funding/sync workflow. |
| `423 SERVICE_NOT_LIVE` | Configuration block | Stop retries; trigger readiness verify workflow. |
| `403 UNAUTHORIZED_DELEGATED_SIGNER` | Configuration block | Stop retries; rotate/fix delegated signer registration+runtime key. |
| `409 HOLD_EXPIRED` | Terminal for ticket | Request a new ticket and re-run execution quickly. |
| `409 CAPTURE_CONFLICT` | Terminal conflict | Do not retry with new proof ID; treat as settled conflict requiring support review. |
| `409 HOLD_NOT_ACTIVE` | Terminal state | Do not retry capture on same ticket. |

Recommended retry caps:
- network/5xx: max `3` attempts
- `429`: max `2` deferred retries
- no automatic retries for `402/403/409 terminal/423`

## 5. Idempotency Rules Agents Must Respect

1. Replaying capture with same `ticketId` and same `deliveryProofId` is expected to return:
   - `200` + `captureDisposition: IDEMPOTENT_REPLAY`
2. Replaying capture with same `ticketId` but different `deliveryProofId` after capture returns:
   - `409 CAPTURE_CONFLICT`
3. Reusing ticket auth nonce in ticket issuance returns:
   - `409 REPLAY`

Agent implementation implication:
- Persist `deliveryProofId` until terminal capture outcome is confirmed.
- Persist `clientRequestId` and ticket request nonce for correlation.

## 6. Observability Contract For Agent Operators

Every lifecycle should emit structured logs/events:

1. `ticket.requested`
2. `ticket.issued` (or rejected with `errorCode`)
3. `merchant.request.started`
4. `merchant.request.completed`
5. `capture.submitted`
6. `capture.result` (`CAPTURED` or `IDEMPOTENT_REPLAY`)

Attach these dimensions:
- `serviceSlug`
- `ticketId`
- `walletAddress` (masked if needed)
- `merchantSigner` (for capture)
- `captureDisposition`
- `latencyMs`

## 7. Agent-Ready Support Automation

Support agent examples:

```bash
curl -sS -H "Authorization: Bearer $GHOST_FULFILLMENT_SUPPORT_SECRET" \
  "https://www.ghostprotocol.cc/api/fulfillment/support/ticket?ticketId=0x..."

curl -sS -H "Authorization: Bearer $GHOST_FULFILLMENT_SUPPORT_SECRET" \
  "https://www.ghostprotocol.cc/api/fulfillment/support/metrics?windowMinutes=120&serviceSlug=agent-18755"
```

Use ticket timeline for single-incident debugging.
Use metrics for agent fleet health checks and alert routing.

## 8. Agent Launch Checklist

1. Gateway config saved and canary verified (`LIVE`).
2. Delegated signer registered and active.
3. Runtime delegated private key set and deployed.
4. Protocol signer key configured in ticket runtime.
5. Authoritative pricing exists for service slug.
6. Retry policy implemented by status/errorCode class.
7. Correlation IDs persisted in agent logs.
8. Support secrets configured for incident tooling.
9. Gateway/API negative-path checks passing:
   - `npm run test:fulfillment:api:negatives`
10. Merchant runtime smoke tests maintained and passing in the merchant-owned repository/deployment pipeline.
