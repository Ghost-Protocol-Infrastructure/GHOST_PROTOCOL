# Error Handling and Security

Use this guide to implement robust client-side behavior and safe key management.

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
| `500` | `500` | Internal server issue (for example sync failure) | Retry with backoff; inspect logs. |

## Normalized client error codes (recommended)

For SDKs and dashboards, use a stable normalized map:

| Normalized code | Map from | Meaning |
|---|---|---|
| `GHOST_400` | HTTP `400` | Bad request headers/payload |
| `GHOST_401` | HTTP `401` | Signature invalid/expired/service mismatch |
| `GHOST_402` | HTTP `402` | Credits required |
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
3. Do not retry `401` or `402` blindly.

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

