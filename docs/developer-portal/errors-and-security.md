# Error Handling and Security

Use this guide to implement robust client-side behavior and safe key management.

This page now covers both:

- Gate path (`/api/gate/*`)
- fulfillment path (`/api/fulfillment/*`)

For agent-specific retry/state policy, use:
- `docs/developer-portal/agent-integration-playbook.md`

## Error handling model

Ghost endpoints currently return:

- HTTP status code
- JSON body with numeric `code` and optional `error` string

Example:

```json
{
  "error": "Invalid Signature",
  "code": 401
}
```

## Raw server statuses (current)

| HTTP | Body code | Meaning | Typical fix |
|---|---|---|---|
| `400` | `400` | Missing or malformed auth headers/payload | Rebuild signed headers and JSON payload. |
| `401` | `401` | Signature invalid, expired, or service mismatch | Re-sign payload and confirm `service` path + `chainId`. |
| `402` | `402` | Insufficient credits | Deposit and sync credits. |
| `409` | `409` | Replay detected (nonce reuse) | Generate a fresh nonce and re-sign payload. |
| `500` | `500` | Internal server issue (for example sync failure) | Retry with backoff; inspect logs. |

## Fulfillment error model

Fulfillment routes return:

- HTTP status
- JSON `{ code, error, errorCode, details? }`

### Common fulfillment errors

| HTTP | `errorCode` | Meaning | Typical fix |
|---|---|---|---|
| `400` | `INVALID_TICKET_REQUEST` / `INVALID_CAPTURE_REQUEST` | malformed request shape | Rebuild request payload. |
| `400` | `COST_MISMATCH` | requested cost differs from signed/authoritative pricing | Use authoritative cost and regenerate signature. |
| `401` | `INVALID_CONSUMER_SIGNATURE` / `INVALID_MERCHANT_SIGNATURE` | invalid EIP-712 signature | Re-sign with correct key/domain. |
| `401` | `UNAUTHORIZED` | support/sweep secret missing or incorrect | Set proper bearer secret. |
| `402` | `INSUFFICIENT_CREDITS` | wallet lacks available credits | Deposit/sync credits and retry. |
| `403` | `UNAUTHORIZED_DELEGATED_SIGNER` | capture signer is not active for gateway | Register signer or update runtime key. |
| `409` | `REPLAY` | ticket auth nonce replay | Generate fresh nonce and re-sign. |
| `409` | `HOLD_CAP_EXCEEDED` | active hold already exists or wallet cap reached | capture/release existing hold, then retry. |
| `409` | `HOLD_EXPIRED` | capture arrived after hold expiry | request new ticket and complete within TTL. |
| `409` | `CAPTURE_CONFLICT` | captured already with different delivery proof ID | treat as terminal conflict, do not retry same path. |
| `423` | `SERVICE_NOT_LIVE` | gateway not verified/live | pass canary verification and reach `LIVE`. |
| `429` | `RATE_LIMITED` | route-level rate limit triggered | honor `Retry-After` and backoff. |
| `500` | `FULFILLMENT_SIGNER_NOT_CONFIGURED` | protocol signer key missing in runtime | set `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY`. |

## Normalized client error codes (recommended)

For SDKs and dashboards, use a stable normalized map:

| Normalized code | Map from | Meaning |
|---|---|---|
| `GHOST_400` | HTTP `400` | Bad request headers/payload |
| `GHOST_401` | HTTP `401` | Signature invalid/expired/service mismatch |
| `GHOST_402` | HTTP `402` | Credits required |
| `GHOST_409` | HTTP `409` | Replay detected |
| `GHOST_403` | Reserved | Auth forbidden by policy (future use) |
| `GHOST_429` | Reserved | Rate/cap guardrail (future use) |
| `GHOST_500` | HTTP `500` | Internal processing failure |

> [!NOTE]
> `GHOST_403` and `GHOST_429` are documented as forward-compatible normalized codes. They are not currently emitted directly by the gate route.

## Wallet and private key security

### Do

- Keep signer keys in environment variables.
- Use separate keys for dev, staging, and production.
- Rotate keys on suspected compromise.
- Limit process and CI access to secret values.

### Do not

- Commit keys to git.
- Log full private keys or full signatures in production.
- Hardcode secrets in frontend bundles.

> [!IMPORTANT]
> Never expose `GHOST_SIGNER_PRIVATE_KEY` in browser code. Sign server-side or in trusted runtime only.

### Additional fulfillment secrets

- `GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY`
- `GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY`
- `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET`
- `GHOST_FULFILLMENT_SUPPORT_SECRET`

Treat all four as runtime secrets. Do not expose them in frontend bundles or commit history.

## `.env` example

```bash
GHOST_API_KEY=sk_live_your_api_key
GHOST_SIGNER_PRIVATE_KEY=0xyour_private_key
GHOST_BASE_URL=https://ghostprotocol.cc
```

## Retry strategy

Use bounded retries for network and `5xx` only:

1. Retry up to 3 times.
2. Use exponential backoff (250ms, 500ms, 1000ms).
3. Do not retry `401`, `402`, or `409` blindly.

For fulfillment:
- Retry `429` only after `Retry-After`.
- Do not retry terminal state conflicts (`CAPTURE_CONFLICT`, `HOLD_NOT_ACTIVE`) as transient errors.

## Signature troubleshooting checklist

1. Confirm payload `service` matches route slug exactly.
2. Confirm `timestamp` is current (within replay window).
3. Confirm `chainId = 8453`.
4. Confirm EIP-712 domain:
   - `name = GhostGate`
   - `version = 1`
5. Confirm payload fields:
   - `service` (string)
   - `timestamp` (uint256)
   - `nonce` (string)
