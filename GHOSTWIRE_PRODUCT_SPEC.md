# GhostWire Product Spec

Status: Live on Base, direct-only
Owner: Ghost Protocol
Product Surface: GhostGate umbrella, `wire` mode / GhostWire

## 1. Intent

GhostWire is Ghost Protocol's direct ERC-8183 escrow rail for higher-value agent work.

It exists for jobs that are too valuable, too stateful, or too trust-sensitive for GhostGate's fast credit-backed request path.

GhostWire is not a hosted counterparty flow. Ghost does not fund the job, does not custody the buyer's principal, and does not originate the buyer's on-chain transactions.

## 2. Product Positioning

Ghost Protocol has two commerce rails:

- `GhostGate`: fast paid access for chat-speed API and tool requests
- `GhostWire`: direct escrow for higher-value job-based work

GhostWire should be described as:

- direct escrow
- client-funded
- ERC-8183-based
- Base-native

GhostWire should not be described as:

- hosted escrow
- operator-fronted execution
- platform-fronted execution
- sponsorship-first

## 3. Core Model

GhostWire keeps one economic and one lifecycle model.

Economic model:

- buyer requests a quote
- buyer pays the escrowed amount directly from their wallet
- provider is paid on successful completion
- Ghost earns a protocol fee only on successful completion
- buyer pays gas directly

Lifecycle model:

- quote
- prepare
- client approve/create/fund
- provider submit
- evaluator complete or reject
- consumer resolve final payload

Ghost may observe, validate, reconcile, and surface this flow, but Ghost is not the on-chain client.

## 4. Roles

GhostWire has four explicit roles:

- `client`
  - external customer wallet
  - approves USDC when needed
  - creates the job
  - sets budget
  - funds the job
  - can reclaim refunds where contract policy allows
- `provider`
  - merchant payout wallet
  - performs the work
  - submits the deliverable hash on-chain
- `evaluator`
  - approval/review wallet for the job
  - completes or rejects after provider submission
- `Ghost Protocol`
  - quote generation
  - wallet-ready transaction preparation
  - artifact validation
  - bounded recovery discovery
  - reconciliation
  - status APIs
  - provider-facing webhooks

Hard rule:

- Ghost is not the default evaluator for third-party merchants.

## 5. Contract and Chain Scope

GhostWire uses the pinned `AgenticCommerce` ERC-8183 contract surface.

Locked scope:

- Base mainnet for production
- Base Sepolia for non-production testing
- one pinned contract/ABI surface
- no new GhostWire-specific contract
- no automatic contract-surface drift

## 6. Pricing and Settlement

Current quote economics are:

- `principal`
- `protocolFee`

Gas is paid by the client wallet directly and is not part of the GhostWire quote charge.

Current fee policy:

- protocol fee: `250 bps` on successful completion only
- no protocol fee on rejected or expired jobs

Terminal settlement rules:

- `COMPLETED`
  - provider receives `principal - protocolFee`
  - Ghost treasury receives `protocolFee`
- `REJECTED`
  - provider receives `0`
  - Ghost treasury receives `0`
  - buyer can recover funds according to the contract path
- `EXPIRED`
  - provider receives `0`
  - Ghost treasury receives `0`
  - buyer can recover funds according to the contract path

Hard rules:

- GhostWire must not be marketed as gas-free.
- GhostWire must not imply Ghost fronts buyer principal.

## 7. API Contract

GhostWire's public API is direct-only.

### 7.1 `POST /api/wire/quote`

Purpose:

- validate requested counterparties and chain
- price the job
- issue a short-lived quote for direct client funding

Required request fields:

- `client`
- `provider`
- `evaluator`
- `principalAmount`
- `chainId`

Required response concepts:

- `quoteId`
- `expiresAt`
- `pricing.principal`
- `pricing.protocolFee`
- contract address / token context for the chosen chain

### 7.2 `POST /api/wire/jobs`

Purpose:

- create a prepared GhostWire job from a valid quote
- return wallet-ready transaction requests for the client-funded path

Required request fields:

- `quoteId`
- `client`
- `provider`
- `evaluator`
- `specHash`
- optional `metadataUri`

Required response concepts:

- `jobId`
- `state`
- `approveTxRequest` when allowance is insufficient
- `createTxRequest`
- after artifact validation, `setBudgetTxRequest`
- after artifact validation, `fundTxRequest`

