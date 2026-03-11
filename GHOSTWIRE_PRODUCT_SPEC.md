# GhostWire Product Spec (Draft)

Status: Draft, not yet implemented
Owner: Ghost Protocol
Product Surface: GhostGate umbrella, `wire` mode

Implementation detail companion:
- `GHOSTWIRE_IMPLEMENTATION_SPEC.md`

## 1. Intent

GhostWire is the high-trust escrow rail under the GhostGate product umbrella.

It exists to serve agent transactions that are too valuable, too stateful, or too dispute-sensitive for the current GhostGate express rail. GhostWire is not a replacement for GhostGate. It is the second rail in a dual-rail system:

- `express` mode: the current GhostGate rail for off-chain Ghost Credits and high-frequency, low-cost machine payments
- `wire` mode / GhostWire: managed ERC-8183 commerce orchestration for high-value, low-frequency jobs

## 1.1 Locked Naming and Packaging

The naming model is fixed for this product line:

- `GhostGate` remains the umbrella product name
- the SDK/package surface remains GhostGate
- `express` is the name of the current GhostGate payment mode
- `GhostWire` is the product name for the `wire` mode inside GhostGate
- GhostWire does **not** ship as a separate package or standalone product line

## 2. Product Positioning

Ghost Protocol will present a unified developer entry point:

- package: the GhostGate SDK/package surface remains the single install target
- primary abstraction: one SDK, one docs surface, one dashboard
- mode switch:
  - `mode: "express"` for microtransactions
  - `mode: "wire"` for ERC-8183 escrow commerce

This preserves a single integration surface while matching payment flow to agent intent. The core product rule is:

- install GhostGate once
- choose `express` or `wire` per use case
- do not force developers into separate products, packages, or dashboards

## 3. Why GhostWire Exists

GhostGate express is optimized for:
- sub-second API tollbooths
- tiny per-call pricing
- zero per-request on-chain gas

It is the wrong tool for:
- expensive one-off jobs
- client/provider workflows with delivery risk
- work that needs escrow, expiry, evaluator attestation, or deterministic refund logic

GhostWire exists for those cases.

## 4. External Standard Alignment

GhostWire is designed around ERC-8183 rather than a proprietary escrow protocol.

That means Ghost Protocol does not try to invent a new job lifecycle. Instead, GhostWire acts as the managed facilitator layer around the ERC-8183 primitive:

- job setup
- funding orchestration
- event tracking
- lifecycle automation
- expiry/refund handling
- developer abstraction

Ghost Protocol still owns the product layer, operational layer, evaluator routing layer, and DX layer.

V1 contract rule:
- GhostWire targets one pinned ERC-8183 implementation and ABI surface
- GhostWire does not auto-follow upstream implementation changes
- upgrading the underlying ERC-8183 surface is an explicit versioned migration, not an incidental patch
- custom hooks are out of scope for v1

## 5. Core Value Proposition

GhostWire monetizes the infrastructure around ERC-8183, not ownership of the standard itself.

Primary value:
- simple SDK abstraction over a complex on-chain lifecycle
- managed operator/keeper automation
- job status tracking and webhooks
- evaluator routing and helper tooling
- future GhostRank-aware hooks and policy controls

The product thesis is straightforward:
- the standard defines trustless commerce
- Ghost Protocol makes it usable

## 6. V1 Product Scope

GhostWire v1 should ship the narrowest viable facilitator layer.

### 6.1 Frozen V1 Decisions

GhostWire v1 is locked to the following decisions:

1. Base-only execution environment:
   - Base mainnet for production
   - Base Sepolia for non-production testing
2. Settlement and reserve assets:
   - settlement asset: `USDC`
   - network reserve asset: `ETH`
3. Contract surface:
   - one pinned ERC-8183 implementation only
   - no custom hooks in v1
