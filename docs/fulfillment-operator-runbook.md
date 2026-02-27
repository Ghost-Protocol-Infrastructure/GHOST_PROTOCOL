# Phase C Fulfillment Operator Runbook

This runbook is for merchant operators running Phase C alpha/beta fulfillment in local and production environments.

## 1) Delegated Signer Setup And Rotation

### Register signer

1. Open merchant dashboard for the target agent, for example:
   - `https://www.ghostprotocol.cc/dashboard?mode=merchant&agentId=18755&owner=0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe`
2. Ensure gateway readiness is `LIVE`.
3. In `Delegated Runtime Signers`, submit signer address + optional label.
4. Verify signer appears with `ACTIVE`.

### Bind runtime key

1. Set `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY` in the runtime environment (local/prod).
2. Restart/redeploy runtime.
3. Confirm capture requests return merchant signer matching the active delegated signer.

### Rotate signer safely

1. Register new signer first (target `2/2` max).
2. Deploy runtime with new delegated private key.
3. Run capture smoke test.
4. Revoke old signer.
5. Confirm old signer can no longer capture (`403 UNAUTHORIZED_DELEGATED_SIGNER`).

## 2) Fulfillment Alpha Local/Prod Test Scripts

All scripts use environment variables. Set `FULFILLMENT_BASE_URL` to local or production target.

### Core scripts

- Happy-path alpha:
  - `npm run test:fulfillment:alpha`
- Merchant-route negatives (missing headers, invalid signature, binding mismatch, expiry path):
  - `npm run test:fulfillment:alpha:negatives`
- API negatives (unauthorized signer, replay, capture conflict):
  - `npm run test:fulfillment:api:negatives`

### Common env

Required:

- `FULFILLMENT_BASE_URL`
- `FULFILLMENT_CONSUMER_PRIVATE_KEY`
- `FULFILLMENT_SERVICE_SLUG` (for Booski: `agent-18755`)
- `FULFILLMENT_PATH` (for alpha route: `/ask`)
- `FULFILLMENT_COST` (default `1`)

Required for merchant capture/replay checks:

- `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY` (or `PHASEC_MERCHANT_DELEGATED_PRIVATE_KEY`)

Optional for explicit unauthorized signer case:

- `FULFILLMENT_UNAUTHORIZED_SIGNER_PRIVATE_KEY`

### Production note

Ticket issuance requires protocol signing in the deployed runtime:

- `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY` must be configured in production.

## 3) Failure Mode Reference

### `HOLD_EXPIRED`

Meaning:

- Hold expired before capture completion.

Typical surfaces:

- Direct capture route: `409 HOLD_EXPIRED`
- Through merchant alpha helper: `502 FULFILLMENT_CAPTURE_REJECTED` with nested capture payload error code `HOLD_EXPIRED`

### Ticket TTL (`FULFILLMENT_TICKET_EXPIRED`)

Meaning:

- Ticket signature window expired before merchant middleware accepted request.

Typical surface:

- Merchant route returns `409 FULFILLMENT_TICKET_EXPIRED`.

### Capture replay (`IDEMPOTENT_REPLAY`)

Meaning:

- Same `ticketId` + same `deliveryProofId` replayed after successful capture.

Expected:

- `200` with `captureDisposition: "IDEMPOTENT_REPLAY"`.

### Capture conflict (`CAPTURE_CONFLICT`)

Meaning:

- Ticket already captured, but replay used a different `deliveryProofId`.

Expected:

- `409 CAPTURE_CONFLICT`.

## 4) Beta Hardening Controls

### Route rate limits

Configured via:

- `GHOST_FULFILLMENT_RATE_LIMIT_WINDOW_MS` (default `60000`)
- `GHOST_FULFILLMENT_RATE_LIMIT_TICKET_PER_WINDOW` (default `120`)
- `GHOST_FULFILLMENT_RATE_LIMIT_CAPTURE_PER_WINDOW` (default `180`)
- `GHOST_FULFILLMENT_RATE_LIMIT_EXPIRE_SWEEP_PER_WINDOW` (default `30`)

Behavior:

- Exceeded limit returns `429 RATE_LIMITED` with `Retry-After` header.

### Observability and alerting

Fulfillment routes now emit structured route response events and alert events.

Log events:

- `fulfillment.route.response`
- `FULFILLMENT_ALERT`

Alert controls:

- `GHOST_FULFILLMENT_ALERT_THRESHOLD_PER_MINUTE` (default `5`)
- `GHOST_FULFILLMENT_ALERT_WINDOW_MS` (default `60000`)

Critical alerts are raised automatically for 5xx and critical fulfillment error codes.

