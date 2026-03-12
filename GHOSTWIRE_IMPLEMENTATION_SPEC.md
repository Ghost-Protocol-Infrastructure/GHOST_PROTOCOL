# GhostWire Implementation Spec

Status: Active, implementation in progress
Depends on: `GHOSTWIRE_PRODUCT_SPEC.md`
Scope: Persistence, worker orchestration, reconciliation, webhook delivery, and settlement derivation for GhostWire v1

## 1. Purpose

This document defines how GhostWire should be built operationally.

It is intentionally narrower and more technical than the GhostWire product spec. The product spec answers:
- what GhostWire is
- why it exists
- how it is positioned

This implementation spec answers:
- what data Ghost Protocol must persist
- which states are public vs internal
- which parts of the flow are off-chain vs chain-authoritative
- how workers coordinate lifecycle transitions
- how webhooks are emitted safely
- how terminal settlement payloads are derived

## 2. Implementation Goals

GhostWire v1 must:
- preserve the ERC-8183 lifecycle as the public commerce state machine
- keep pricing/orchestration off-chain where appropriate
- keep fee policy facilitator-configured and off-chain in v1
- treat on-chain lifecycle state as the authority for funding and terminal outcomes
- keep webhook emission idempotent and chain-aware
- keep protocol fee, provider principal, and gas reserve accounting separate

Fee authority rule:
- fee bps are owned by Ghost Protocol's facilitator layer in v1
- the contract lifecycle must not assume a fixed fee bps constant
- `express` and `wire` may use different fee policies without requiring a contract redeploy
- if a future ERC-8183 hook or settlement contract hardcodes fee policy, that is a new contract-surface decision and out of scope for v1

## 3. Non-Goals

This spec does not define:
- a proprietary escrow contract
- a custom lifecycle that replaces ERC-8183
- multi-chain orchestration in v1
- Ghost-hosted evaluator routing as the default path
- support for arbitrary custom hooks in v1

## 3.1 Pinned Contract Surface

GhostWire v1 must target one pinned ERC-8183 implementation and ABI surface.

Rules:
- pin the implementation by commit, ABI, and deployed contract address set
- do not follow upstream ERC-8183 implementation changes automatically
- treat upgrades as explicit versioned migrations
- do not enable custom hooks in v1

## 4. Source of Truth Hierarchy

GhostWire must obey this authority order:

1. ERC-8183 contract state on-chain
2. reconciled chain-event persistence in Ghost Protocol
3. operator/workflow metadata

Implications:
- public lifecycle fields must mirror reconciled ERC-8183 state
- internal workflow metadata may exist, but must not replace lifecycle truth
- terminal settlement payloads must be derived from reconciled lifecycle plus recorded operator spend

## 5. Persistence Model

GhostWire should persist at least the following model families.

### 5.1 `WireQuote`

Purpose:
- freeze economics before job creation
- support quote expiry and replay protection

Recommended fields:
- `id`
- `quoteId`
- `clientAddress` (nullable until create if quote is generic)
- `providerAddress`
- `evaluatorAddress`
- `chainId`
- `settlementAsset`
- `principalAmount`
- `protocolFeeAmount`
- `networkReserveAmount`
- `networkReserveAsset` (native gas token symbol)
- `networkReserveDecimals`
- `displayReserveEstimateAmount` (optional, informational only)
- `displayReserveEstimateAsset` (optional)
- `jobType`
- `ttlSeconds`
- `expiresAt`
- `consumedAt` (nullable)
- `createdAt`

Constraints:
- unique `quoteId`
- consumed exactly once

### 5.2 `WireJob`

Purpose:
- canonical Ghost-side record of a wire job

Recommended fields:
- `id`
- `jobId`
- `quoteId`
- `chainId`
- `contractAddress`
- `contractJobId` (or equivalent on-chain identifier)
- `clientAddress`
- `providerAddress`
- `evaluatorAddress`
- `settlementAsset`
- `principalAmount`
- `protocolFeeAmount`
- `networkReserveAmount`
- `networkReserveAsset`
- `specHash`
- `metadataUri`
- `contractState`
- `publicState`
- `terminalDisposition` (nullable)
- `createTxHash` (nullable)
- `fundTxHash` (nullable)
- `terminalTxHash` (nullable)
- `createdAt`
- `updatedAt`

Constraints:
- unique `jobId`
- unique `quoteId`
- unique `(chainId, contractAddress, contractJobId)` when available

### 5.3 `WireJobWorkflow`