4. Lifecycle operations:
   - Ghost operator-managed lifecycle by default
   - reconciled lifecycle state after `2` confirmations on the supported production path
5. Quote policy:
   - `quoteId` is single-use
   - quote TTL is `10` minutes
   - native-token reserve is buffered conservatively at quote time
6. Product surface:
   - API and SDK write flows first
   - dashboard is read-only for wire flows in v1

Included:
- ERC-8183-backed job creation/funding flow
- direct mapping of the standard state machine:
  - `OPEN`
  - `FUNDED`
  - `SUBMITTED`
  - terminal:
    - `COMPLETED`
    - `REJECTED`
    - `EXPIRED`
- hosted lifecycle monitoring and state sync
- expiry/reclaim automation
- merchant/client dashboard visibility into job state
- SDK helpers for creating, tracking, and settling jobs
- user-supplied evaluator address support

Excluded from v1:
- dashboard-originated wire job creation or settlement actions
- proprietary escrow contracts
- multi-hook marketplace
- hosted evaluator oracle as default path
- cross-chain orchestration
- automated disputes beyond standard evaluator flow
- complex bidding or underwriting hooks

## 7. User Roles

GhostWire centers around four roles:

- `Client`: funds the job
- `Provider`: performs the work
- `Evaluator`: completes or rejects based on submission
- `Ghost Protocol`: facilitator and operator layer, not counterparty to the job outcome

Ghost Protocol may optionally provide tooling or hosted services for evaluator selection and operational automation, but the protocol should not blur facilitator and evaluator roles by default.

## 8. Product Mechanics

### 8.1 Developer Model

Single-SDK mental model:

```ts
// Illustrative API shape; GhostWire remains a mode inside the GhostGate package.
import { GhostGate } from "@ghostgate/sdk";

const expressRail = new GhostGate({
  mode: "express",
  price: 0.1,
});

const wireRail = new GhostGate({
  mode: "wire",
  amount: 500,
  currency: "USDC",
});
```

Exact constructor and method names remain implementation details, but the product requirement is fixed:

- one SDK install
- one docs surface
- clear rail selection by mode
- no separate GhostWire install target

### 8.2 Wire SDK Contract (recommended v1 shape)

The v1 SDK should keep the package unified while exposing a concrete wire-mode contract.

Minimum constructor/config requirements for `wire` mode:
- `mode: "wire"`
- `baseUrl`: Ghost Protocol API origin
- `privateKey` or equivalent signer/wallet client
- `chainId`: `8453` for production, `84532` for non-production testing
- `settlementAsset`: `USDC`

Optional config:
- `defaultEvaluatorAddress`
- `gasPolicy`: default `"sponsored"`
- `maxNetworkReserve`: denominated in the native gas token of the execution chain
- `webhookUrl`
- `webhookSecret`

Recommended v1 wire-mode methods:
- `quoteWireJob(...)`
- `createWireJob(...)`
- `getWireJob(...)`
- `listWireJobs(...)`
- `submitWireDeliverable(...)`
- `completeWireJob(...)`
- `rejectWireJob(...)`
- `reclaimExpiredWireJob(...)`
- `watchWireJob(...)`

Role expectations:
- Client flow:
  - `quoteWireJob`
  - `createWireJob`
  - `getWireJob`
  - `listWireJobs`
  - `reclaimExpiredWireJob`
- Provider flow:
  - `getWireJob`
  - `submitWireDeliverable`
- Evaluator flow:
  - `getWireJob`
  - `completeWireJob`
  - `rejectWireJob`

Product rule:
- keep the lifecycle legible
- do not force developers to orchestrate raw contract events directly for normal use
- do not hide the terminal state machine behind vague helper names

### 8.3 Wire HTTP API Contract (recommended v1 shape)

The wire-mode HTTP API should be explicit about the three economic buckets:

- provider principal
- protocol fee
- native-token network reserve

It should not collapse them into a single generic `amount` field.

