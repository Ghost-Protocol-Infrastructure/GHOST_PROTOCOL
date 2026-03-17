# GhostGate x402 Compatibility

GhostGate supports an optional x402-compatible transport mode for Gate requests.

This page documents the current production shape.

## Current status

- GhostGate x402 compatibility is implemented behind `GHOST_GATE_X402_ENABLED`.
- The default Gate path remains Ghost Protocol's EIP-712 credit flow.
- `GET /api/pricing?service=<service_slug>` is the canonical source for x402 compatibility metadata.
- GhostWire does **not** use x402. GhostWire remains a separate `/api/wire/*` direct escrow flow.
- The canonical demo target is `x402-demo` on `/api/gate/x402-demo`.
- Phase A is complete in code: docs, metadata contract, SDK guidance, and demo target implementation are all in place.

Use x402 mode when you want GhostGate to speak a more standard HTTP `402 Payment Required` machine-to-machine shape.

Do **not** treat x402 mode as a separate settlement rail. Ghost EIP-712 credits remain the underlying fast authorization path.

## What x402 compatibility means in GhostGate

When x402 mode is enabled:

- the client can send `payment-signature` instead of `x-ghost-sig` + `x-ghost-payload`
- missing or invalid payment envelopes can return `402` with `payment-required`
- successful authorization can return `payment-response`

GhostGate is still doing:

- EIP-712 signing
- credit checks
- off-chain credit accounting
- Ghost-native request authorization

So the practical model is:

- x402 = HTTP transport compatibility
- GhostGate = the actual authorization + credit rail

## Check pricing first

Before attempting x402 mode, check:

```text
GET /api/pricing?service=<service_slug>
```

This is the canonical compatibility contract for clients.

Relevant response fields:

- `x402CompatibilityEnabled`
- `x402Scheme`

Example:

```bash
curl -sS "https://ghostprotocol.cc/api/pricing?service=x402-demo"
```

Expected shape:

```json
{
  "creditPriceWei": "1000000000000000",
  "x402CompatibilityEnabled": true,
  "x402Scheme": "ghost-eip712-credit-v1",
  "service": {
    "slug": "x402-demo",
    "cost": "1",
    "source": "demo"
  }
}
```

If `x402CompatibilityEnabled` is `false`, do not attempt x402 mode for that environment.

## Canonical demo target

Ghost Protocol exposes a deterministic x402 demo service:

```text
service = x402-demo
endpoint = /api/gate/x402-demo
```

Expected evaluator flow:

1. `GET /api/pricing?service=x402-demo`
2. `POST /api/gate/x402-demo` without auth -> `402`
3. retry with `payment-signature`
4. receive `200` + `payment-response`

## Request flow

The current GhostGate x402 flow is:

1. Client checks pricing metadata.
2. Client signs the normal GhostGate EIP-712 access payload.
3. Client wraps that payload + signature in a base64 JSON `payment-signature` envelope.
4. Server authorizes the request and returns:
   - `402` + `payment-required` when credits/auth are missing
   - `200` + `payment-response` when authorization succeeds

This gives x402-aware clients a standard request/response shape without changing the underlying GhostGate rail.

## Header contract

When x402 mode is enabled:

- request:
  - `payment-signature`
- response on challenge:
  - `payment-required`
- response on success:
  - `payment-response`

All three are base64 JSON envelopes.

## Node.js SDK example

```ts
import { GhostAgent } from "@ghostgate/sdk";

const gate = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL ?? "https://ghostprotocol.cc",
  chainId: 8453,
  serviceSlug: "x402-demo",
  creditCost: 1,
  authMode: "x402",
  x402Scheme: "ghost-eip712-credit-v1",
});

const result = await gate.connect();

console.log(result.status);
console.log(result.payload);
console.log(result.x402?.paymentRequired);
console.log(result.x402?.paymentResponse);
```

## Python SDK example

```python
from ghostgate import GhostGate

gate = GhostGate(
    api_key="sk_live_your_sdk_context_key",
    private_key="0xyour_signer_private_key",
    base_url="https://ghostprotocol.cc",
    service_slug="x402-demo",
    credit_cost=1,
    auth_mode="x402",
    x402_scheme="ghost-eip712-credit-v1",
)

result = gate.connect()

print(result["status"])
print(result["payload"])
print(result.get("x402", {}).get("paymentRequired"))
print(result.get("x402", {}).get("paymentResponse"))
```

## Response handling

Treat the result like this:

- `402`
  - read `payment-required`
  - inspect the challenge / required cost
  - fund or sync credits if needed
- `200`
  - read `payment-response`
  - proceed with the authorized request result

In GhostGate, a `402` does **not** mean "do an on-chain payment right now."
It means the Gate could not authorize the request with the current Ghost credit state and envelope.

## CLI helper example

This repo already includes a working helper for x402-compatible Gate calls:

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs \
  --service x402-demo \
  --method POST \
  --body-json "{\"prompt\":\"hello\"}"
```

That helper:

- signs the GhostGate access payload
- wraps it in `payment-signature`
- prints `payment-required` / `payment-response` when present

You can also preview the exact envelope shape without sending the request:

```bash
node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs \
  --service x402-demo \
  --method POST \
  --body-json "{\"prompt\":\"hello\"}" \
  --dry-run
```

Repo smoke verifier:

```bash
npm run verify:x402:demo
```

Public example client:

```bash
npm run example:x402:demo
```

Use the public demo client if you want one runnable file that performs the full `pricing -> 402 -> signed retry -> success` flow against `x402-demo`.

## Relationship to GhostWire

GhostWire is separate.

GhostWire uses:

- `POST /api/wire/quote`
- `POST /api/wire/jobs`
- `GET /api/wire/jobs/[jobId]`

GhostWire is a direct ERC-8183 escrow flow, not an x402 flow.

If the same merchant wants both:

- use GhostGate for fast paid API/tool access
- use GhostWire for higher-value escrowed jobs

## Related docs

- [API Reference](./api-reference.md)
- [SDK Reference](./sdk-reference.md)
- [5-Minute Node.js Quickstart](./quickstart-node.md)
- [GhostGate x402 Public Demo Client](./ghostgate-x402-public-demo-client.md)
- [GhostWire](./ghostwire.md)
- [GhostGate x402 Demo Spec](./ghostgate-x402-demo-spec.md)
