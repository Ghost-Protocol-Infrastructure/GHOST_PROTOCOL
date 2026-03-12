# OpenClaw Ghost Pay Quickstart

Copy/paste commands from repo root.

## 1. Discover payment requirements

```bash
node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755
```

## 2. Dry run paid request

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}" --dry-run true
```

## 3. Live paid request

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"
```

## 4. Minimal env (required)

```bash
GHOST_SIGNER_PRIVATE_KEY=0x...
```

## 5. Optional env defaults

```bash
GHOST_OPENCLAW_BASE_URL=https://ghostprotocol.cc
GHOST_OPENCLAW_CHAIN_ID=8453
GHOST_OPENCLAW_TIMEOUT_MS=15000
```

## 6. GhostWire quote helper (optional)

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-quote.mjs --provider 0x... --evaluator 0x... --principal-amount 1000000
```

## 7. GhostWire job status helper (optional)

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-job-status.mjs --job-id wj_...
```