#### 8.3.1 `POST /api/wire/quote`

Purpose:
- freeze pricing inputs
- return a short-lived quote for a proposed job
- separate principal, protocol fee, and gas reserve before job creation

Recommended request shape:

```json
{
  "provider": "0xProvider",
  "evaluator": "0xEvaluator",
  "settlementAsset": "USDC",
  "principalAmount": "500000000",
  "chainId": 8453,
  "jobType": "service",
  "ttlSeconds": 600
}
```

Recommended response shape:

```json
{
  "quoteId": "wq_123",
  "expiresAt": "2026-03-10T18:00:00Z",
  "pricing": {
    "principal": {
      "asset": "USDC",
      "amount": "500000000",
      "decimals": 6
    },
    "protocolFee": {
      "asset": "USDC",
      "amount": "12500000",
      "decimals": 6,
      "bps": 250
    },
    "networkReserve": {
      "asset": "ETH",
      "amount": "3000000000000000",
      "decimals": 18,
      "chainId": 8453
    },
    "display": {
      "networkReserveSettlementAssetEstimate": {
        "asset": "USDC",
        "amount": "8120000",
        "decimals": 6
      }
    }
  },
  "maxAuthorization": {
    "settlementAssetTotal": {
      "asset": "USDC",
      "amount": "512500000",
      "decimals": 6
    },
    "nativeGasReserve": {
      "asset": "ETH",
      "amount": "3000000000000000",
      "decimals": 18
    }
  }
}
```

Required product rule:
- `networkReserveSettlementAssetEstimate` is display-only
- canonical accounting uses the native-token `networkReserve` amount only

#### 8.3.2 `POST /api/wire/jobs`

Purpose:
- create a wire job from an accepted quote

Required product rule:
- `quoteId` is mandatory
- clients must not resubmit raw pricing fields at create time

Recommended request shape:

```json
{
  "quoteId": "wq_123",
  "client": "0xClient",
  "provider": "0xProvider",
  "evaluator": "0xEvaluator",
  "specHash": "0x...",
  "metadataUri": "ipfs://..."
}
```

Recommended response shape:

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "OPEN",
  "contractState": "OPEN",
  "pricing": {
    "principal": {
      "asset": "USDC",
      "amount": "500000000",
      "decimals": 6
    },
    "protocolFee": {
      "asset": "USDC",
      "amount": "12500000",
      "decimals": 6
    },
    "networkReserve": {
      "asset": "ETH",
      "amount": "3000000000000000",
      "decimals": 18,
      "chainId": 8453
    }
  }
}
```

Reason:
- quote-time economics stay frozen
- create-time binds counterparties and job intent only
- gas and fee calculations do not drift between quote and create

#### 8.3.3 `GET /api/wire/jobs/:id`

Purpose:
- return lifecycle state, pricing, and settlement visibility for a single wire job

Required response fields:
- `jobId`
- `quoteId`
- `state`
- `contractState`
- `pricing`
- `terminalDisposition` when terminal
- `settlement` when terminal

Recommended response shape:

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "COMPLETED",
  "contractState": "COMPLETED",
  "pricing": {
    "principal": {
      "asset": "USDC",
      "amount": "500000000",
      "decimals": 6
    },
    "protocolFee": {
      "asset": "USDC",
      "amount": "12500000",
      "decimals": 6
    },
    "networkReserve": {
      "asset": "ETH",
      "amount": "3000000000000000",
      "decimals": 18,
      "chainId": 8453
    }
  },
  "terminalDisposition": "COMPLETED",
  "settlement": {
    "providerPayout": {
      "asset": "USDC",
      "amount": "500000000",
      "decimals": 6
    },
    "protocolRevenue": {
      "asset": "USDC",
      "amount": "12500000",
      "decimals": 6
    },
    "actualNetworkSpend": {
      "asset": "ETH",
      "amount": "1840000000000000",
      "decimals": 18
    },
    "unusedNetworkReserveRefund": {
      "asset": "ETH",
      "amount": "1160000000000000",
      "decimals": 18
    }
  }
}
```

