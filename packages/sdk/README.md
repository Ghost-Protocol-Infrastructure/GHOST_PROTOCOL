# @ghostgate/sdk

Node.js SDK for Ghost Protocol gate access, fulfillment, telemetry, direct GhostWire helpers, and canary helpers.

## Install

```bash
npm install @ghostgate/sdk
```

If you need to test unreleased SDK changes from this repo locally:

```bash
npm run build:sdk
npm install ../GHOST_PROTOCOL/packages/sdk
```

## Surface

- `GhostAgent`
  - `connect()`
  - `pulse()`
  - `outcome()`
  - `startHeartbeat()`
  - `createWireQuote()`
  - `prepareWireJob()`
  - `recordWireArtifacts()`
  - `getWireJob()`
  - `waitForWireTerminal()`
  - `getWireDeliverable()`
- `GhostFulfillmentConsumer`
- `GhostFulfillmentMerchant`
- `GhostMerchant`
- `buildCanaryPayload()`
- `createCanaryHandler()`

## Example

```ts
import { GhostAgent } from "@ghostgate/sdk";

const sdk = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL,
  serviceSlug: "agent-18755",
  // Optional x402 compatibility mode:
  // authMode: "x402",
  // x402Scheme: "ghost-eip712-credit-v1",
});

await sdk.connect();
await sdk.pulse();

const quote = await sdk.createWireQuote({
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  principalAmount: "1000000",
  chainId: 8453,
});

const prepared = await sdk.prepareWireJob({
  quoteId: quote.quoteId!,
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?jobId=wj_123",
});

await sdk.recordWireArtifacts({
  jobId: prepared.jobId!,
  clientAddress: "0xclient...",
  createTxHash: "0xcreate...",
});
```

## Fulfillment Merchant Default Signer

`GhostFulfillmentMerchant` and `GhostMerchant` default `protocolSignerAddresses` to the current Ghost production fulfillment signer set:

- `0xf879f5e26aa52663887f97a51d3444afef8df3fc`

For normal Ghost-hosted production merchants, leave that allowlist unset.
Only override it for self-hosted/custom ticket issuers or when Ghost explicitly instructs you during signer rotation.
