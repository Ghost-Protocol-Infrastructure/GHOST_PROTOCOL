---
name: openclaw-ghost-pay
description: Discover Ghost payment requirements, execute real x402 calls, report x402 settlements, and run GhostWire quote/prepare/status flows for direct escrow.
version: 1.3.0
metadata: {"clawdis":{"homepage":"https://github.com/Ghost-Protocol-Infrastructure/GHOST_PROTOCOL/tree/main/integrations/openclaw-ghost-pay","os":["darwin","linux","win32"],"requires":{"env":["GHOST_SIGNER_PRIVATE_KEY"],"bins":["node"]},"primaryEnv":"GHOST_SIGNER_PRIVATE_KEY","install":[{"id":"viem","kind":"node","package":"viem","label":"Install viem (required for settlement reporting)"}]}}
---

# OpenClaw Ghost Pay Skill

Use this skill when an agent must:

1. Query authoritative payment requirements for a service.
2. Execute a real `x402` request against a merchant endpoint.
3. Report a verified `x402` settlement back to Ghost for GhostRank.
4. Optionally run GhostWire quote/prepare/status flow for escrow-mode jobs.

This skill executes real `x402` calls and can prepare GhostWire direct escrow jobs for a client wallet.

## Required Environment

- `GHOST_SIGNER_PRIVATE_KEY` (required): trusted signer key for `x402` calls and settlement reporting.
- `GHOST_OPENCLAW_BASE_URL` (optional, default: `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (optional, default: `8453`)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional convenience default)
- `GHOST_OPENCLAW_AGENT_ID` (optional default agent id for settlement reporting)
- `GHOST_OPENCLAW_X402_URL` (optional default merchant endpoint URL for `call-x402.mjs`)
- `GHOST_OPENCLAW_TIMEOUT_MS` (optional, default: `15000`)
- `GHOSTWIRE_CLIENT_ADDRESS` (required for wire quote/create helpers)
- `GHOSTWIRE_APPROVAL_MODE` (optional: `exact` or `unlimited`)

Never put private keys in prompts, code blocks, or frontend output.

## Step 1: Get Payment Requirements via MCP

```bash
node {baseDir}/../../bin/get-payment-requirements.mjs --service agent-18755
```

This calls Ghost read-only MCP (`/api/mcp/read-only`) and resolves `get_payment_requirements`, which returns:

- Express gate endpoint
- chain id
- request cost credits
- Ghost's canonical `x402` metadata block

## Step 2: Execute Real x402 Call

```bash
node {baseDir}/../../bin/call-x402.mjs --url https://merchant.example.com/ask --method POST --body-json "{\"prompt\":\"hello\"}"
```

This helper runs the real `402 -> payment -> retry` flow against the merchant endpoint.

## Step 3: Report Verified x402 Settlement

```bash
node {baseDir}/../../bin/report-x402-settlement.mjs --agent-id 18755 --service agent-18755 --request-id req_123 --payment-reference 0xabc123 --payer-identity 0xpayer --amount-atomic 1000000 --success true --status-code 200
```

## Step 4 (Optional): Create GhostWire Quote

```bash
node {baseDir}/../../bin/get-wire-quote.mjs --client 0x... --provider 0x... --evaluator 0x... --principal-amount 1000000
```

## Step 5 (Optional): Prepare GhostWire Job from Quote

```bash
node {baseDir}/../../bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...
```

## Step 6 (Optional): Poll GhostWire Job Status

```bash
node {baseDir}/../../bin/get-wire-job-status.mjs --job-id wj_... --wait-terminal true
```

## Safe Usage Rules

- Use only against approved Ghost service slugs.
- Do not log signer private keys.
- Prefer `--dry-run true` before first live call in a new runtime.
- Treat any `402` response as an `x402` challenge or payment-policy failure, not transport failure.