Terminal settlement payload rules:
- terminal payload must be present for `COMPLETED`, `REJECTED`, and `EXPIRED`
- terminal payload must include:
  - `providerPayout`
  - `protocolRevenue`
  - `actualNetworkSpend`
  - `unusedNetworkReserveRefund`
- `providerPayout` and `protocolRevenue` may be zero when appropriate
- native-token gas fields must remain native-token denominated in terminal payloads

#### 8.3.4 State Model Rule

Wire responses may expose both:
- `contractState`: raw ERC-8183 state
- `state`: facilitator-facing state

But v1 should keep them functionally aligned.

Hard rule:
- Ghost Protocol must not invent a second competing lifecycle
- any facilitator-facing `state` must be a thin mirror of the ERC-8183 state machine plus non-state metadata

#### 8.3.5 Endpoint Responsibility Split

The wire API must be explicit about what is off-chain computation, what is off-chain persistence, and what is chain-authoritative settlement state.

`POST /api/wire/quote` responsibilities:
- off-chain only
- computes pricing, fee, reserve, TTL, and quote expiry
- does not create a chain object
- does not emit lifecycle webhooks
- may persist quote metadata for replay protection, expiry, and later quote reconciliation

`POST /api/wire/jobs` responsibilities:
- off-chain persistence first
- binds accepted quote economics to a concrete job record
- persists client, provider, evaluator, spec hash, and metadata URI
- may enqueue the chain creation/funding workflow
- must not claim `FUNDED` before chain confirmation

`GET /api/wire/jobs/:id` responsibilities:
- reads the best available facilitator view
- must surface contract-authoritative state once known
- must not fabricate terminal outcomes before a chain-authoritative terminal signal or an explicitly modeled operator exception state

Product rule:
- pricing is allowed to be off-chain
- orchestration is allowed to be off-chain
- lifecycle finality is not

#### 8.3.6 Funding Authority Rule

`FUNDED` must be chain-authoritative.

That means:
- a job may be created off-chain in `OPEN`
- Ghost Protocol may have an internal pending state for transaction submission and receipt observation
- neither the API nor the webhook layer may project `FUNDED` until the funding transaction is confirmed according to the configured confirmation policy

Recommended v1 confirmation rule:
- `FUNDED` is emitted only after `2` confirmations on the supported production path and successful state reconciliation against the ERC-8183 contract view

Permitted internal states (off-chain only, not part of the public lifecycle contract):
- `PENDING_CREATE`
- `PENDING_FUND`
- `PENDING_CONFIRMATION`

Hard rule:
- internal orchestration states must never leak as substitutes for ERC-8183 lifecycle states in the public API contract
- if surfaced at all, they must appear as operator metadata, not as lifecycle replacements

### 8.4 Wire Webhook Contract

GhostWire webhooks must mirror the state machine exactly.

Required event set:
- `wire.job.open`
- `wire.job.funded`
- `wire.job.submitted`
- `wire.job.completed`
- `wire.job.rejected`
- `wire.job.expired`

Hard rules:
- one state transition maps to one webhook event
- no alias events such as `wire.job.opened`, `wire.job.finalized`, or `wire.job.closed`
- webhook naming must remain legible as a direct projection of the underlying lifecycle

Every webhook payload should include:
- `jobId`
- `quoteId`
- `state`
- `contractState`
- `pricing`

Terminal webhooks (`completed`, `rejected`, `expired`) must also include the full terminal `settlement` payload defined in section `8.3.3`.

### 8.4.1 Webhook Authentication Contract

GhostWire v1 webhooks should be authenticated with HMAC over the raw request body.

Required headers:
- `x-ghost-event-id`
- `x-ghost-event-type`
- `x-ghost-timestamp`
- `x-ghost-signature`
- `x-ghost-delivery-attempt`

