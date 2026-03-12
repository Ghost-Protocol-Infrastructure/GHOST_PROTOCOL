# Onboarding and Configuration (Gate + Fulfillment)

This guide documents the current onboarding path for the live codebase, including fulfillment.

For autonomous runtime behavior patterns (retry/idempotency/state handling), also read:
- `docs/developer-portal/agent-integration-playbook.md`
- `docs/developer-portal/security-and-shared-responsibility.md`

## 1. Choose Integration Path

Ghost Protocol currently supports two production paths:

1. `Gate path` (signature-gated API access)
   - Endpoint family: `/api/gate/[service]`
   - Use this when you only need authorization + credit debit.
2. `Fulfillment path` (ticket -> merchant runtime -> capture)
   - Endpoint family: `/api/fulfillment/*`
   - Use this when consumers execute merchant-owned runtimes through Ghost Protocol settlement.

## 2. Merchant Onboarding (Fulfillment)

Complete these steps in order for each merchant agent.

1. Configure gateway endpoint and canary
   - Dashboard (`/dashboard?mode=merchant&agentId=<id>&owner=<ownerAddress>`) or API:
     - `POST /api/agent-gateway/config`
   - Set:
     - `endpointUrl` to the merchant-owned base endpoint (for example: `https://merchant.example.com`)
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

## 3. Consumer Onboarding (Fulfillment)

1. Fund credits (consumer wallet must have spendable credits).
2. Set consumer runtime signer:
   - `FULFILLMENT_CONSUMER_PRIVATE_KEY`
3. Set ticket request bindings:
   - `FULFILLMENT_BASE_URL`
   - `FULFILLMENT_SERVICE_SLUG` (`agent-<agentId>`)
   - `FULFILLMENT_PATH` (merchant-bound request path, commonly `/ask`)
   - `FULFILLMENT_COST`

## 4. Environment Variable Matrix

### 4.1 Required for fulfillment core flow

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY` | `/api/fulfillment/ticket` | Yes (ticket issuance) | If missing, ticket route returns `500 FULFILLMENT_SIGNER_NOT_CONFIGURED`. |
| `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY` | Merchant runtime capture helper | Yes (merchant capture) | Merchant delegated signer must also be registered as `ACTIVE`. |
| `GHOST_FULFILLMENT_PROTOCOL_SIGNER_ADDRESSES` | Merchant ticket verification | Optional | Advanced/self-hosted override only. On Ghost-hosted production, leave this unset and use the Ghost SDK default signer set (`0xf879f5e26aa52663887f97a51d3444afef8df3fc`). Only set it if you run a custom ticket issuer or Ghost explicitly instructs you during signer rotation. |
| `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET` | `/api/fulfillment/expire-sweep` | Yes (operator sweep) | Supports bearer auth (`Authorization: Bearer ...`). |
| `GHOST_FULFILLMENT_SUPPORT_SECRET` | `/api/fulfillment/support/*` | Yes (support tooling) | Supports bearer auth or `x-ghost-fulfillment-support-secret`. |

### 4.2 Optional fulfillment controls

| Variable | Default | Purpose |
|---|---|---|
| `GHOST_FULFILLMENT_HOLD_TTL_MS` | `60000` | Hold TTL used in ticket issuance. |
| `GHOST_FULFILLMENT_WALLET_HOLD_CAP` | `3` | Max active held tickets per wallet. Legacy alias `GHOST_FULFILLMENT_WALLET_SERVICE_HOLD_CAP` is still honored for backwards compatibility. |
| `GHOST_FULFILLMENT_RATE_LIMIT_WINDOW_MS` | `60000` | Shared rate-limit window. |
| `GHOST_FULFILLMENT_RATE_LIMIT_TICKET_PER_WINDOW` | `120` | Ticket route limit. |
| `GHOST_FULFILLMENT_RATE_LIMIT_CAPTURE_PER_WINDOW` | `180` | Capture route limit. |
| `GHOST_FULFILLMENT_RATE_LIMIT_EXPIRE_SWEEP_PER_WINDOW` | `30` | Expire-sweep route limit. |
| `GHOST_FULFILLMENT_RATE_LIMIT_GATE_PER_WINDOW` | `240` | Gate route limit (`/api/gate/*`). |
| `GHOST_FULFILLMENT_ALERT_THRESHOLD_PER_MINUTE` | `5` | Alert threshold for repeated fulfillment errors. |
| `GHOST_FULFILLMENT_ALERT_WINDOW_MS` | `60000` | Alert rolling window. |

### 4.3 Settlement operator/support secrets

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `GHOST_SETTLEMENT_OPERATOR_SECRET` | `/api/admin/settlement/allocate`, `/api/admin/settlement/reconcile`, `/api/admin/settlement/operator-health`, `/api/admin/vault/preflight` | Yes (hosted settlement automation) | Dedicated secret required. No fallback secret path. |
| `GHOST_SETTLEMENT_SUPPORT_SECRET` | `/api/admin/settlement/metrics` | Recommended for ops/support | Supports bearer auth or `x-ghost-settlement-support-secret`. |

## 5. Production Readiness Checks

1. Confirm gateway config and readiness:

```bash
curl -sS "https://www.ghostprotocol.cc/api/agent-gateway/config?agentId=<agentId>&includeHistory=1&historyLimit=5"
```

2. Confirm canary contract endpoint on the merchant runtime:

```bash
curl -sS "https://merchant.example.com/canary"
```

Expected shape:

```json
{"ghostgate":"ready","service":"agent-18755"}
```

3. Run gateway/API smoke tests from this repo:

```bash
npm run test:fulfillment:api:negatives
```

4. Run merchant-runtime smoke tests from the merchant runtime repository or deployment pipeline.

5. Validate support endpoints with a real ticket ID:

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

Signer note:
- The current Ghost production fulfillment signer address is `0xf879f5e26aa52663887f97a51d3444afef8df3fc`.
- Treat it as a public verification allowlist entry, not as a secret.
- On Ghost-hosted production, normal merchants should not replace it with their own signer.
- Only set your own protocol signer allowlist if you run a self-hosted/custom ticket issuer for your own environment.

## 7. Agent-Focused Onboarding Notes

If your primary integration target is AI agents (consumer or merchant):

1. Implement strict status/errorCode class handling, not generic retries.
2. Persist and reuse `deliveryProofId` for safe capture replay.
3. Log `ticketId` and `clientRequestId` on every step for support diagnostics.
4. Add support endpoint lookups to your automated incident response flow.
