---
name: openclaw-ghost-pay
description: Discover Ghost payment requirements, execute GhostGate Express payments, and run GhostWire quote/create/status flows with execution controls.
version: 1.2.2
metadata: {"clawdis":{"emoji":"👻","homepage":"https://github.com/Ghost-Protocol-Infrastructure/GHOST_PROTOCOL/tree/main/integrations/openclaw-ghost-pay","os":["darwin","linux","win32"],"requires":{"env":["GHOST_SIGNER_PRIVATE_KEY"],"bins":["node"]},"primaryEnv":"GHOST_SIGNER_PRIVATE_KEY","install":[{"id":"viem","kind":"node","package":"viem","label":"Install viem (required for GhostGate EIP-712 signing)"}]}}
---

# OpenClaw Ghost Pay

Use this skill when an OpenClaw agent must:

1. Discover Ghost payment requirements for a service.
2. Execute a GhostGate paid request with a signed `payment-signature` envelope.
3. Optionally run Hosted GhostWire quote/create/status flows.

This published skill bundle includes the helper scripts it references. Use `{baseDir}` when invoking them so the commands work after `clawhub install openclaw-ghost-pay`.

## Required environment

- `GHOST_SIGNER_PRIVATE_KEY` (required): trusted EIP-712 signer key for GhostGate Express requests.

Optional:

- `GHOST_OPENCLAW_BASE_URL` (default: `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (default: `8453`)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional default service slug)
- `GHOST_OPENCLAW_TIMEOUT_MS` (default: `15000`)
- `GHOSTWIRE_EXEC_SECRET` (required only for Hosted GhostWire job creation)
- `GHOSTWIRE_PROVIDER_ADDRESS`
- `GHOSTWIRE_EVALUATOR_ADDRESS`
- `GHOSTWIRE_PRINCIPAL_AMOUNT`
- `GHOSTWIRE_CLIENT_ADDRESS`
- `GHOSTWIRE_SPEC_HASH`
- `GHOSTWIRE_METADATA_URI`

Never put private keys in prompts, plaintext config screenshots, or frontend output.

## Express flow

### 1. Get payment requirements

```bash
node {baseDir}/bin/get-payment-requirements.mjs --service agent-18755
```

This calls Ghost read-only MCP and resolves:

- gate endpoint
- chain id
- request cost credits
- x402 compatibility status and scheme

### 2. Dry run a paid request

```bash
node {baseDir}/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}" --dry-run true
```

### 3. Execute a live paid request

```bash
node {baseDir}/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"
```

This signs the Ghost EIP-712 `Access` payload and wraps it in `payment-signature` using scheme `ghost-eip712-credit-v1`.

## Hosted GhostWire flow

### 4. Get a GhostWire quote

```bash
node {baseDir}/bin/get-wire-quote.mjs --provider 0x... --evaluator 0x... --principal-amount 1000000
```

### 5. Create a GhostWire job from a quote

```bash
node {baseDir}/bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...
```

### 6. Poll GhostWire job status

```bash
node {baseDir}/bin/get-wire-job-status.mjs --job-id wj_... --wait-terminal true
```

## Safe usage rules

- Use only against approved Ghost service slugs and merchant-approved GhostWire roles.
- Do not log signer private keys or `GHOSTWIRE_EXEC_SECRET`.
- Prefer `--dry-run true` before the first live paid request in a new runtime.
- Treat `402` as a payment-policy failure, not a transport failure.
- Treat GhostWire create access as privileged operator-path execution.
