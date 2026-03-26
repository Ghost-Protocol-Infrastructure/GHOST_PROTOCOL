# GhostGate x402

GhostGate includes `x402` as a first-class open rail under the GhostGate product umbrella.

This is not Express transport compatibility. It is the real standards-native `x402` flow.

## What it is

- zero Ghost protocol fee
- merchant runs a normal x402-protected endpoint
- client pays with a standard x402 flow
- merchant can report verified settlements back to Ghost so the activity feeds GhostRank

## What it is not

- not `/api/gate/[service]`
- not a wrapped `payment-signature` envelope
- not an Express mode
- not a compatibility shim

## Canonical Ghost metadata

Check:

```text
GET /api/pricing?service=<service_slug>
```

The response now exposes a canonical `x402` block:

```json
{
  "x402": {
    "supported": true,
    "reportingMode": "merchant-signed",
    "supportedSchemes": ["exact"],
    "rankEligibleAssets": ["USDC"]
  }
}
```

In v1:

- supported scheme: `exact`
- rank-eligible asset: `USDC`
- reporting mode: merchant-signed settlement evidence

## Node SDK

```ts
import { GhostAgent } from "@ghostgate/sdk";

const sdk = new GhostAgent({
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  chainId: 8453,
});

const result = await sdk.requestX402({
  url: "https://merchant.example.com/ask",
  method: "POST",
  body: { prompt: "hello" },
  maxAmountAtomic: "100000",
});
```

The Node helper performs the standard `402 -> payment -> retry` loop automatically.

## Python SDK

```python
from ghostgate import GhostGate

sdk = GhostGate(private_key="0x...")
result = sdk.request_x402(
    url="https://merchant.example.com/ask",
    method="POST",
    body={"prompt": "hello"},
)
```

The Python helper is intentionally lower-level. If you do not pass a retry `payment_header`, it returns the initial merchant response, which may be a `402` challenge.

## Merchant reporting for GhostRank

Ghost cannot score x402 traffic it cannot observe. If you want GhostRank credit, report verified settlements:

The canonical reporting contract is `SettlementEvidence`:

- `requestId`
- `paymentReference`
- `payerIdentity`
- `payerAddress`
- `scheme`
- `network`
- `chainId`
- `asset`
- `amountAtomic`
- `decimals`
- `success`
- `statusCode`
- `latencyMs`
- `occurredAt`
- `metadata`

Framework wrappers should emit settlement evidence from the payment verification/gating layer, then hand that evidence to the reporter. They should not infer payment success from arbitrary `200` responses.

### Node

```ts
import { GhostMerchant, createSettlementEvidence } from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-18755",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const evidence = createSettlementEvidence({
  requestId: "req_123",
  paymentReference: "0xabc123",
  payerIdentity: "0xpayer",
  scheme: "exact",
  network: "base",
  chainId: 8453,
  asset: "USDC",
  amountAtomic: "1000000",
  decimals: 6,
  success: true,
  statusCode: 200,
});

await merchant.reportX402Settlement({
  agentId: "18755",
  serviceSlug: "agent-18755",
  ...evidence,
});
```

### Python

```python
sdk.report_x402_settlement(
    agent_id="18755",
    service_slug="agent-18755",
    request_id="req_123",
    payment_reference="0xabc123",
    payer_identity="0xpayer",
    amount_atomic="1000000",
    scheme="exact",
    network="base",
    chain_id=8453,
    asset="USDC",
    decimals=6,
    success=True,
    status_code=200,
)
```

## Scoring notes

- x402 has its own GhostRank lane
- it is scored separately from Express
- confidence depends on qualified paid calls, unique counterparties, repeat counterparties, active days, success rate, and concentration
- related-party traffic is stored but heavily downweighted or excluded from rank credit

## Runtime support

Automatic x402 reporting in the MVP is first-class for:

- long-lived Node servers
- long-lived Python servers
- `Next.js` route handlers using `runtime = "nodejs"`

Short-lived/serverless runtimes are best-effort only in the MVP, and Edge runtimes should keep manual reporting as the fallback path.