Required signature format:
- `x-ghost-signature: v1=<hex_digest>`

Required verification behavior:
- compute HMAC-SHA256 against the raw body using the configured webhook secret
- reject signatures outside a `5` minute replay window
- dedupe on `x-ghost-event-id`

### 8.4.2 Webhook Emission and Idempotency Rules

Webhook emission must be idempotent and chain-aware.

Required rules:
- emit at most one webhook per `(jobId, contractState transition)`
- store an outbox/event ledger keyed by deterministic event identity before delivery attempts
- retries must replay the same event identity and payload, not synthesize a new event
- delivery failure must not mutate lifecycle state

Recommended event identity:
- `eventId = hash(jobId, contractState, sourceTxHash, logIndex)`

Product rule:
- webhook delivery semantics are at-least-once
- webhook payload identity must be exactly-once from the receiver's perspective if they dedupe on `eventId`

### 8.4.3 Reorg and Confirmation Rules

Webhook emission must respect chain reorg risk.

Recommended v1 behavior:
- do not emit state-transition webhooks from mempool observation
- do not emit from first-seen transaction broadcast alone
- emit only after the configured confirmation threshold and post-confirmation state reconciliation

Reorg handling rule:
- if a previously observed state transition is invalidated before webhook emission, suppress emission
- if a rare post-emission reorg invalidates a previously emitted transition, emit an explicit compensating operator event outside the lifecycle namespace

Hard rule:
- lifecycle webhooks themselves must remain reserved for actual reconciled ERC-8183 state transitions
- do not emit fake reversal lifecycle events just to mirror infrastructure uncertainty

Recommended compensating event namespace:
- `wire.operator.reorg_notice`
- `wire.operator.delivery_retry`

### 8.5 Dashboard Model

GhostWire should appear in the existing GhostGate merchant/consumer console as a second payment mode, not a detached standalone product.

Required dashboard concepts:
- rail selector or mode selector
- job status visibility
- evaluator identity visibility
- settlement outcome visibility
- expiry/refund visibility
- fee disclosure

V1 dashboard rule:
- dashboard surfaces wire lifecycle visibility and reconciliation state
- dashboard does not originate wire job writes in v1
- API and SDK remain the write surfaces for GhostWire

## 9. Pricing Model

Pricing target:

- `GhostGate express`: 5% protocol fee
- `GhostWire`: 2.5% protocol fee on successful completion only

Fee policy rule for v1:
- fee percentages are facilitator-configured and enforced in Ghost Protocol's quote and settlement layer
- fee percentages are not immutable smart-contract constants in v1
- changing express or wire fee bps is an application and operator policy change, not a contract redeploy event
- any future move to on-chain fee enforcement must be treated as a separate contract or hook design decision

GhostWire fee principles:
- no protocol fee on rejected or expired jobs
- gas handling must be explicit, not implied
- per-job network execution cost must be accounted for separately from protocol revenue so treasury is not silently subsidizing chain execution

### 9.1 Recommended Wire Quote Model

GhostWire should quote three distinct values:

- `principalAmount`: the amount intended for the provider if the job completes
- `protocolFee`: `principalAmount * 0.025`
- `networkReserve`: a conservative buffer for Ghost-sponsored on-chain lifecycle execution, denominated in the native gas token of the execution chain

V1 denomination rule:
- `networkReserve` is accounted for in the native gas token only
- on Base, that means ETH-denominated reserve accounting
- principal and protocol fee may still be denominated in the settlement asset (for example USDC)

Recommended all-in quote:

- `maxTotalAuthorization = principalAmount + protocolFee + networkReserve`

Because the quote spans two assets in v1, the product must expose them as separate line items rather than pretending they are one fungible number.

