# @ghostgate/sdk

Node.js SDK for Ghost Protocol gate access, fulfillment, telemetry, and canary helpers.

## Install

```bash
npm install @ghostgate/sdk
```

Until the package is published to npm, you can also test locally from this repo:

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
import { GhostAgent, GhostMerchant } from "@ghostgate/sdk";

const sdk = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL,
  serviceSlug: "agent-18755",
});

await sdk.connect();
await sdk.pulse();
```