Purpose:
- hold internal orchestration metadata only

Recommended fields:
- `wireJobId`
- `createStatus`
- `fundStatus`
- `confirmationStatus`
- `reconcileStatus`
- `lastError`
- `lastAttemptAt`
- `retryCount`
- `nextRetryAt`

Important:
- this model is not public lifecycle state
- it should never be serialized as a replacement for ERC-8183 state

### 5.4 `WireJobTransition`

Purpose:
- audit trail of reconciled lifecycle transitions

Recommended fields:
- `id`
- `wireJobId`
- `fromState`
- `toState`
- `sourceTxHash`
- `sourceLogIndex`
- `blockNumber`
- `observedAt`
- `confirmedAt`

Constraint:
- unique `(wireJobId, toState, sourceTxHash, sourceLogIndex)`

### 5.5 `WireOperatorSpend`

Purpose:
- record actual sponsored gas spent by Ghost operator infrastructure

Recommended fields:
- `id`
- `wireJobId`
- `actionType` (`CREATE`, `FUND`, `COMPLETE`, `REJECT`, `EXPIRE`, `RECLAIM`, etc.)
- `txHash`
- `nativeAsset`
- `gasUsed`
- `effectiveGasPrice`
- `nativeAmountSpent`
- `recordedAt`

Constraint:
- unique `txHash`

### 5.6 `WireWebhookOutbox`

Purpose:
- durable, retry-safe webhook delivery

Recommended fields:
- `id`
- `eventId`
- `wireJobId`
- `eventType`
- `state`
- `contractState`
- `payloadJson`
- `deliveryStatus` (`PENDING`, `DELIVERED`, `FAILED`, `DEAD_LETTER`)
- `attemptCount`
- `lastAttemptAt`
- `nextAttemptAt`
- `deliveredAt`
- `lastError`
- `createdAt`

Constraint:
- unique `eventId`

## 6. Public vs Internal State

### 6.1 Public Lifecycle State

Public lifecycle state should mirror ERC-8183:
- `OPEN`
- `FUNDED`
- `SUBMITTED`
- `COMPLETED`
- `REJECTED`
- `EXPIRED`

### 6.2 Internal Workflow State

Permitted internal-only statuses:
- `PENDING_CREATE`
- `PENDING_FUND`
- `PENDING_CONFIRMATION`
- `PENDING_RECONCILE`
- `WEBHOOK_PENDING`
- `OPERATOR_EXCEPTION`

Hard rule:
- internal workflow states must never be emitted as lifecycle substitutes in public APIs or lifecycle webhooks

## 7. API Responsibilities

### 7.1 `POST /api/wire/quote`

Responsibilities:
- compute economics off-chain
- create a short-lived quote
- persist the immutable quote record

Must not:
- create an on-chain job
- emit lifecycle webhooks
- imply any on-chain finality

### 7.2 `POST /api/wire/jobs`

Responsibilities:
- validate `quoteId`
- reject expired or already-consumed quotes
- create the Ghost-side `WireJob` record
- mark the quote as consumed exactly once
- enqueue create/fund orchestration

Must not:
- accept raw replacement values for principal/protocolFee/networkReserve
- project `FUNDED` before chain confirmation

### 7.3 `GET /api/wire/jobs/:id`

Responsibilities:
- expose the best reconciled view of job state
- return pricing buckets exactly as quoted
- return terminal settlement payload when terminal

Must not:
- fabricate terminal outcomes from worker assumptions alone

## 8. Confirmation Policy

### 8.0 Supported Assets Policy

GhostWire v1 should launch with a narrow supported-asset matrix.

Recommended v1:
- one settlement asset across the Base family
- one native gas token reserve model

Initial recommendation:
- production chain: `8453` (Base mainnet)
- non-production chain: `84532` (Base Sepolia)
- `settlementAsset = USDC`
- `networkReserveAsset = ETH`

Reason:
- minimizes pricing ambiguity
- minimizes test matrix size
- keeps reserve accounting simple
- reduces operator exception cases in the pilot

Hard rule:
- unsupported settlement assets must fail at quote time
- quote responses must always return both the settlement asset and native reserve asset explicitly

Deferred:
- multi-asset settlement support
- multi-chain reserve policies
- automatic route selection across chains/assets

### 8.1 Funding Confirmation

`FUNDED` is chain-authoritative.

Recommended v1 rule:
- emit or expose `FUNDED` only after:
  - transaction receipt exists
  - configured confirmation threshold is met
  - contract state reconciliation confirms funding

