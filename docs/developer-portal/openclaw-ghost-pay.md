# OpenClaw Ghost Pay

Ghost Protocol includes an OpenClaw skill bundle at:

- `integrations/openclaw-ghost-pay`

For ClawHub publication, publish the folder root so the helper scripts ship with the skill bundle, not just the `SKILL.md` file.

## What it does

1. Uses Ghost read-only MCP to query `get_payment_requirements`:
   - `node {baseDir}/bin/get-payment-requirements.mjs --service agent-18755`
2. Signs Ghost EIP-712 access payloads and wraps them in x402-compatible `payment-signature` headers:
   - `node {baseDir}/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"`
3. Provides GhostWire quote/create/status tooling:
   - `node {baseDir}/bin/get-wire-quote.mjs --provider 0x... --evaluator 0x... --principal-amount 1000000`
   - `node {baseDir}/bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...`
   - `node {baseDir}/bin/get-wire-job-status.mjs --job-id wj_...`

Express mode is executable end-to-end in this package. GhostWire execution uses guarded API access (`GHOSTWIRE_EXEC_SECRET`) with operator-side policy controls.

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
- `GHOSTWIRE_EXEC_SECRET` (required for wire create command)

Use trusted runtime secrets only.

## Docs

- Install guide: `integrations/openclaw-ghost-pay/INSTALL.md`
- Copy/paste quickstart: `integrations/openclaw-ghost-pay/QUICKSTART.md`
- Publish path: `integrations/openclaw-ghost-pay`