This is the cleanest way to make the "2.5% pure protocol fee" claim precise:
- protocol fee is protocol revenue
- network reserve is pass-through execution reimbursement
- principal is the economic value of the job itself

### 9.1.1 Quote Presentation Rule

GhostWire should present `networkReserve` in two forms:

- canonical value: native gas token amount
- display helper: estimated settlement-asset equivalent

Example on Base:
- `principalAmount = 500 USDC`
- `protocolFee = 12.5 USDC`
- `networkReserve = 0.003 ETH`
- display helper: `~$8.12 equivalent`

Accounting and refunds must use the canonical native-token amount, not the display estimate.

### 9.2 Recommended Settlement Accounting

Recommended v1 accounting model:

- the developer-configured job price maps to `principalAmount`
- provider payout should not be silently haircut for protocol margin
- GhostWire adds `protocolFee` and `networkReserve` on top of principal at quote time

Completed job:
- provider receives `principalAmount`
- Ghost Protocol recognizes `protocolFee` as revenue
- actual network spend is reimbursed from `networkReserve`
- unused `networkReserve` is refunded to the client

Rejected or expired job:
- provider receives `0`
- Ghost Protocol recognizes `0` protocol fee
- actual network spend is reimbursed from `networkReserve`
- unused `networkReserve` is refunded to the client

Operational rule:
- protocol fee must never be used to absorb gas
- provider principal must never be used to absorb gas
- settlement-asset balances must never be silently converted to cover gas variance

### 9.3 Marketing and Disclosure Rule

Do not market GhostWire as "gas-free."

Accurate language:
- gas is abstracted
- gas is operator-handled
- gas is reserve-backed and transparently netted
- gas reserve is held and reconciled in the native token of the execution chain

This is defensible. "Free gas" is not.

Inaccurate v1 language to avoid:
- "single all-in stablecoin quote"
- "gas-free escrow"
- "stablecoin principal automatically covers gas"

This is a product requirement, not yet a finalized accounting implementation. Final fee and gas treatment must be locked during contract and settlement design.

## 10. Operational Model

GhostWire needs managed automation to be commercially useful.

Required operator responsibilities:
- detect funded/open/submitted/terminal state changes
- trigger or assist expiry/reclaim workflows
- maintain index of live jobs and status transitions
- surface failures and stuck jobs
- support retry-safe orchestration around chain events

Ghost Protocol must treat this as payment infrastructure:
- monitored
- replay-safe
- idempotent
- auditable

### 10.1 Hosted Operator Default

Recommended v1 default:
- Ghost Protocol runs the hosted operator/keeper service for GhostWire jobs

Default operator responsibilities:
- create or relay managed lifecycle transactions where Ghost sponsorship is enabled
- monitor job state transitions
- trigger expiry/reclaim automation on schedule
- record actual network spend against each job
- surface stuck jobs and operator exceptions

### 10.2 Expiry and Gas Sponsorship

Recommended v1 policy:
- Ghost-hosted operator pays gas first from the operator wallet when sponsorship/relay mode is enabled
- reimbursement comes from the job's `networkReserve`, not from treasury margin

Expiry rule:
- Ghost-hosted operator should trigger expiry/reclaim automatically on a bounded cadence
- counterparties should still be able to complete the standard flow directly if they choose not to rely on the hosted operator path

This preserves the standard's trust model while still offering managed UX.

### 10.3 Reimbursement and Netting

Recommended v1 reimbursement path:
- actual sponsored lifecycle gas is logged per job
- actual spend is deducted from `networkReserve`
- any unused reserve is refunded at terminal settlement

Exception rule:
- if actual spend exceeds the quoted reserve, the shortfall is an operator exception and must not be silently taken from provider principal or protocol fee
- v1 should solve this with conservative reserve quoting and operator alerting, not with hidden treasury subsidy

### 10.4 Authoritative Source of Truth Rule

GhostWire must operate with a strict source-of-truth hierarchy:

1. ERC-8183 contract state on-chain
2. confirmed chain event reconciliation in Ghost Protocol persistence
3. operator/orchestration metadata

Implications:
- on-chain lifecycle state wins over local worker assumptions
- local job records are caches and workflow state, not the final authority on commerce outcome
- terminal settlement reporting must be derived from reconciled chain outcome plus logged operator spend, never from optimistic worker assumptions

## 11. Evaluator Strategy

GhostWire v1 should keep evaluator policy narrow.

Recommended v1:
- client supplies evaluator address
- Ghost Protocol provides validation and helper tooling only

Hard rule for v1:
- no silent default to a Ghost-hosted evaluator
- no requirement that Ghost act as evaluator for the job to proceed

Deferred:
- Ghost-hosted evaluator marketplace
- managed evaluator oracle product
- automated subjective evaluation policies

Reason:
- evaluator trust and liability are separate from escrow orchestration
- combining them too early increases product and policy risk

### 11.1 Recommended v1.5 Policy

Ghost-hosted evaluator routing can be introduced later as an explicit convenience layer, not as the default contract path.

Recommended v1.5 shape:
- `evaluationMode: "client" | "ghost-routed"`
- default remains `"client"`
- `ghost-routed` is opt-in only

Guardrails for `ghost-routed`:
- restricted to supported job categories
- explicit evaluator policy/version disclosure
- explicit fee disclosure if routing adds cost
- notional caps for early rollout
- clear ToS and dispute-language updates before launch

## 12. GhostRank Integration

GhostRank should become a premium GhostWire differentiator, not a launch blocker.

Planned integrations:
- provider eligibility filters based on GhostRank or ERC-8004-derived signals
- future hook templates for reputation-gated jobs
- dashboard policy presets such as:
  - minimum reputation
  - known evaluator allowlists
  - provider screening thresholds

These are later differentiators, not v1 dependencies.

## 13. Relationship to x402

GhostWire is complementary to the x402 compatibility layer already shipped in GhostGate.

Current state:
- GhostGate supports x402-style transport envelopes at the edge when enabled
- this is transport interoperability only

Planned state:
- GhostWire may use x402/HTTP or similar machine-facing flows at the interface layer
- underlying escrow and settlement logic remains ERC-8183-based

In short:
- x402 solves interface compatibility
- ERC-8183 solves trustless commerce lifecycle
- Ghost Protocol sits between them as the facilitator layer

## 14. Risks and Constraints

GhostWire is materially riskier than GhostGate express.

Primary risks:
- contract correctness and audit burden
- evaluator trust model ambiguity
- gas volatility and quote accuracy
- stuck-job operational complexity
- user confusion between fast-pay rail and escrow rail

Therefore GhostWire must launch later and narrower than GhostGate express.

## 15. Rollout Plan

Recommended sequence:

1. Lock product spec and fee policy
2. Lock ERC-8183 facilitator scope for v1
3. Build testnet implementation only
4. Add operator automation and observability
5. Security review of contract integration and off-chain workflow
6. Run constrained mainnet pilot
7. Expand SDK and dashboard support

## 16. Success Criteria

GhostWire v1 is successful when:

- a developer can create and monitor an ERC-8183-backed job without writing direct contract orchestration code
- expiry/reclaim behavior is automated and observable
- SDK ergonomics are clearly simpler than raw standard usage
- Ghost Protocol captures facilitator fees without hidden treasury subsidy
- GhostWire and GhostGate express coexist without confusing developers or users

## 17. Naming Decision

Previous internal placeholder: `GhostShield`

Adopted product name:
- `GhostWire`

Rationale:
- better expresses the slower, heavier, higher-trust settlement rail
- pairs naturally with GhostGate under one payment-routing umbrella
- avoids implying an unbounded guarantee surface that the product may not own in v1
- keeps the shipping product architecture simple: GhostGate package, `express` mode, `wire` mode