Recommended configuration:
- `GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET=2`
- `GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET=1`

These are defaults, not hardcoded protocol constants.

### 8.1.1 Confirmation Threshold Rules

Recommended v1 confirmation policy:
- `OPEN`: may be exposed immediately after off-chain creation
- `FUNDED`: only after receipt + threshold + reconciliation
- `SUBMITTED`: only after receipt + threshold + reconciliation
- terminal states (`COMPLETED`, `REJECTED`, `EXPIRED`): only after receipt + threshold + reconciliation

Hard rule:
- the same confirmation discipline must be applied to lifecycle webhooks and public API state
- do not let API reads become more optimistic than webhook emission

### 8.1.2 Confirmation Metadata

GhostWire should persist confirmation metadata alongside transitions:
- `blockNumber`
- `txHash`
- `logIndex`
- `confirmationsAtObservation`
- `confirmedAt`

Purpose:
- operator debugging
- support auditability
- deterministic replay/reconciliation

### 8.2 Terminal Confirmation

`COMPLETED`, `REJECTED`, and `EXPIRED` must also be chain-authoritative.

Recommended v1 rule:
- do not emit terminal lifecycle webhooks from transaction submission alone
- emit only after confirmation threshold and state reconciliation

## 9. Worker Model

GhostWire v1 should use separate workers with clear ownership.

Operator rule:
- Ghost Protocol is the default lifecycle operator for GhostWire v1
- Ghost-managed workers are responsible for create, fund, reconcile, expiry, reclaim, and webhook delivery flows where sponsorship is enabled
- counterparties may still interact directly with the underlying ERC-8183 contract surface, but GhostWire's public lifecycle and webhooks are derived from Ghost-side reconciliation

### 9.1 Quote Expiry Worker

Responsibilities:
- mark expired unused quotes
- clear stale quote eligibility

Locked v1 quote policy:
- `quoteId` TTL is `600` seconds
- each quote is single-use only
- reserve values are calculated at quote issuance and do not drift after issuance
- reserve quoting must include a conservative buffer against gas variance

### 9.2 Job Create/Fund Worker

Responsibilities:
- process newly created `WireJob` records
- submit create/fund transactions when Ghost-sponsored flow is enabled
- persist tx hashes
- advance internal workflow state

V1 default:
- Ghost-sponsored flow is the default operating mode for GhostWire v1

### 9.3 Reconciliation Worker

Responsibilities:
- read contract events and/or direct contract state
- reconcile public lifecycle state
- persist `WireJobTransition` records
- enqueue webhook outbox records

This worker is the bridge from chain-authoritative state to public API/webhooks.

### 9.4 Expiry/Reclaim Worker

Responsibilities:
- detect eligible expiries
- submit reclaim/expiry transactions when operator-managed path is enabled
- record gas spend
- let reconciliation finalize public lifecycle transitions

### 9.5 Webhook Delivery Worker

Responsibilities:
- deliver outbox events
- retry with backoff
- never mutate job lifecycle as a side effect of delivery success/failure

Recommended delivery semantics:
- at-least-once delivery
- deterministic payload and `eventId`

## 9.6 Operator Failure Handling

GhostWire v1 must define operator failure behavior explicitly.

### 9.6.1 Failure Classes

Track failures by class:
- `RPC_FAILURE`
- `TX_SUBMISSION_FAILURE`
- `CONFIRMATION_TIMEOUT`
- `RECONCILIATION_MISMATCH`
- `WEBHOOK_DELIVERY_FAILURE`
- `RESERVE_SHORTFALL`
- `UNEXPECTED_CONTRACT_STATE`

These classes should be persisted in operator metadata and surfaced in internal dashboards/alerts.

### 9.6.2 Retry Policy

Recommended v1 retry policy:
- bounded retries with exponential backoff
- jittered scheduling for worker retries
- dead-letter or manual-review transition after max attempts

Hard rule:
- retrying an operator action must not create duplicate public lifecycle transitions
- retries operate on workflow metadata and outbox records, not on synthetic state mutation

### 9.6.3 Circuit Breaker Policy

GhostWire should support circuit breakers for repeated systemic faults.

Recommended triggers:
- repeated RPC/provider failures above threshold
- repeated reconciliation mismatches above threshold
- reserve shortfall frequency above threshold

Recommended response:
- pause new wire job creation for the affected route/chain/asset combination
- continue read/reconciliation flows
- surface degraded operator status internally

