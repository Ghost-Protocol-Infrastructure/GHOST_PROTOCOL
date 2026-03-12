# OpenClaw Ghost Pay Install

## Requirements

- Node.js 20+ runtime
- Trusted server/runtime environment
- `GHOST_SIGNER_PRIVATE_KEY` set as a secret

## 1. Install dependencies

From the repository root:

```bash
npm install
```

If installing package-only:

```bash
cd integrations/openclaw-ghost-pay
npm install
```

## 2. Set runtime env

Required:

```bash
GHOST_SIGNER_PRIVATE_KEY=0x...
```

Optional:

```bash
GHOST_OPENCLAW_BASE_URL=https://ghostprotocol.cc
GHOST_OPENCLAW_CHAIN_ID=8453
GHOST_OPENCLAW_SERVICE_SLUG=agent-18755
GHOST_OPENCLAW_TIMEOUT_MS=15000
GHOSTWIRE_PROVIDER_ADDRESS=0x...
GHOSTWIRE_EVALUATOR_ADDRESS=0x...
GHOSTWIRE_PRINCIPAL_AMOUNT=1000000
GHOSTWIRE_CLIENT_ADDRESS=0x...
GHOSTWIRE_SPEC_HASH=0x...
GHOSTWIRE_EXEC_SECRET=...
```

## 3. Register plugin in OpenClaw/ClawHub

Use the package root:

```json
{
  "plugins": {
    "ghost-protocol-openclaw": {
      "path": "./integrations/openclaw-ghost-pay",
      "enabled": true,
      "skills": {
        "entries": {
          "openclaw-ghost-pay": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

## 4. Validate installation

```bash
node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755
```

If that succeeds, run paid dry run:

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}" --dry-run true
```

Optional GhostWire wrappers:

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-quote.mjs --provider 0x... --evaluator 0x... --principal-amount 1000000
```

```bash
node integrations/openclaw-ghost-pay/bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...
```

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-job-status.mjs --job-id wj_...
```
