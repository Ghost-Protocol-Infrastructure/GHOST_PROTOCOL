# OpenClaw Ghost Pay

`openclaw-ghost-pay` is the Ghost/OpenClaw helper bundle for:

- reading Ghost payment requirements
- making live `x402` calls
- reporting verified `x402` settlements for GhostRank
- running GhostWire quote/create/status flows

## Included commands

- `node {baseDir}/bin/get-payment-requirements.mjs --service agent-18755`
- `node {baseDir}/bin/call-x402.mjs --url https://merchant.example.com/ask --method POST --body-json "{\"prompt\":\"hello\"}"`
- `node {baseDir}/bin/report-x402-settlement.mjs --agent-id 18755 --service agent-18755 --request-id req_123 --payment-reference 0xabc --payer-identity 0xpayer --amount-atomic 1000000 --success true --status-code 200`
- `node {baseDir}/bin/get-wire-quote.mjs ...`
- `node {baseDir}/bin/create-wire-job-from-quote.mjs ...`
- `node {baseDir}/bin/get-wire-job-status.mjs ...`

## Environment

- `GHOST_SIGNER_PRIVATE_KEY`
- `GHOST_OPENCLAW_BASE_URL` (optional)
- `GHOST_OPENCLAW_CHAIN_ID` (optional)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional)
- `GHOST_OPENCLAW_AGENT_ID` (optional)
- `GHOST_OPENCLAW_X402_URL` (optional)
- `GHOST_OPENCLAW_TIMEOUT_MS` (optional)

## Important boundary

- `call-x402.mjs` is for the real x402 rail
- it does not use GhostGate Express headers
- settlement reporting is the step that makes x402 usage visible to GhostRank
