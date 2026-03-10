# OpenClaw Ghost Pay

This package bridges OpenClaw agents to Ghost Protocol's existing stack:

- Discovery + pricing via read-only MCP (`/api/mcp/read-only`)
- Paid gate requests via x402-compatible `payment-signature` envelopes

No protocol settlement behavior is added here. This package only wraps existing Ghost API behavior.

## Contents

- `openclaw.plugin.json` - plugin descriptor with local skill path
- `skills/openclaw-ghost-pay/SKILL.md` - skill instructions for OpenClaw
- `bin/get-payment-requirements.mjs` - MCP-based payment requirement lookup
- `bin/pay-gate-x402.mjs` - EIP-712 signer + x402 header wrapper for gate calls

## Usage

From repo root:

```bash
node integrations/openclaw-ghost-pay/bin/get-payment-requirements.mjs --service agent-18755
```

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}" --dry-run true
```

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json "{\"prompt\":\"hello\"}"
```

## Environment

- `GHOST_SIGNER_PRIVATE_KEY` (required for paid call)
- `GHOST_OPENCLAW_BASE_URL` (default: `https://ghostprotocol.cc`)
- `GHOST_OPENCLAW_CHAIN_ID` (default: `8453`)
- `GHOST_OPENCLAW_SERVICE_SLUG` (optional fallback service)
- `GHOST_OPENCLAW_TIMEOUT_MS` (default: `15000`)

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

- Name: Ghost Protocol - Instant x402 Payments
- Short Description: Equip your OpenClaw agent to pay for API access with Ghost Credits via x402-compatible headers. Production benchmark: 100% success, p50 210.5ms, p95 402.4ms.
- Long Description: Ghost Protocol gives OpenClaw agents a low-latency payment path for paywalled APIs. Agents read payment requirements, sign EIP-712 authorization tickets, and send x402-compatible `payment-signature` headers through GhostGate. This package is transport compatibility for x402-style envelopes and uses Ghost Protocol settlement underneath.

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
