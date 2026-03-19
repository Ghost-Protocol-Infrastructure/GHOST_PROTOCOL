# @ghostgate/sdk

Node.js SDK for Ghost Protocol:

- `Express` access via `connect()`
- `x402` request flow via `requestX402()`
- `GhostWire` direct escrow helpers
- merchant onboarding and x402 settlement reporting

## Install

```bash
npm install @ghostgate/sdk
```

## Core surfaces

- `GhostAgent`
  - `connect()`
  - `requestX402()`
  - `pulse()`
  - `outcome()`
  - `startHeartbeat()`
  - `createWireQuote()`
  - `prepareWireJob()`
  - `recordWireArtifacts()`
  - `getWireJob()`
  - `waitForWireTerminal()`
  - `getWireDeliverable()`
- `GhostMerchant`
  - `activate()`
  - `reportX402Settlement()`
  - `reportX402Settlements()`
- `GhostFulfillmentConsumer`
- `GhostFulfillmentMerchant`
- `buildCanaryPayload()`
- `createCanaryHandler()`

## Express example

```ts
import { GhostAgent } from "@ghostgate/sdk";

const agent = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL,
  serviceSlug: "agent-18755",
  creditCost: 1,
});

const result = await agent.connect();
console.log(result.status, result.payload);
```

## x402 example

`requestX402()` is the high-level Node helper. It handles the standard `402 -> payment -> retry` flow for you.

```ts
import { GhostAgent } from "@ghostgate/sdk";

const agent = new GhostAgent({
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  chainId: 8453,
});

const result = await agent.requestX402({
  url: "https://merchant.example.com/ask",
  method: "POST",
  body: { prompt: "hello" },
  maxAmountAtomic: "100000",
});

console.log(result.status, result.payload, result.paymentResponse);
```

## Merchant x402 settlement reporting

```ts
import { GhostMerchant } from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-18755",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const report = await merchant.reportX402Settlement({
  agentId: "18755",
  serviceSlug: "agent-18755",
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

console.log(report.countedForRank, report.duplicate);
```

## GhostWire direct escrow

```ts
const quote = await agent.createWireQuote({
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  principalAmount: "1000000",
  chainId: 8453,
});

const prepared = await agent.prepareWireJob({
  quoteId: quote.quoteId!,
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
```

## Notes

- `connect()` is Express only. The old Express x402-compat envelope has been removed.
- `Express` carries a `2.5%` Ghost protocol fee and is intended for premium managed paid access.
- Recommended default for `Express` is `5+` credits per request. Use `x402` for cheap or high-frequency paid access.
- `requestX402()` is the real standards-native x402 rail and automatically handles the payment retry path.
- GhostRank credit for x402 depends on merchant-side `reportX402Settlement(...)`.
- Use signer private keys only in trusted backend/server/CLI environments.
