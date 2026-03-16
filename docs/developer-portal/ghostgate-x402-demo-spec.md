# GhostGate x402 Demo Spec

This page specifies the minimum public demo flow for GhostGate x402 compatibility.

The goal is not to prove the whole product. The goal is to make the x402 transport path legible in one pass.

Current implementation status:

- canonical demo target is implemented as `x402-demo`
- canonical verifier is implemented as `npm run verify:x402:demo`

## Goal

Ship one obvious public GhostGate demo for x402-aware builders that shows:

1. pricing discovery
2. `402` challenge
3. automatic retry with `payment-signature`
4. successful authorized response

## Audience

- x402-native builders
- agent/payment infrastructure developers
- technical evaluators who want to verify GhostGate's compatibility story quickly

## Scope

This demo is for GhostGate only.

It does **not** need to include:

- Hosted GhostWire
- fulfillment ticket/capture flow
- merchant dashboard setup
- GhostRank attribution

## Demo shape

### Canonical service

Use a Ghost-controlled demo service slug, not a third-party merchant runtime.

Recommended:

```text
service = x402-demo
endpoint = /api/gate/x402-demo
```

Reason:

- stable
- deterministic
- no dependency on an external merchant canary
- safe for documentation and repeated testing

### Canonical discovery step

Client checks:

```text
GET /api/pricing?service=x402-demo
```

The response must clearly expose:

- `x402CompatibilityEnabled`
- `x402Scheme`
- request cost

### Challenge step

Client sends a request without valid x402 auth.

Expected:

- HTTP `402`
- `payment-required` response header
- body that makes the challenge readable

### Retry step

Client signs the normal GhostGate access payload and wraps it in:

```text
payment-signature
```

The retry should be automatic in the example client/helper flow.

### Success step

Expected:

- HTTP `200`
- `payment-response` response header
- obvious demo payload in body, for example:

```json
{
  "ok": true,
  "service": "x402-demo",
  "authorized": true,
  "mode": "x402-demo"
}
```

## Required deliverables

1. Public docs page
   - use [ghostgate-x402.md](./ghostgate-x402.md)
2. One runnable example client
   - can initially reuse:
     - `integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs`
3. One stable demo target
   - Ghost-controlled
   - not dependent on third-party merchant uptime
4. One short verification script or smoke test
  - should prove `402 -> retry -> 200`
   - implemented as `npm run verify:x402:demo`

## UX requirements

The first-time evaluator should understand the story in under 2 minutes.

That means the demo must make these facts obvious:

- x402 is optional compatibility mode
- GhostGate still uses Ghost EIP-712 credits underneath
- the transport looks like `402` / `payment-required` / `payment-response`
- the retry path succeeds without requiring them to reverse-engineer the protocol

## Non-goals

- proving a true x402 `exact` scheme path
- making GhostWire look x402-native
- replacing the default GhostGate transport

## Future extension

If ecosystem demand is real, Phase C can evaluate:

- a true x402 `exact` scheme path for selected endpoints

That is explicitly later work, not part of this demo.