Hard rule:
- circuit breakers must fail closed for new writes, not corrupt existing jobs

### 9.6.4 Manual Intervention Policy

Some operator failures require explicit manual review.

Recommended manual-review triggers:
- reserve shortfall
- terminal state mismatch between local persistence and contract view
- repeated expiry transaction failure
- inconsistent settlement derivation inputs

Manual-review rule:
- manual intervention may unblock workflow metadata
- manual intervention must not rewrite chain-authoritative lifecycle history

## 10. Webhook Idempotency

### 10.0 Webhook Authentication

GhostWire v1 should authenticate webhooks with HMAC-SHA256 over the raw request body.

Required headers:
- `x-ghost-event-id`
- `x-ghost-event-type`
- `x-ghost-timestamp`
- `x-ghost-signature`
- `x-ghost-delivery-attempt`

Required signature format:
- `x-ghost-signature: v1=<hex_digest>`

Replay protection:
- receivers reject timestamps older than `5` minutes
- receivers dedupe on `x-ghost-event-id`

### 10.1 Event Identity

Recommended event identity:

- `eventId = hash(jobId, contractState, sourceTxHash, logIndex)`

This should be persisted before first delivery.

### 10.2 Delivery Rules

Required rules:
- emit at most one event per reconciled state transition
- retries reuse the same `eventId`
- retries reuse the same payload body
- receiver dedupe on `eventId` must be sufficient to achieve exactly-once business handling

### 10.3 Delivery Failure Rules

Required rules:
- webhook delivery failure must not roll back lifecycle state
- delivery failure must not create alternate lifecycle events
- repeated failure moves the event to dead-letter handling, not state mutation

## 11. Reorg Handling

### 11.1 Pre-Emission Reorg

If a candidate transition is invalidated before webhook emission:
- suppress lifecycle webhook emission
- keep reconciliation state authoritative

### 11.2 Post-Emission Reorg

If a rare reorg invalidates an already-emitted lifecycle transition:
- do not emit fake lifecycle reversal events
- emit an operator-side compensating event outside the lifecycle namespace

Recommended event namespace:
- `wire.operator.reorg_notice`
- `wire.operator.delivery_retry`

## 12. Terminal Settlement Derivation

Terminal settlement payloads must be derived, not hand-assembled ad hoc.

### 12.1 Required Fields

For every terminal job, return:
- `providerPayout`
- `protocolRevenue`
- `actualNetworkSpend`
- `unusedNetworkReserveRefund`

### 12.2 Derivation Rules

Completed:
- `providerPayout = principalAmount`
- `protocolRevenue = protocolFeeAmount`
- `actualNetworkSpend = sum(WireOperatorSpend.nativeAmountSpent)`
- `unusedNetworkReserveRefund = max(networkReserveAmount - actualNetworkSpend, 0)`

Rejected or expired:
- `providerPayout = 0`
- `protocolRevenue = 0`
- `actualNetworkSpend = sum(WireOperatorSpend.nativeAmountSpent)`
- `unusedNetworkReserveRefund = max(networkReserveAmount - actualNetworkSpend, 0)`

### 12.3 Overspend Rule

If `actualNetworkSpend > networkReserveAmount`:
- do not reduce `providerPayout`
- do not reduce `protocolRevenue`
- record an operator exception
- report zero refund

V1 mitigation:
- conservative reserve quoting
- operator alerting
- manual review for reserve shortfall events

## 13. Security and Invariants

Required invariants:
- each `WireQuote` is consumed at most once
- each public lifecycle transition is backed by reconciled chain state
- each webhook lifecycle event is emitted at most once per transition identity
- protocol fee is never used to absorb gas
- provider principal is never used to absorb gas
- native-token reserve accounting is never replaced by a display estimate

Operational invariants:
- unsupported assets cannot progress past quote validation
- confirmation threshold policy is applied uniformly across API and webhook surfaces
- operator retries cannot manufacture duplicate lifecycle transitions
- operator failure handling cannot mutate reconciled chain history

## 14. Recommended Rollout Sequence

1. Implement persistence models
2. Implement quote/create endpoints
3. Implement create/fund worker
4. Implement reconciliation worker
5. Implement expiry/reclaim worker
6. Implement webhook outbox
7. Validate settlement derivation against testnet jobs
8. Run pilot with constrained notional and supported assets only

V1 surface rule:
- API and SDK are the write surfaces for GhostWire
- dashboard is read-only for wire flows in v1
