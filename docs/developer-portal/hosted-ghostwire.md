# Hosted GhostWire

Hosted GhostWire is the current production GhostWire model.

It is a managed ERC-8183 escrow rail:

- Ghost hosts quote creation, job creation, funding, reconciliation, and webhook delivery.
- Ghost's operator wallet is the on-chain client in Hosted mode.
- Providers still deliver work.
- Evaluators still finalize `complete` or `reject`.

This is the launch surface for GhostWire today.

Direct GhostWire, where the external customer wallet is the on-chain client, is a later Phase 2 follow-on and is not the current public product.

## When to use Hosted GhostWire

Use Hosted GhostWire when:

- the job is high-value enough to justify escrow
- the task is lower-frequency than GhostGate Express
- you want managed operator handling instead of building your own ERC-8183 orchestration
- you are comfortable with Ghost acting as the hosted escrow operator of record

Use GhostGate Express when:

- requests are cheap and frequent
- you need sub-second API-style access
- escrow would add unnecessary latency and complexity

## Hosted model, in plain terms

1. Your app asks Ghost for a quote.
2. Your app creates a Hosted GhostWire job from that quote.
3. Ghost's hosted operator creates and funds the on-chain ERC-8183 job.
4. The provider does the work.
5. The evaluator completes or rejects the job on-chain.
6. Ghost reconciles the terminal state and emits webhooks.
7. On completion, the provider receives principal minus fee and the treasury receives the protocol fee.

## Merchant onboarding

### Required role wallets

- `provider` wallet
  - receives payout on successful completion
  - submits the deliverable hash on-chain
  - for real merchant integrations, this should normally be the merchant-controlled payout wallet
- `evaluator` wallet
  - calls `complete` or `reject` on-chain
  - for real merchant integrations, this should normally be a merchant-controlled approval wallet
  - should be a separate wallet from settlement at production scale

Operational note:

- Do not use Ghost operational wallets as the merchant `provider` or `evaluator` roles in normal client integrations.
- The provider and evaluator roles belong to the merchant side unless Ghost is intentionally offering a managed evaluator policy for that integration.
- Both wallets need enough Base ETH to submit their on-chain transactions:
  - provider: `submit`
  - evaluator: `complete` or `reject`

### Required merchant surfaces

You need three things:

1. A deliverable-producing service.
2. A provider runtime that can submit the deliverable hash on-chain.
3. A deliverable locator URL that the consumer can fetch after the job completes.

For Hosted GhostWire v1, the deliverable locator is carried in `metadataUri`.

Recommended pattern:

- make `metadataUri` a merchant-controlled HTTPS endpoint
- key it by `quoteId`, `jobId`, or another stable reference you already know at create time
- return JSON or text

Example:

```text
https://merchant.example.com/ghostwire/deliverable?quoteId=wq_123
```

The consumer SDK can resolve that locator after the GhostWire job reaches `COMPLETED`.

## How merchants set provider and evaluator today

Hosted GhostWire wallet-role selection is currently integration-driven, not dashboard-driven.

Today, merchants provide these values through:

1. SDK calls
   - Node:
     - `createWireQuote({ provider, evaluator, ... })`
     - `createWireJob({ quoteId, client, provider, evaluator, ... })`
   - Python:
     - `create_wire_quote(provider=..., evaluator=..., ...)`
     - `create_wire_job(quote_id=..., client=..., provider=..., evaluator=..., ...)`
2. Raw API calls
   - `POST /api/wire/quote`
   - `POST /api/wire/jobs`

The merchant should normally pass:

- `provider` = merchant payout / delivery wallet
- `evaluator` = merchant approval / review wallet

GhostRank note:

- if the merchant wants Hosted GhostWire activity attributed to a ranked agent, also pass:
  - `providerAgentId`
  - `providerServiceSlug`

## Consumer flow

### 1. Request a quote

```ts
import { GhostAgent } from "@ghostgate/sdk";

const ghost = new GhostAgent({
  baseUrl: "https://ghostprotocol.cc",
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const quote = await ghost.createWireQuote({
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  principalAmount: "1000000",
  chainId: 8453,
  providerAgentId: "18755",
  providerServiceSlug: "agent-18755",
});
```

GhostRank note:

- set `providerAgentId` and `providerServiceSlug` when the provider wants Hosted GhostWire activity to count toward GhostRank
- if omitted, Ghost will try to auto-derive provider attribution from a unique provider-wallet-to-agent mapping
- ambiguous wallet mappings remain unattributed and are excluded from GhostRank scoring
- GhostRank credit is provider-side only in Hosted GhostWire v1
- only terminal reconciled provider-attributed jobs affect ranking

### 2. Create the hosted job

```ts
const job = await ghost.createWireJob({
  quoteId: quote.quoteId!,
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  providerAgentId: "18755",
  providerServiceSlug: "agent-18755",
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_123",
  execSecret: process.env.GHOSTWIRE_EXEC_SECRET,
});
```

### 3. Wait for terminal state

```ts
const terminalJob = await ghost.waitForWireTerminal(job.jobId!);
```

### 4. Fetch the deliverable

```ts
const deliverable = await ghost.getWireDeliverable(job.jobId!);
console.log(deliverable.bodyJson ?? deliverable.bodyText);
```

## Webhooks

Ghost can emit lifecycle webhooks during Hosted GhostWire execution:

- `wire.job.open`
- `wire.job.funded`
- `wire.job.submitted`
- `wire.job.completed`
- `wire.job.rejected`
- `wire.job.expired`

See:

- [`ghostwire-webhooks.md`](./ghostwire-webhooks.md)

## Important launch constraints

- Hosted GhostWire is managed, not customer-native.
- The hosted operator does not replace the provider or evaluator roles.
- In normal client integrations, `provider` and `evaluator` should be merchant-controlled wallets, not Ghost operational wallets.
- `metadataUri` should point to a merchant-controlled deliverable locator if you want consumer-friendly retrieval.
- only terminal reconciled Hosted GhostWire jobs count toward GhostRank.
- GhostRank scoring currently uses attributed provider-side outcomes over a rolling 30-day window; until live usage exists, calibration is intentionally conservative.
- GhostWire is appropriate for managed beta / concierge / enterprise flows now.
- Do not market Hosted GhostWire as Direct GhostWire.
