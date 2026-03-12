---
name: openclaw-ghost-pay
description: Discover Ghost payment requirements and execute paid GhostGate calls through x402-compatible EIP-712 envelopes.
metadata: {"author":"Ghost Protocol Infrastructure","version":"0.1.0","runtime":"node","requires_env":["GHOST_SIGNER_PRIVATE_KEY"],"safety":"server-only"}
---

# OpenClaw Ghost Pay Skill

Use this skill when an agent must:

1. Query authoritative payment requirements for a service.
2. Execute a paid request against GhostGate with x402-compatible transport headers.
3. Optionally create and inspect GhostWire quote/job status through MCP wrappers.

This skill executes Express mode payments. GhostWire support here is quote/status helper level only.

## Required Environment

- `GHOST_SIGNER_PRIVATE_KEY` (required): EIP-712 signer key (trusted runtime only).
- `GHOST_OPENCLAW_BASE_URL` (optional, default: `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (optional, default: `8453`)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional convenience default)
- `GHOST_OPENCLAW_TIMEOUT_MS` (optional, default: `15000`)

Never put private keys in prompts, code blocks, or frontend output.

## Step 1: Get Payment Requirements via MCP

```bash
node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755
```

This calls Ghost read-only MCP (`/api/mcp/read-only`) and resolves `get_payment_requirements`, which returns:

- gate endpoint
- chain id
- request cost credits
- x402 compatibility status and scheme

## Step 2: Execute Paid Gate Call (x402 Envelope)

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"
```

This signs the Ghost EIP-712 `Access` payload and wraps it in `payment-signature` with scheme `ghost-eip712-credit-v1`.

## Step 3 (Optional): Create GhostWire Quote

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-quote.mjs --provider 0x... --evaluator 0x... --principal-amount 1000000
```

## Step 4 (Optional): Poll GhostWire Job Status

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-job-status.mjs --job-id wj_... --wait-terminal true
```

## Safe Usage Rules

- Use only against approved Ghost service slugs.
- Do not log signer private keys.
- Prefer `--dry-run true` before first live call in a new runtime.
- Treat any `402` response as expected payment-policy failure, not transport failure.