Hard rule:

- the API returns wallet-ready transaction requests, not a server-executed settlement result

### 7.3 `POST /api/wire/jobs/[jobId]/artifacts`

Purpose:

- record and validate direct client transaction artifacts
- advance the prepared off-chain record only when the chain evidence matches the prepared job

Requirements:

- signed client-wallet authorization
- rate limiting
- idempotent artifact recording
- mismatch-safe validation

Quote expiry rule:

- quote expiry gates job preparation
- quote expiry does not block later artifact recording if the on-chain job already exists and matches the prepared job

### 7.4 `GET /api/wire/jobs/[jobId]`

Purpose:

- return the reconciled GhostWire job state
- expose terminal settlement payloads when available
- expose deliverable resolution hints after completion

GhostWire must keep on-chain lifecycle and API lifecycle aligned:

- `OPEN`
- `FUNDED`
- `SUBMITTED`
- `COMPLETED`
- `REJECTED`
- `EXPIRED`

## 8. Deliverables

Providers are responsible for the payload itself. GhostWire is the escrow and status rail.

Recommended deliverable model:

- provider stores the payload off-chain
- provider submits the deliverable hash on-chain
- provider exposes a consumer fetch path via `metadataUri` or registered gateway endpoint

GhostWire resolves consumer-facing deliverable locators in this order:

1. explicit `http://` or `https://` `metadataUri`
2. explicit `ipfs://` `metadataUri` through a public IPFS gateway
3. standard fallback from the merchant's registered gateway endpoint

Hard rule:

- GhostWire must surface a locator when one can be derived
- GhostWire must not claim a payload is fetchable when no valid locator exists

## 9. Reconciliation and Recovery

GhostWire is direct-only, but it still requires backend reconciliation.

Ghost is responsible for:

- validating `create` and `fund` artifacts
- tracking on-chain lifecycle transitions
- reconciling terminal outcomes
- emitting provider-facing webhook events
- supporting bounded recovery for recently prepared jobs missing reported artifacts

Recovery rules:

- artifact-report grace window exists before passive recovery kicks in
- passive orphan discovery is bounded by time, job count, and block scan window
- older no-artifact cases become explicit recovery cases, not infinite background scans

Hard rule:

- no server-side GhostWire code originates `create` or `fund`

## 10. Webhooks

GhostWire webhooks are provider-facing in the current launch shape.

Lifecycle events:

- `wire.job.open`
- `wire.job.funded`
- `wire.job.submitted`
- `wire.job.completed`
- `wire.job.rejected`
- `wire.job.expired`

Webhook rules:

- signed delivery
- deterministic event identity
- at-least-once delivery
- retries without payload mutation

Consumer-facing completion resolution is currently handled through polling and fetch, not consumer webhooks.

## 11. SDK Contract

GhostWire remains inside the GhostGate SDK/package surfaces.

The public SDK should expose direct GhostWire helpers, including:

- quote creation
- job preparation
- artifact recording
- job polling
- terminal wait helpers
- deliverable resolution helpers

Hard rule:

- public SDKs must default to the direct GhostWire path
- no hosted GhostWire public methods remain in the supported surface

## 12. Non-Goals

Out of scope for the current production shape:

- sponsorship / relay execution
- Ghost-funded create/fund
- hosted GhostWire execution mode
- dashboard-originated write actions
- evaluator marketplace
- cross-chain GhostWire orchestration
- custom escrow contracts

## 13. Launch Truth

These statements must remain true in docs and marketing:

- GhostWire is live as a direct escrow rail on Base.
- The client wallet is the on-chain client.
- The client pays gas directly.
- Ghost provides orchestration, validation, reconciliation, status, and webhooks.
- Sponsorship / relays are not part of the current launch shape.

## 14. Success Criteria

GhostWire is working when:

- buyers can quote, prepare, create, and fund jobs directly
- providers can submit deliverables on-chain
- evaluators can complete or reject on-chain
- providers receive payout on completion
- Ghost receives protocol fee on completion
- consumers can resolve and fetch completed payloads
- GhostRank can attribute eligible terminal GhostWire outcomes to providers

## 15. Naming Decision

Adopted product name:

- `GhostWire`

Packaging rule:

- `GhostGate` remains the umbrella SDK/package surface
- `GhostWire` remains the escrow rail name inside that product family
