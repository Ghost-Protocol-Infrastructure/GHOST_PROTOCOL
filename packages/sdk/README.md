# @ghostgate/sdk

Node.js SDK for Ghost Protocol:

- `Express` access via `connect()`
- `x402` request flow via `requestX402()`
- `GhostWire` direct escrow helpers
- merchant onboarding and x402 settlement reporting

> `Agent Offerings` are merchant dashboard/profile metadata.
> They are not an SDK-side pricing enforcement primitive and they do not replace `ServicePricing`, `x402` payment requirements, or GhostWire quote logic.

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
  - `buildGhostWireRequestSpecHash()`
  - `prepareWireJob()`
  - `recordWireArtifacts()`
  - `getWireJob()`
  - `waitForWireTerminal()`
  - `getWireDeliverable()`
- `GhostMerchant`
  - `activate()`
  - `createX402SettlementReporter()`
  - `reportX402Settlement()`
  - `reportX402Settlements()`
- `GhostFulfillmentConsumer`
- `GhostFulfillmentMerchant`
- `buildCanaryPayload()`
- `createCanaryHandler()`
- `createSettlementEvidence()`
- `defineGhostConfig()`
- `createGhostHttpMonetizationKit()`
- `createGhostMcpProxy()`
- `withGhostX402NextNode()`
- `withGhostX402Hono()`
- `withGhostX402Express()`
- `withGhostX402Fastify()`
- `X402_REPORTING_RUNTIME_SUPPORT`

## Express example

```ts
import { GhostAgent } from "@ghostgate/sdk";

const agent = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL,
  serviceSlug: "agent-18755",
  creditCost: 5,
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

For supported long-lived runtimes, auto-reporting is the default onboarding path. The framework wrappers own:

- `402` challenge
- payment verification + settlement
- canonical settlement evidence emission
- async GhostRank reporting

```ts
import {
  GhostMerchant,
  withGhostX402NextNode,
} from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-18755",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const reporter = merchant.createX402SettlementReporter({
  runtime: "next_node",
  onEvent: (event) => {
    console.log(event.name, event.queueSize);
  },
});

export const POST = withGhostX402NextNode(
  {
    merchant,
    agentId: "18755",
    paymentRequirements: {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "1000000",
      resource: "https://merchant.example.com/ask",
      description: "Paid ask endpoint",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      asset: "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913",
      extra: {
        decimals: 6,
      },
    },
    x402Client: {} as never,
    reporter,
    decodePaymentHeader: (header) => JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    verifyPayment: async () => ({ isValid: true, payer: "0xpayer" }),
    settlePayment: async () => ({
      success: true,
      transaction: "0xabc123",
      network: "base",
      payer: "0xpayer",
    }),
  },
  async () => Response.json({ ok: true }),
);
```

The reporter surface exposes:

- counters via `reporter.getSnapshot().counters`
- lifecycle events via `onEvent`
- event names:
  - `payment_verified`
  - `report_enqueued`
  - `report_sent`
  - `report_accepted`
  - `duplicate`
  - `report_dropped`

Use manual settlement reporting only as the fallback or incident-recovery path. `createSettlementEvidence()` remains the canonical SDK contract for settlement evidence.

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

const report = await merchant.reportX402Settlement({
  agentId: "18755",
  serviceSlug: "agent-18755",
  ...evidence,
});

console.log(report.countedForRank, report.duplicate);
```

Manual fallback example:

- use `createSettlementEvidence(...)`
- call `reportX402Settlement(...)` directly
- keep this path available for unsupported runtimes, custom merchants, or incident recovery

## x402 reporting runtime support

Automatic x402 reporting in the MVP is designed for long-lived server runtimes:

- first-class:
  - Node servers
  - Python servers
  - Next.js route handlers running with `runtime = "nodejs"`
- best-effort:
  - short-lived/serverless Node runtimes
  - short-lived/serverless Python runtimes
- manual fallback:
  - Edge runtimes
  - custom merchants that want direct control of settlement reporting

The request/response path should never block on Ghost reporting. If you are not in a long-lived runtime, keep manual settlement reporting available as the recovery path.

## HTTP monetization kit

`createGhostHttpMonetizationKit()` is the config/productization layer over the existing SDK payment paths.

- `x402` routes reuse the canonical `withGhostX402*()` wrappers and `SettlementEvidence` reporting path.
- `express` routes reuse fulfillment ticket verification + capture.
- `hybrid` routes require explicit rail selection. Ghost does not silently fall back between rails.

