# @ghostgate/sdk

Node.js SDK for Ghost Protocol gate access, fulfillment, telemetry, and canary helpers.

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
});

await sdk.connect();
await sdk.pulse();
```

## Fulfillment Merchant Default Signer

`GhostFulfillmentMerchant` and `GhostMerchant` default `protocolSignerAddresses` to the current Ghost production fulfillment signer set:

- `0xf879f5e26aa52663887f97a51d3444afef8df3fc`

For normal Ghost-hosted production merchants, leave that allowlist unset.
Only override it for self-hosted/custom ticket issuers or when Ghost explicitly instructs you during signer rotation.
