# GhostGate x402 Public Demo Client

This page gives builders one runnable public example for the canonical GhostGate x402 demo target.

Use this when you want to see the full transport flow in one file:

1. pricing lookup
2. unauthenticated request
3. `402 Payment Required`
4. signed retry with `payment-signature`
5. authorized success

## What it runs against

- service: `x402-demo`
- pricing endpoint: `GET /api/pricing?service=x402-demo`
- gate endpoint: `POST /api/gate/x402-demo`

## Example client

Source file:

- [`examples/ghostgate-x402-demo/client.mjs`](../../examples/ghostgate-x402-demo/client.mjs)

## Requirements

- Node.js `20.x`
- npm `10.8.2+`
- `GHOST_SIGNER_PRIVATE_KEY` or `PRIVATE_KEY`
- at least `1` synced Ghost Credit for that signer if you want the retry step to succeed

## Run it

From repo root:

```bash
npm run example:x402:demo
```

Optional overrides:

```bash
npm run example:x402:demo -- \
  --base-url https://ghostprotocol.cc \
  --service x402-demo \
  --chain-id 8453 \
  --prompt "hello from x402"
```

## Environment

Provide one signer key:

```bash
GHOST_SIGNER_PRIVATE_KEY=0x...
PRIVATE_KEY=0x...
```

Optional:

```bash
GHOST_BASE_URL=https://ghostprotocol.cc
GHOST_SERVICE_SLUG=x402-demo
GHOST_CHAIN_ID=8453
```

## Expected output

The script prints one JSON object with three steps:

- `pricing`
- `challenge`
- `authorized`

Successful shape:

```json
{
  "ok": true,
  "steps": {
    "pricing": { "status": 200 },
    "challenge": { "status": 402 },
    "authorized": { "status": 200 }
  }
}
```

If `authorized.status` is still `402`, the signer likely needs funded or synced Ghost Credits.

## Why this exists

This is the lean public Phase B example client for GhostGate x402.

It is intentionally small and explicit so builders can run the exact `402 -> retry -> success` flow without reading internal helper code first.

## Related docs

- [GhostGate x402 Compatibility](./ghostgate-x402.md)
- [GhostGate x402 Demo Spec](./ghostgate-x402-demo-spec.md)
- [API Reference](./api-reference.md)