```ts
import {
  GhostMerchant,
  createGhostHttpMonetizationKit,
  defineGhostConfig,
} from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-18755",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const ghostConfig = defineGhostConfig({
  version: 1,
  service: {
    agentId: "18755",
    serviceSlug: "agent-18755",
    endpointUrl: "https://merchant.example.com",
  },
  routes: {
    ask: {
      method: "POST",
      path: "/ask",
      rail: "hybrid",
      x402: {
        paymentRequirements: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1000000",
            resource: "/ask",
            description: "Paid ask endpoint",
            mimeType: "application/json",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 300,
            asset: "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913",
            extra: {
              decimals: 6,
            },
          },
        ],
      },
      express: {
        creditCost: 5,
      },
    },
  },
});

const kit = createGhostHttpMonetizationKit({
  merchant,
  config: ghostConfig,
  x402: {
    x402Client: {} as never,
  },
});

export const POST = kit.withNextNode(
  { routeId: "ask", rail: "x402" },
  async (args) => {
    if (args.rail !== "x402") throw new Error("Expected x402 route.");
    return Response.json({ ok: true, paymentReference: args.x402.paymentReference });
  },
);
```

For `Express` routes in `ghost.config`, `express.creditCost` is not cosmetic metadata. It is enforced as part of fulfillment ticket verification alongside `serviceSlug`, `method`, `path`, `query`, and `body`.

## MCP payment-aware proxy

`createGhostMcpProxy()` is the stateless MCP-over-HTTP/SSE layer built on top of the HTTP monetization kit.

- `tools/list` stays free
- `tools/call` is the paid execution path
- `initialize`, `notifications/initialized`, and other JSON-RPC methods pass through to the upstream server
- tool pricing metadata is added under `annotations.ghost.pricing`

```ts
import {
  createGhostHttpMonetizationKit,
  createGhostMcpProxy,
  defineGhostConfig,
  GhostMerchant,
} from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-18755",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const ghostConfig = defineGhostConfig({
  version: 1,
  service: {
    agentId: "18755",
    serviceSlug: "agent-18755",
    endpointUrl: "https://merchant.example.com",
  },
  routes: {
    mcp_x402: {
      method: "POST",
      path: "/mcp",
      rail: "x402",
      x402: {
        paymentRequirements: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1000000",
            resource: "/mcp",
            description: "Paid MCP execution",
            mimeType: "application/json",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 300,
            asset: "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913",
            extra: {
              decimals: 6,
            },
          },
        ],
      },
    },
  },
});

const kit = createGhostHttpMonetizationKit({
  merchant,
  config: ghostConfig,
  x402: {
    x402Client: {} as never,
  },
});

const proxy = createGhostMcpProxy({
  kit,
  config: {
    upstream: {
      url: "https://upstream.example.com/mcp",
    },
    tools: {
      ask_wallet: {
        route: "mcp_x402",
        descriptionFallbackText: true,
      },
    },
  },
});

export const POST = proxy.withNextNode();
export const GET = proxy.withNextNode();
```

## GhostWire direct escrow

```ts
import { GhostAgent, buildGhostWireRequestSpecHash } from "@ghostgate/sdk";

const request = {
  prompt: "Roast my wallet honestly.",
  walletAddress: "0xclient...",
  metadata: {
    skill: "booski",
    tone: "merciless",
  },
};

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
  request,
  specHash: buildGhostWireRequestSpecHash(request),
  // metadataUri stays the merchant-controlled deliverable locator, not the task request payload.
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?contract=0x...&job=3",
});
```

## Notes

- `connect()` is Express only. The old Express x402-compat envelope has been removed.
- `Express` carries a `2.5%` Ghost protocol fee and is intended for premium managed paid access.
- Recommended default for `Express` is `5+` credits per request. Use `x402` for cheap or high-frequency paid access.
- `requestX402()` is the real standards-native x402 rail and automatically handles the payment retry path.
- GhostRank credit for x402 should normally come from the SDK auto-reporting wrappers on supported runtimes. Keep `reportX402Settlement(...)` as the manual fallback.
- For GhostWire, the consumer request belongs in `request`; `metadataUri` is still the merchant-controlled deliverable locator.
- Use signer private keys only in trusted backend/server/CLI environments.
