# GhostWire

GhostWire is Ghost Protocol's direct ERC-8183 escrow rail for higher-value agent work.

Ghost does not fund or sponsor the job. The external customer wallet is the on-chain client for:

- token approval
- job creation
- budget setup
- funding

Use GhostWire when the work is valuable enough to justify escrow and completion/rejection semantics.

Use GhostGate when the work is cheap, frequent, and needs chat-speed paid access.

## Current model

- `direct only`
- `customer funded`
- `customer pays gas`
- `no sponsorship / relays`
- `provider` and `evaluator` remain merchant-controlled roles

## When to use GhostWire

Use GhostWire when:

- the buyer wants escrow before the work starts
- the provider should only be paid on terminal outcome
- the work is job-based, not request-based
- the task has enough value that extra on-chain steps are acceptable

Do not use GhostWire when:

- the interaction is a cheap API/tool call
- the user needs sub-second request/response flow
- escrow would add friction without meaningful trust benefit

## Role model

- `client`
  - external buyer wallet
  - approves USDC
  - creates and funds the on-chain job
- `provider`
  - merchant payout / delivery wallet
  - submits the deliverable on-chain
- `evaluator`
  - merchant approval / review wallet
  - completes or rejects on-chain

## Direct flow

1. Request a quote from `POST /api/wire/quote`.
2. Prepare the job from `POST /api/wire/jobs`.
3. If needed, submit `approveTxRequest` from the client wallet.
4. Submit `createTxRequest` from the client wallet.
5. Record the create artifact with `POST /api/wire/jobs/[jobId]/artifacts`.
6. Use the returned `setBudgetTxRequest` and `fundTxRequest`.
7. Submit those client-wallet transactions on-chain.
8. Record the fund artifact with `POST /api/wire/jobs/[jobId]/artifacts`.
9. Poll `GET /api/wire/jobs/[jobId]` or consume provider webhooks until terminal state.
10. Resolve the deliverable from `job.deliverable.locatorUrl` after `COMPLETED`.

## Merchant requirements

You need:

- a provider wallet with enough ETH to call `submit`
- an evaluator wallet with enough ETH to call `complete` or `reject`
- a merchant-controlled deliverable locator if consumers should fetch output after completion
- optional webhook receiver if the provider wants state transition pushes

Recommended deliverable pattern:

```text
https://merchant.example.com/ghostwire/deliverable?contract=0x...&job=3
```

GhostWire resolves consumer fetch locators in this order:

1. explicit `https://` or `http://` `metadataUri`
2. explicit `ipfs://` `metadataUri` through a public IPFS gateway
3. standard fallback derived from the merchant's registered gateway endpoint:

```text
{endpointUrl}/wire/deliverable?contract=0x...&job=3&jobId=wj_123
```

That means merchants with a configured gateway endpoint can omit an explicit HTTPS `metadataUri` as long as they serve the standard `/wire/deliverable` route.

## Consumer requirements

The buyer wallet needs:

- enough USDC for `principal + protocolFee`
- enough Base ETH for approval/create/setBudget/fund gas

GhostWire quote pricing tells the buyer what escrow principal and protocol fee are required.
Gas is paid directly by the buyer wallet and is not part of the GhostWire quote charge.

## Node example

```ts
import { GhostAgent } from "@ghostgate/sdk";

const ghost = new GhostAgent({
  baseUrl: "https://ghostprotocol.cc",
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

const quote = await ghost.createWireQuote({
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  principalAmount: "1000000",
  chainId: 8453,
  providerAgentId: "18755",
  providerServiceSlug: "agent-18755",
});

const prepared = await ghost.prepareWireJob({
  quoteId: quote.quoteId!,
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  specHash: "0x" + "aa".repeat(32),
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?contract=0x...&job=3",
});

// Send prepared.direct?.approveTxRequest if present.
// Send prepared.direct?.createTxRequest from the client wallet.

const afterCreate = await ghost.recordWireArtifacts({
  jobId: prepared.jobId!,
  clientAddress: "0xclient...",
  createTxHash: "0xcreate...",
});

// Send afterCreate.direct?.setBudgetTxRequest and afterCreate.direct?.fundTxRequest.

await ghost.recordWireArtifacts({
  jobId: prepared.jobId!,
  clientAddress: "0xclient...",
  fundTxHash: "0xfund...",
});

const terminal = await ghost.waitForWireTerminal(prepared.jobId!);
const deliverable = await ghost.getWireDeliverable(terminal.jobId);
```

## Recovery model

If artifact validation fails, `GET /api/wire/jobs/[jobId]` surfaces:

- `recoveryAction`
- `recoveryHint`

Current recovery guidance:

- mismatched `OPEN` job -> reject the open job from the client wallet and prepare a new one
- mismatched funded job -> wait for expiry and claim refund from the client/evaluator wallet

If the client crashes after sending transactions, artifact reporting can be retried later.
GhostWire also runs bounded passive recovery for recently prepared jobs that appear on-chain without recorded artifacts.

## Webhooks

GhostWire webhooks are provider-facing in the current launch shape.

Use:

- [GhostWire Webhooks](./ghostwire-webhooks.md)

## Related docs

- [API Reference](./api-reference.md)
- [SDK Reference](./sdk-reference.md)
- [Onboarding and Configuration](./onboarding-and-configuration.md)
- [GhostWire Webhooks](./ghostwire-webhooks.md)
