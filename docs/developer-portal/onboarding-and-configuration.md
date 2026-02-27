# Onboarding and Configuration (Gate + Fulfillment)

This guide documents the current onboarding path for the live codebase, including Phase C fulfillment.

## 1. Choose Integration Path

Ghost Protocol currently supports two production paths:

1. `Gate path` (signature-gated API access)
   - Endpoint family: `/api/gate/[service]`
   - Use this when you only need authorization + credit debit.
2. `Phase C fulfillment path` (ticket -> merchant runtime -> capture)
   - Endpoint family: `/api/fulfillment/*`
   - Use this when consumers execute merchant-owned runtimes through Ghost Protocol settlement.

## 2. Merchant Onboarding (Phase C)

Complete these steps in order for each merchant agent.

1. Configure gateway endpoint and canary
   - Dashboard (`/dashboard?mode=merchant&agentId=<id>&owner=<ownerAddress>`) or API:
     - `POST /api/agent-gateway/config`
   - Set:
     - `endpointUrl` to merchant base endpoint (for alpha pilot: `https://www.ghostprotocol.cc/api/fulfillment-alpha/booski`)
     - `canaryPath` as relative path (recommended: `/canary`)
2. Verify canary and set readiness to `LIVE`
   - Dashboard `Verify Gateway` or API:
     - `POST /api/agent-gateway/verify`
   - Service remains blocked at ticket issuance until `readinessStatus=LIVE`.
3. Register delegated signer
   - Dashboard `Delegated Runtime Signers` or API:
     - `POST /api/agent-gateway/delegated-signers/register`
   - Max active delegated signers is `2`.
4. Bind delegated signer private key in merchant runtime
   - Set `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY`.
5. Configure authoritative pricing
   - Ensure `ServicePricing` exists and is active for `serviceSlug`.
6. Configure protocol signer in gateway runtime
   - Set `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY`.
7. Configure operator secrets
   - `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET`
   - `GHOST_FULFILLMENT_SUPPORT_SECRET`

## 3. Consumer Onboarding (Phase C)

1. Fund credits (consumer wallet must have spendable credits).
2. Set consumer runtime signer:
   - `FULFILLMENT_CONSUMER_PRIVATE_KEY`
3. Set ticket request bindings:
   - `FULFILLMENT_BASE_URL`
   - `FULFILLMENT_SERVICE_SLUG` (`agent-<agentId>`)
   - `FULFILLMENT_PATH` (for Booski alpha: `/ask`)
   - `FULFILLMENT_COST`

## 4. Environment Variable Matrix

### 4.1 Required for Phase C core flow

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY` | `/api/fulfillment/ticket` | Yes (ticket issuance) | If missing, ticket route returns `500 FULFILLMENT_SIGNER_NOT_CONFIGURED`. |
| `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY` | Merchant runtime capture helper | Yes (merchant capture) | Merchant delegated signer must also be registered as `ACTIVE`. |
| `GHOST_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES` | Merchant ticket verification | Optional | Comma-separated allowlist. If unset, merchant alpha route derives address from protocol signer private key. |
| `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET` | `/api/fulfillment/expire-sweep` | Yes (operator sweep) | Supports bearer auth (`Authorization: Bearer ...`). |
| `GHOST_FULFILLMENT_SUPPORT_SECRET` | `/api/fulfillment/support/*` | Yes (support tooling) | Supports bearer auth or `x-ghost-fulfillment-support-secret`. |

### 4.2 Optional fulfillment controls

| Variable | Default | Purpose |
|---|---|---|
| `GHOST_FULFILLMENT_HOLD_TTL_MS` | `60000` | Hold TTL used in ticket issuance. |
| `GHOST_FULFILLMENT_WALLET_HOLD_CAP` | `3` | Max active held tickets per wallet. |
| `GHOST_FULFILLMENT_RATE_LIMIT_WINDOW_MS` | `60000` | Shared rate-limit window. |
| `GHOST_FULFILLMENT_RATE_LIMIT_TICKET_PER_WINDOW` | `120` | Ticket route limit. |
| `GHOST_FULFILLMENT_RATE_LIMIT_CAPTURE_PER_WINDOW` | `180` | Capture route limit. |
| `GHOST_FULFILLMENT_RATE_LIMIT_EXPIRE_SWEEP_PER_WINDOW` | `30` | Expire-sweep route limit. |
| `GHOST_FULFILLMENT_ALERT_THRESHOLD_PER_MINUTE` | `5` | Alert threshold for repeated fulfillment errors. |
| `GHOST_FULFILLMENT_ALERT_WINDOW_MS` | `60000` | Alert rolling window. |

## 5. Production Readiness Checks

1. Confirm gateway config and readiness:

```bash
curl -sS "https://www.ghostprotocol.cc/api/agent-gateway/config?agentId=<agentId>&includeHistory=1&historyLimit=5"
```

2. Confirm canary contract endpoint:

```bash
curl -sS "https://www.ghostprotocol.cc/api/fulfillment-alpha/booski/canary"
```

Expected shape:

```json
{"ghostgate":"ready","service":"agent-18755"}
```

3. Run fulfillment smoke tests:

```bash
npm run test:fulfillment:alpha
npm run test:fulfillment:alpha:negatives
npm run test:fulfillment:api:negatives
```

4. Validate support endpoints with a real ticket ID:

```bash
curl -sS -H "Authorization: Bearer $GHOST_FULFILLMENT_SUPPORT_SECRET" \
  "https://www.ghostprotocol.cc/api/fulfillment/support/ticket?ticketId=0x..."
```

## 6. Common Misconfigurations

| Symptom | Cause | Fix |
|---|---|---|
| `423 SERVICE_NOT_LIVE` | Gateway not `LIVE` | Re-run canary verify; ensure canary path/response are correct. |
| `500 FULFILLMENT_SIGNER_NOT_CONFIGURED` | Missing protocol signer key in runtime | Set `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY` and redeploy. |
| `403 UNAUTHORIZED_DELEGATED_SIGNER` | Capture signer not registered or revoked | Register signer and ensure runtime key matches active signer. |
| `409 HOLD_CAP_EXCEEDED` | Existing active hold for wallet/service or wallet cap reached | Capture/release outstanding hold; wait for expiry/sweep. |
| `401 UNAUTHORIZED` on support/sweep | Secret missing or mismatched | Set correct secret in runtime and caller shell/session. |
