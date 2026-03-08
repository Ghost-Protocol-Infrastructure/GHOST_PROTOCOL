# OpenClaw Ghost Pay (Local Build)

Ghost Protocol includes a local OpenClaw skill package at:

- `integrations/openclaw-ghost-pay`

This package is intentionally **not published** yet. It is for local validation and iteration.

## What it does

1. Uses Ghost read-only MCP to query `get_payment_requirements`:
   - `node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755`
2. Signs Ghost EIP-712 access payloads and wraps them in x402-compatible `payment-signature` headers:
   - `node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"`

## Why this is safe

- No settlement path changes.
- No vault changes.
- No new protocol trust assumptions.
- Uses the same GhostGate auth semantics already in production.

## Environment

- `GHOST_SIGNER_PRIVATE_KEY` (required for paid calls)
- `GHOST_OPENCLAW_BASE_URL` (default `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (default `8453`)
- `GHOST_OPENCLAW_TIMEOUT_MS` (default `15000`)

Use trusted runtime secrets only.
