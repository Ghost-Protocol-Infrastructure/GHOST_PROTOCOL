# OpenClaw Ghost Pay

This package bridges OpenClaw agents to Ghost Protocol's existing stack:

- Discovery + pricing via read-only MCP (`/api/mcp/read-only`)
- Real `x402` calls against merchant endpoints
- Merchant settlement reporting for GhostRank
- GhostWire quote + direct job-prepare + job-status flows for escrow-mode workflows

This bundle does not use the removed GhostGate x402-compat envelope. `call-x402.mjs` runs the real `402 -> payment -> retry` flow, and `report-x402-settlement.mjs` is the step that makes successful `x402` usage visible to GhostRank.

## ClawHub publish path

If you want a real ClawHub bundle with helper scripts included, publish the folder root:

```bash
clawhub publish ./integrations/openclaw-ghost-pay --slug openclaw-ghost-pay --name "Ghost Protocol OpenClaw Pay" --version 1.3.0 --tags latest,agents,eip712,ghostprotocol,ghostwire,mcp,openclaw,payments,x402
```

Do not rely on a web-form-only publish if it only captures `SKILL.md`; the installable bundle needs the helper scripts under `bin/`.

If `clawhub` returns `fetch failed` from this machine/network, run the bundled wrapper that applies the registry DNS shim:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/clawhub.ps1 whoami
powershell -ExecutionPolicy Bypass -File ./scripts/clawhub.ps1 publish ./integrations/openclaw-ghost-pay --slug openclaw-ghost-pay --name "Ghost Protocol OpenClaw Pay" --version 1.3.0 --tags latest,agents,eip712,ghostprotocol,ghostwire,mcp,openclaw,payments,x402
```

## Contents

- `openclaw.plugin.json` - plugin descriptor with local skill path
- `skills/openclaw-ghost-pay/SKILL.md` - skill instructions for OpenClaw
- `bin/get-payment-requirements.mjs` - MCP-based payment requirement lookup
- `bin/call-x402.mjs` - real `x402` client helper for merchant endpoints
- `bin/report-x402-settlement.mjs` - merchant-signed settlement report helper for GhostRank
- `bin/get-wire-quote.mjs` - MCP wrapper for GhostWire quote creation
- `bin/create-wire-job-from-quote.mjs` - direct GhostWire job preparation from an issued quote
- `bin/get-wire-job-status.mjs` - MCP wrapper for GhostWire job status polling

## Usage

From repo root:

```bash
node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755
```

```bash
node integrations/openclaw-ghost-pay/bin/call-x402.mjs --url https://merchant.example.com/ask --method POST --body-json "{\"prompt\":\"hello\"}" --dry-run true
```

```bash
node integrations/openclaw-ghost-pay/bin/call-x402.mjs --url https://merchant.example.com/ask --method POST --body-json "{\"prompt\":\"hello\"}"
```

```bash
node integrations/openclaw-ghost-pay/bin/report-x402-settlement.mjs --agent-id 18755 --service agent-18755 --request-id req_123 --payment-reference 0xabc123 --payer-identity 0xpayer --amount-atomic 1000000 --success true --status-code 200
```

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-quote.mjs --client 0x... --provider 0x... --evaluator 0x... --principal-amount 1000000
```

```bash
node integrations/openclaw-ghost-pay/bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...
```

```bash
node integrations/openclaw-ghost-pay/bin/get-wire-job-status.mjs --job-id wj_...
```

## Environment

- `GHOST_SIGNER_PRIVATE_KEY` (required for paid call)
- `GHOST_OPENCLAW_BASE_URL` (default: `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (default: `8453`)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional fallback service)
- `GHOST_OPENCLAW_AGENT_ID` (optional fallback agent id for settlement reporting)
- `GHOST_OPENCLAW_TIMEOUT_MS` (default: `15000`)
- `GHOST_OPENCLAW_X402_URL` (optional fallback merchant endpoint URL for `call-x402.mjs`)
- `GHOSTWIRE_PROVIDER_ADDRESS` (optional default for `get-wire-quote`)
- `GHOSTWIRE_EVALUATOR_ADDRESS` (optional default for `get-wire-quote`)
- `GHOSTWIRE_PRINCIPAL_AMOUNT` (optional default for `get-wire-quote`)
- `GHOSTWIRE_CLIENT_ADDRESS` (optional default for wire create)
- `GHOSTWIRE_SPEC_HASH` (optional default for wire create, required by API)
- `GHOSTWIRE_METADATA_URI` (optional)
- `GHOSTWIRE_WEBHOOK_URL` + `GHOSTWIRE_WEBHOOK_SECRET` (optional pair)
- `GHOSTWIRE_APPROVAL_MODE` (optional: `exact` or `unlimited`)

## OpenClaw Registration

Point OpenClaw/ClawHub at this package path and enable the skill entry. Example shape (adapt to your runtime config schema):

```json
{
  "plugins": {
    "ghost-protocol-openclaw": {
      "path": "./integrations/openclaw-ghost-pay",
      "enabled": true,
      "skills": {
        "entries": {
          "openclaw-ghost-pay": {
            "enabled": true,
            "env": {
              "GHOST_OPENCLAW_BASE_URL": "https://ghostprotocol.cc",
              "GHOST_OPENCLAW_CHAIN_ID": "8453"
            }
          }
        }
      }
    }
  }
}
```

Keep `GHOST_SIGNER_PRIVATE_KEY` in runtime secret storage, not in config files.

## Install Docs

- [INSTALL.md](./INSTALL.md)
- [QUICKSTART.md](./QUICKSTART.md)

## OpenClaw Registry Submission Payload

Use this copy when submitting `openclaw-ghost-pay` to directories.

- Display Name: Ghost Protocol OpenClaw Pay
- Slug: openclaw-ghost-pay
- Version: 1.3.0
- Short Description: Discover Ghost payment requirements, execute real x402 calls, report verified x402 settlements, and prepare GhostWire direct escrow jobs.
- Long Description: Ghost Protocol gives OpenClaw agents one bundle for GhostGate Express discovery, open x402 execution, x402 settlement reporting for GhostRank, and GhostWire direct escrow prep. Agents can discover pricing requirements, call merchant x402 endpoints, report verified settlements back to Ghost, and prepare GhostWire quote/status flows from a single skill bundle. The ClawHub bundle includes the helper scripts it references and requires a trusted server-side signer key.

Verified production benchmark:

- p50 Latency: 210.5ms
- Success Rate: 100% (under 10x concurrency load)
- Replay Protection: 409 rejection on replay attempts.

## Performance & Benchmarks
GhostGate processes cryptographic signatures and debits off-chain in milliseconds.

**Latest Production Benchmark (March 9, 2026):**
* **Target:** `https://ghostprotocol.cc`
* **Load:** 250 iterations, 10 concurrency
* **Success Rate:** 100%
* **p50 Latency:** 210.5ms
* **p95 Latency:** 402.4ms

<details>
<summary>View Raw Benchmark Artifact (JSON)</summary>

```json
{
  "scenario": "gate",
  "total": 250,
  "successes": 250,
  "failures": 0,
  "successRate": 100,
  "latencyMs": {
    "avg": 271.89,
    "p50": 210.5,
    "p95": 402.43
  }
}
```
</details>
