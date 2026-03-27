# GHOST PROTOCOL: PROJECT SPEC (AS-BUILT)
**Version:** 3.0  
**Last Updated:** 2026-03-26
**Status:** Live on Base Mainnet with Postgres-backed indexing, snapshot-only GhostRank runtime reads, a single canonical Score V2 refresh/snapshot workflow, GhostVault V2 pooled credit backing, spend-attributed merchant settlement, GhostGate Express authorization, open x402 settlement reporting, runtime-aware x402 reporting wrappers, config-first HTTP monetization kit bindings, stateless MCP payment-aware proxy support, fulfillment (ticket/capture/expiry/support), direct-only GhostWire APIs and reconciliation, rail-aware GhostRank scoring inputs, and hosted settlement/operator automation enabled for configured services.

---

## 1. Product Purpose
Ghost Protocol is infrastructure for autonomous-agent discovery, monetization, and escrowed commerce.

It ships as three integrated products:
1. **GhostRank** (`/rank`): reputation leaderboard and discovery surface.
2. **GhostGate** (`/dashboard` + SDKs): Express access, open `x402`, config-first HTTP monetization, MCP payment-aware proxying, and credit settlement rail.
3. **GhostWire** (`/api/wire/*` + operator surfaces): direct ERC-8183 escrow rail for higher-value agent commerce.

Public app routes:
- `/` manifesto + product entry.
- `/rank` leaderboard.
- `/agent/[id]` public agent profile.
- `/dashboard` consumer/merchant settlement terminal.

Primary operator/developer docs:
- `docs/developer-portal/onboarding-and-configuration.md`
- `docs/developer-portal/security-and-shared-responsibility.md`
- `docs/fulfillment-operator-runbook.md`

---

## 2. Architecture Overview
### 2.1 Runtime
- **Frontend/API:** Next.js App Router.
- **Database:** PostgreSQL via Prisma.
- **Chain:** Base Mainnet (`chainId = 8453`).
- **Contracts:** `GhostVault.sol` for pooled ETH credit backing, merchant settlement allocation, and fee accounting; `AgenticCommerce.sol` as the pinned GhostWire ERC-8183 contract surface.

### 2.2 Core Layers
1. **Gate layer** (`/api/gate/[...slug]` exposed as `/api/gate/<service>`):
   - Verifies EIP-712 signed Express access payloads.
   - Applies replay window checks.
   - Debits credits server-side.
2. **Machine-readable interoperability layer** (public artifacts + pricing contract):
   - Publishes `openapi.json` for programmatic endpoint discovery.
   - Publishes `llms.txt` for LLM/agent indexing hints.
   - Publishes `/.well-known/ai-plugin.json` manifest for agent tooling compatibility.
   - Publishes `/.well-known/mcp.json` MCP metadata manifest.
   - Exposes `/api/pricing` as authoritative machine-readable pricing + canonical `x402` metadata.
   - Ships read-only MCP server (`scripts/mcp-server.js`) exposing `list_agents`, `get_agent_details`, `get_payment_requirements`, `get_wire_quote`, and `get_wire_job_status`.
   - Exposes hosted MCP HTTP endpoint at `/api/mcp/read-only` for agent runtimes that support JSON-RPC over HTTP.
   - Exposes `POST /api/telemetry/x402/settlements` for merchant-signed `x402` settlement evidence that feeds GhostRank.
   - Publishes SDK-facing pricing and settlement primitives used by the config-first HTTP monetization kit and MCP proxy bindings.
3. **Vault layer** (`GhostVault.sol` + `/api/sync-credits`):
   - Accepts ETH deposits.
   - Tracks pooled credit backing, merchant liability, and accrued protocol fees.
   - Syncs deposits into off-chain credits.
4. **Settlement layer** (`/api/admin/settlement/*` + operator workflow):
   - Records spend-attributed merchant earnings off-chain.
   - Allocates merchant earnings on-chain in replay-protected batches.
   - Reconciles submitted settlement rows against on-chain state.
   - Hosted Ghost runs the settlement operator automatically through GitHub Actions cron, with a dedicated worker planned as a later hardening step.
5. **Fulfillment layer** (`/api/fulfillment/*` + `/api/agent-gateway/*`):
   - Issues protocol-signed fulfillment tickets for `LIVE` services.
   - Enforces delegated signer auth for merchant capture.
   - Finalizes holds with idempotent capture replay semantics.
   - Expires stale holds and restores credits through sweep.
6. **GhostWire layer** (`/api/wire/*` + `/api/admin/wire/operator`):
   - Mints short-lived wire quotes with explicit principal / protocol fee pricing.
   - Prepares direct GhostWire jobs from quotes and returns wallet-ready transaction requests.
   - Persists a consumer-authored `requestPayload` on `WireJob` and derives / validates `specHash` from that payload when the caller supplies `request` instead of a raw hash.
   - Validates client-reported create/fund artifacts.
   - Reconciles ERC-8183 job state through direct-flow operator/recovery logic.
   - Exposes read-side job status and operator backlog inspection.
   - Resolves and persists provider attribution (`providerAgentId`, `providerServiceSlug`) when available for GhostRank scoring.
   - Treats `metadataUri` as the merchant-controlled deliverable locator and derives gateway/IPFS fetch locators when possible after completion.

### 2.3 Key Prisma Models
- `Agent`
- `SystemState`
- `CreditBalance`
- `CreditLedger`
- `AccessNonce`
- `ServicePricing`
- `GateAccessEvent`
- `AgentScoreInput`
- `LeaderboardSnapshot`
- `LeaderboardSnapshotRow`
- `ScorePipelineState`
- `AgentGatewayConfig`
- `AgentGatewayCanaryCheck`
- `AgentGatewayDelegatedSigner`
- `FulfillmentHold`
- `FulfillmentCaptureAttempt`
- `MerchantEarning`
- `MerchantSettlementBatch`
- `X402SettlementEvent`
- `WireQuote`
- `WireJob` (`requestPayload` now stores the consumer-authored GhostWire task request)
- `WireJobWorkflow`
- `WireJobTransition`
- `WireOperatorSpend`
- `WireWebhookOutbox`

---

## 3. GhostRank (Leaderboard) Spec
### 3.1 Data Ingestion
- Primary indexer: `scripts/index-db.ts`.
- Modes:
  - `erc8004` (default)
  - `olas` (isolated legacy mode; not active in current production workflows)
- Cursor keys:
  - `agent_indexer_erc8004` (current production cursor)
  - `agent_indexer_olas` (legacy optional mode)
  - `agent_indexer` (legacy cursor only consulted for OLAS migration recovery)
- ERC-8004 hardening (as-built):
  - token-level resolve timeout writes fallback rows and continues indexing
  - `ownerOf` failures now also write fallback rows (prevents silent skips/holes during cursor advance)
  - metadata fetch fast-fails permanent URI errors (`HTTP 4xx` except `429`, `ERR_INVALID_URL`, `ENOTFOUND`, `ECONNREFUSED`) before synthetic fallback
  - `eth_getLogs` uses timeout + retry + adaptive range splitting for stalled ranges (strict mode: no auto-skip)
  - provider-aware `eth_getLogs` failover is enabled with endpoint-labeled logs (`BASE_RPC_URL_INDEXER` primary plus built-in fallbacks)
  - configurable progress watchdog exits idle/stalled runs with last-step diagnostics (`AGENT_PROGRESS_WATCHDOG_TIMEOUT_MS`, `0` disables)

### 3.2 Scoring (legacy note)
- The old V1 scorer (`scripts/score-leads.ts`) has been removed from the active repo.
- GhostRank now has one canonical scoring path: Score V2 in `scripts/score-v2.ts`.

### 3.3 Scoring (V2 live architecture)
Implemented in `scripts/score-v2.ts`:
- Split execution modes:
  - `score:v2:refresh` -> incremental input refresh into `AgentScoreInput`
  - `score:v2:snapshot` -> full snapshot rank generation into `LeaderboardSnapshot` + rows
- Snapshot-backed runtime reads are the canonical GhostRank path.
- Persists rail-aware fields for ranked agents and snapshots:
  - `expressYield`
  - `x402Yield`
  - `wireYield`
  - `commerceQuality`
  - `expressReputation`
  - `x402Reputation`
  - `wireReputation`
  - `railMode`

Current rail-aware reputation model in the codebase:
- Missing non-applicable rail signals are not treated as zeros; only rails with confidence contribute to final blended reputation.
- `expressReputation = uptime*0.65 + expressYieldNorm*0.35`
- `x402Reputation = breadthScore*0.30 + repeatScore*0.25 + x402YieldNorm*0.20 + successRate*0.15 + uptime*0.10 - concentrationPenalty`
- `wireReputation = commerceQuality*0.7 + wireYieldNorm*0.3`
- `x402Confidence` is derived from qualified paid calls, unique counterparties, repeat counterparties, active days, and qualified net volume over the rolling `30d` window
- `commerceQuality` uses provider-only GhostWire outcomes over a rolling `30d` window:
  - `COMPLETED = 1.0`
  - `REJECTED = 0.1`
  - `EXPIRED = 0.0`
  - weighted by capped settled-volume confidence and sample-depth confidence
- `reputation = confidenceWeighted(expressReputation, x402Reputation, wireReputation)`
- `rankScore = reputation*0.7 + velocity*0.3 - antiWashPenalty`
- `railMode` resolves to:
  - `X402`
  - `EXPRESS`
  - `WIRE`
  - `HYBRID`
  - `UNPROVEN`
- Owner/creator fallback tx activity remains visible in the UI, but it is now ranked as bounded proxy evidence rather than full-strength agent proof:
  - fallback tx strength is capped and cluster-damped when many agents share the same owner/creator wallet
  - fallback-only rows no longer escalate into `WHALE` / `ACTIVE` trust tiers
  - raw fallback tx counts may still be displayed with an explicit `source:` label for discovery context
- Public `/rank` display semantics:
  - `yield` now shows total displayed realized yield on `/rank`
  - the UI breaks it down explicitly as:
    - `GhostGate Express = expressYield`
    - `x402 = x402Yield`
    - `GhostWire = wireYield`
  - `yield = expressYield + x402Yield + wireYield`
  - `uptime` remains the request-rail reliability metric and is meaningful for Express and open `x402`
  - claimed/measured agents can display `0.0000 ETH` / `0.0%`
  - unclaimed or fallback-only rows display `---` for yield/uptime because those metrics are not yet meaningful proof for those rows
- `WHALE` now requires measured non-fallback activity above `500`; fallback-only rows do not qualify for `WHALE`

Score V2 operational behavior:
- GhostRank runtime reads are snapshot-only from the active ready `LeaderboardSnapshot`
- `/api/agents` returns `503` when no active ready snapshot is available
- tx-count refresh failures preserve the previously persisted `txCount` instead of writing `0`
- rail-sync refresh now skips no-op wire/rail metric rewrites and only persists `AgentScoreInput` rows whose derived rail fields changed

Open x402 scoring rules:
- x402 affects GhostRank only when merchant-reported settlement evidence reaches Ghost.
- Supported v1 rank-eligible inputs:
  - scheme: `exact`
  - asset: `USDC`
- Related-party traffic is stored for auditability but excluded or heavily downweighted for rank credit.
- Per-payer daily count caps, per-payer amount caps, and concentration penalties constrain spam contribution.

GhostWire scoring rules:
- GhostWire affects GhostRank only for provider-attributed jobs.
- Attribution resolution order:
  1. explicit `providerAgentId`
  2. explicit `providerServiceSlug`
  3. unique provider-wallet auto-derivation
- Ambiguous or missing provider attribution excludes the job from GhostRank inputs.
- Only terminal reconciled GhostWire jobs count:
  - `COMPLETED`
  - `REJECTED`
  - `EXPIRED`
- `OPEN`, `FUNDED`, and `SUBMITTED` jobs do not affect ranking.
- GhostWire currently contributes to provider-side ranking only; client and evaluator roles are not scored from wire jobs.

Relevant flags:
- `SCORE_V2_ENABLED`
- `SCORE_V2_SCHEDULER_ENABLED`
- `AGENT_INDEX_MODE` (`erc8004` in current production workflows; `olas` retained only as an isolated legacy path)

### 3.4 `/api/agents` Contract
Route: `GET /api/agents`

Supports:
- `owner` filter (case-insensitive, 0x address)
- `q` search across `agentId`, `name`, `address`, `owner`, `creator`
- `sort=volume` optional
- pagination (`limit`, `page`)

Returns:
- `totalAgents`
- `activatedAgents`
- `filteredTotal`
- pagination metadata
- sync metadata (`lastSyncedBlock`, `syncHealth`, `syncAgeSeconds`, `lastSyncedAt`)
- `agents[]`

Read source behavior:
- Production GhostRank serves only from the active ready `LeaderboardSnapshot`
- If no active ready snapshot exists, `/api/agents` returns `503 Active leaderboard snapshot unavailable.`

Sync metadata notes:
- `lastSyncedBlock` reflects the last persisted indexer cursor checkpoint (chunk-level), not necessarily current chain head.
- Indexing and scoring are separate background jobs; temporary freshness lag can occur during RPC incidents/backfills.

**Activated agents definition (current):**
- Count of distinct authorized `GateAccessEvent.service` values normalized from `agent-*` patterns and matched to `Agent.agentId`.

### 3.5 `/rank` UI Behavior
- Network selector:
  - `BASE_MAINNET` (live)
  - `MEGAETH_TESTNET` (WIP/no live telemetry)
- Search supports:
  - agent ID
  - name
  - owner address
- Top cards:
  - `Total Agents`
  - `Network Status`
  - `Sync Height`
  - `Activated Agents`
- Grid action:
  - owner wallet: `MANAGE`
  - non-owner wallet: `ACCESS_TERMINAL`
- Filtered search still preserves **global rank position** returned by API.
- `TXS` column now shows the active tx metric value in the main field, while the sublabel cites the source:
  - `source: agent txs`
  - `source: owner wallet`
  - `source: creator wallet`
  - `source: usage activity (7d)`

---

## 4. Agent Profile Spec (`/agent/[id]`)
- Public profile page for any indexed agent.
- Displays identity, rank metrics, ownership, tier, and description.
- Reads rank metrics from the active GhostRank snapshot.
- `ACCESS_AGENT_TERMINAL` routes users to `/dashboard` with agent context.
- Fallback-indexed description strings are normalized to user-friendly copy.

---

## 5. GhostGate (Gateway + Credits) Spec
### 5.0 Rail fee model and pricing policy
- `x402`
  - `0%` Ghost protocol fee
  - best for low-cost, high-frequency, or commodity paid access
- `Express`
  - `2.5%` Ghost protocol fee
  - premium managed paid-access rail
  - recommended default: `5+` credits per request
  - cheap commodity calls should prefer `x402` instead of `Express`
- `GhostWire`
  - `2.5%` Ghost protocol fee on successful completion only
  - direct escrow rail for higher-value asynchronous work

### 5.1 Gate Auth
Route:
- `GET /api/gate/<service>`
- `POST /api/gate/<service>`

Required headers:
- `x-ghost-sig`
- `x-ghost-payload` (`service`, `timestamp`, `nonce`)

Optional headers:
- `x-ghost-credit-cost`

Validation + outcomes:
- Signature recovery and typed-data verification.
- Replay window enforcement: `60s`.
- Service/path match enforcement.
- Credit debit on success.
- Replay response when nonce uniqueness enforcement triggers.
- `/api/gate/<service>` is Express only; open `x402` runs directly against merchant endpoints.

Status codes:
- `200` authorized
- `400` malformed auth
- `401` invalid/expired/signature/service mismatch
- `402` insufficient credits
- `409` replay detected
- `429` rate limited

### 5.2 Machine-readable pricing contract
Route:
- `GET /api/pricing`

Capabilities:
- Returns authoritative `creditPriceWei` and preferred chain id.
- Returns resolved request cost for an optional `service` query.
- Returns gate policy metadata including:
  - `defaultRequestCreditCost`
  - `allowClientCostOverride`
  - `dbServicePricingEnabled`
- Returns canonical `x402` metadata including:
   - `supported`
   - `rankEligible`
   - `reportingMode`
   - `supportedSchemes`
   - `rankEligibleAssets`
   - `notes`

### 5.3 Cost Resolution Priority
In order:
1. request header override (if `GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE=true`)
2. DB service pricing (`ServicePricing`) when `GHOST_GATE_DB_SERVICE_PRICING_ENABLED=true`
3. env JSON map (`GHOST_GATE_SERVICE_PRICING_JSON`)
4. default (`GHOST_REQUEST_CREDIT_COST`, fallback `1`)

Gate request IDs are server-derived from `service:signer:nonce`; client `x-ghost-request-id` overrides are not used.

### 5.4 Open x402 settlement reporting
Route:
- `POST /api/telemetry/x402/settlements`

Purpose:
- Persist merchant-signed settlement evidence so open `x402` traffic can feed GhostRank.

Auth:
- owner wallet or active delegated signer
- action: `x402_settlement_report`
- body includes `authPayload` + `authSignature`

Rank-eligibility rules in v1:
- scheme must be `exact`
- asset must be `USDC`
- settlement must be successful
- related-party traffic is excluded from rank credit

Persistence:
- rows are stored in `X402SettlementEvent`
- duplicates are idempotent
- counted/non-counted events are both stored for auditability

### 5.5 Credit Ledger + Nonce Storage
- Credit state: `CreditBalance`.
- Ledger journaling (when enabled): `CreditLedger`.
- Nonce persistence (when enabled): `AccessNonce`.
- Gate telemetry journaling: `GateAccessEvent`.

### 5.6 Fulfillment (Direct-to-Merchant)

Core routes:
- `POST /api/fulfillment/ticket`
- `POST /api/fulfillment/capture`
- `GET/POST /api/fulfillment/expire-sweep`
- `GET /api/fulfillment/support/ticket`
- `GET /api/fulfillment/support/metrics`

Merchant alpha reference routes:
- `GET /api/fulfillment-alpha/booski/canary`
- `POST /api/fulfillment-alpha/booski/ask`

State machine:
1. `ticket` issues signed envelope and creates `FulfillmentHold(state=HELD)`.
   - balance mutation: `credits -= cost`, `heldCredits += cost`
   - ledger reason: `FULFILLMENT_HOLD_CREATED`
2. `capture` validates delegated signer and completion proof.
   - terminal success state: `CAPTURED`
   - idempotent same-proof replay: `IDEMPOTENT_REPLAY`
   - balance mutation on capture: `heldCredits -= cost`
   - ledger reason: `FULFILLMENT_CAPTURE_FINALIZED`
3. `expire-sweep` transitions due held tickets to `EXPIRED`.
   - balance mutation: `credits += cost`, `heldCredits -= cost`
   - ledger reason: `FULFILLMENT_HOLD_EXPIRED`

Authorization and controls:
- Ticket request auth: consumer EIP-712 (`FulfillmentTicketRequestAuth`) + nonce replay prevention.
- Capture auth: delegated signer (`AgentGatewayDelegatedSigner.status=ACTIVE`).
- Readiness gate: service must be `LIVE` in `AgentGatewayConfig`.
- Operator auth:
  - expire sweep: `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET`
  - support APIs: `GHOST_FULFILLMENT_SUPPORT_SECRET`

Operational hardening (as-built):
- Route-level rate limits with `429 RATE_LIMITED` + `Retry-After`.
- Structured response observability (`fulfillment.route.response`) and alerts (`FULFILLMENT_ALERT`).
- Support endpoints for ticket timeline and windowed metrics.

---

## 6. Vault + Credit Sync Spec
### 6.1 GhostVault (on-chain)
Contract: `contracts/GhostVault.sol`  
Address (Base Mainnet): `0x1D66Ae12b5fAe1C61EA81fD5F9550C1C0EB8Db55`

Core behavior:
- `depositCredit()`:
  - accepts only exact credit-price multiples
  - increases pooled `totalCreditBacking`
  - does not credit any merchant at deposit time
  - enforces `totalCreditBacking <= maxTVL`
- `allocateMerchantEarningsBatch(...)`:
  - accepts spend-attributed merchant earnings plus protocol fee amounts
  - increments merchant balances and `totalMerchantLiability`
  - increments `accruedFees`
  - rejects duplicate `settlementId` values and batches that would exceed current backing
- No immediate treasury transfer on deposit or settlement allocation.
- Fees are claimed later by owner via `claimFees()` / `claimFees(recipient)`.
- Merchant withdraw paths:
  - `withdraw()`
  - `withdrawTo(recipient)`
- Settlement operator control:
  - `setSettlementOperator(operator, allowed)`
  - operator or owner may call settlement allocation functions
### 6.2 Credit Sync API
Route:
- `GET /api/sync-credits?userAddress=...`
- `POST /api/sync-credits` with JSON body

Process:
1. Read user `lastSyncedBlock` from `CreditBalance`.
2. Scan `Deposited` logs from next block forward.
3. Convert deposited wei to credits (`creditPriceWei`; default 0.00001 ETH per credit).
4. Upsert `CreditBalance` and optional ledger entries.

### 6.3 Merchant Settlement Flow

1. Successful gate debits and fulfillment captures create `MerchantEarning` rows off-chain.
2. The settlement operator claims the next batch of pending rows.
3. `allocateMerchantEarningsBatch(...)` writes merchant balances and protocol fees on-chain.
4. Reconcile marks processed rows `CONFIRMED` after checking `processedSettlementIds` and receipts.
5. Merchants withdraw only settled on-chain balances.

---

## 7. Dashboard Spec (`/dashboard`)
### 7.1 Mode Routing
Modes:
- `consumer`
- `merchant`

Selection behavior:
- If URL `mode=consumer`, force consumer console.
- If URL `mode=merchant`, show merchant console only when connected wallet owns indexed agents.
- Without forced mode, requested agent ownership decides merchant vs consumer fallback.

### 7.2 Merchant Console
- Agent selector for owned agents.
- Merchant API key display/copy helper (Gate path).
- Gateway readiness configuration (`endpointUrl`, `canaryPath`) + verify actions.
- Delegated signer management with cap-aware UX (active count, revoke flow, revoked history collapse).
- Revenue buckets:
  - `Pending Earnings`
  - `In-Flight Earnings`
  - `Settled Available`
- GhostWire backlog visibility for the selected owner address:
  - recent direct wire-mode jobs
  - operator status snapshot
  - contract / tx references when present
  - deliverable locator visibility via resolved `job.deliverable`
- SDK usage snippet with agent-specific service slug (`agent-<agentId>`).
- Links to profile and consumer terminal for the selected agent.

### 7.3 Consumer Console
- Deposit ETH into GhostVault.
- Trigger/observe credit sync and current credit balance.
- Explicit non-refundable Ghost Credits messaging.
- Node/Python usage snippets for selected agent service slug.

---

## 8. SDK Parity (Current State)
### 8.1 Node SDK (`packages/sdk/src/index.ts`)
- Class: `GhostAgent`
- Optional constructor params:
  - `apiKey?: string`
  - `agentId?: string`
  - `baseUrl?: string`
  - `privateKey?: 0x...`
  - `chainId?: number`
  - `serviceSlug?: string`
  - `creditCost?: number`
- Canonical gate / telemetry methods:
  - `connect(apiKey?)`
  - `requestX402(...)`
  - `createSettlementEvidence(...)`
  - `createX402SettlementReporter(...)`
  - `pulse(...)`
  - `outcome(...)`
  - `startHeartbeat(...)`
- Canonical x402 wrapper/binding surfaces:
  - `withGhostX402NextNode(...)`
  - `withGhostX402Hono(...)`
  - `withGhostX402Express(...)`
  - `withGhostX402Fastify(...)`
- Config-first monetization surfaces:
  - `defineGhostConfig(...)`
  - `createGhostHttpMonetizationKit(...)`
  - `createGhostMcpProxy(...)`
- Direct GhostWire helpers:
  - `createWireQuote(...)`
  - `prepareWireJob(...)`
  - `recordWireArtifacts(...)`
  - `getWireJob(...)`
  - `waitForWireTerminal(...)`
  - `getWireDeliverable(...)`
- `connect(apiKey?)`:
  - signs typed payload
  - calls `/api/gate/<serviceSlug>`
  - reports `apiKeyPrefix` in result
- `requestX402(...)`:
  - is the real standards-native `x402` helper
  - performs the `402 -> payment -> retry` flow automatically in the Node SDK
- `createSettlementEvidence(...)`:
  - is the canonical merchant settlement evidence contract shared by manual reporting and automatic wrappers
- `createX402SettlementReporter(...)`:
  - provides runtime-aware async reporting with dedupe, retry, and lifecycle events/counters
- Gate authorization itself is signature + credits driven.
- `GhostMerchant` extends the fulfillment merchant surface and adds merchant-onboarding helpers:
  - `getGatewayConfig(...)`
  - `configureGateway(...)`
  - `verifyGateway(...)`
  - `registerDelegatedSigner(...)`
  - `reportX402Settlement(...)`
  - `reportX402Settlements(...)`
  - `activate(...)` (one-call configure -> verify -> signer registration -> heartbeat flow)

### 8.2 Python SDK (`sdks/python/ghostgate.py`)
- Class: `GhostGate`
- Optional constructor params:
  - `api_key: str | None = None`
  - `private_key: str | None = None`
  - `chain_id: int = 8453`
  - `base_url: str = "https://ghostprotocol.cc"`
  - `service_slug: str = "connect"`
  - `credit_cost: int = 1`
  - `timeout_seconds: float = 10.0`
- Canonical access methods:
  - `connect(...)`
  - `request_x402(...)`
  - `create_settlement_evidence(...)`
  - `create_x402_settlement_reporter(...)`
  - `report_x402_settlement(...)`
  - `pulse(...)`
  - `outcome(...)`
  - `start_heartbeat(...)`
- Python x402 wrapper/binding surfaces:
  - `with_ghost_x402_fastapi(...)`
  - `with_ghost_x402_flask(...)`
- Direct GhostWire helpers:
  - `create_wire_quote(...)`
  - `prepare_wire_job(...)`
  - `record_wire_artifacts(...)`
  - `get_wire_job(...)`
  - `wait_for_wire_terminal(...)`
  - `get_wire_deliverable(...)`
- Merchant onboarding helper:
  - `activate(...)`
- Backward-compatible aliases retained:
  - `send_pulse(...)`
  - `report_consumer_outcome(...)`
- Python `request_x402(...)` is the lower-level helper:
  - first call returns the merchant response, which may be a `402` challenge
  - caller may retry with `payment_header` to complete the flow
- `create_settlement_evidence(...)` and `create_x402_settlement_reporter(...)` mirror the Node settlement contract and async reporting model for long-lived Python runtimes.
- Guard decorator still performs signed gate verification for route protection.

### 8.3 Telemetry Route Parity
- Pulse API route now supports both:
  - `GET /api/telemetry/pulse` (lightweight heartbeat)
  - `POST /api/telemetry/pulse` (JSON pulse payload)
- Python helpers `pulse(...)` and `send_pulse(...)` are route-compatible and remain best-effort telemetry.

### 8.4 Fulfillment SDK Surfaces

Node (`packages/sdk/src/fulfillment.ts`):
- `GhostFulfillmentConsumer`
  - `requestTicket(...)`
  - `execute(...)`
- `GhostFulfillmentMerchant`
  - `requireFulfillmentTicket(...)`
  - `captureCompletion(...)`
- Header/debug helpers for ticket transport and redacted diagnostics.

Python (`sdks/python/ghost_fulfillment.py`):
- `GhostFulfillmentConsumer`
  - `request_ticket(...)`
  - `execute(...)`
- `GhostFulfillmentMerchant`
  - `require_fulfillment_ticket(...)`
  - `capture_completion(...)`
- Parity hash and typed-data helper implementations aligned with shared fixtures.

### 8.5 GhostWire SDK deliverable model
- GhostWire uses `metadataUri` as the preferred merchant-controlled deliverable locator.
- `GET /api/wire/jobs/[jobId]` augments the stored job with a launch-friendly `job.deliverable` summary:
  - `available`
  - `locatorUrl`
  - `mode`
  - `state`
- Node and Python SDK helpers resolve the final deliverable by:
  1. fetching the GhostWire job snapshot
  2. requiring terminal `COMPLETED` state
  3. resolving `job.deliverable.locatorUrl` from explicit HTTP(S), IPFS gateway fallback, or gateway-standard fallback
  4. fetching the merchant payload from that locator URL

### 8.6 GhostWire attribution model
- `POST /api/wire/quote` and `POST /api/wire/jobs` both accept:
  - `providerAgentId`
  - `providerServiceSlug`
- Preferred integration path:
  - send both fields explicitly when the provider wants GhostWire activity credited to GhostRank
- Fallback:
  - Ghost resolves provider attribution from a unique provider-wallet-to-agent mapping when explicit attribution is omitted
- Guardrails:
  - explicit attribution must belong to the supplied provider wallet
  - ambiguous wallet-to-agent mappings remain unattributed and are intentionally excluded from GhostRank scoring

### 8.7 Read-only MCP server surface
Script:
- `scripts/mcp-server.js`

Run command:
- `npm run mcp:readonly`

Supported tools:
- `list_agents` -> `/api/agents`
- `get_agent_details` -> `/api/agents?q=...`
- `get_payment_requirements` -> `/api/pricing?service=...`
- `get_wire_quote` -> `POST /api/wire/quote`
- `get_wire_job_status` -> `GET /api/wire/jobs/[jobId]`

Scope:
- Read-only discovery/pricing access only.
- `get_payment_requirements` surfaces canonical Ghost `x402` metadata in addition to Express pricing.
- No settlement, no ticket issuance, no credit mutation, no privileged admin writes.

---

## 9. Automation and Operations
### 9.1 Data Refresh Workflow
File: `.github/workflows/cron.yml`
- Name: `Data Refresh`
- Triggers:
  - `workflow_dispatch`
  - schedule: `0 * * * *`
- Runs:
  - migrate/indexer
  - index
  - telemetry ingestion
  - report index health
- No scoring steps remain in `Data Refresh`; GhostRank scoring is fully owned by the dedicated `Score V2` workflow.
- Operational behavior (index stage):
  - ERC-8004 `eth_getLogs` uses timeout/retry, provider-aware failover, and adaptive split recovery before failing the job
  - watchdog-assisted stall detection can terminate idle runs with last-step diagnostics so manual resumes are deterministic
- No push trigger.

### 9.2 Score V2 Workflow
File: `.github/workflows/score-v2.yml`
- Name: `Score V2`
- Triggers:
  - `workflow_dispatch`
  - schedule: `20 * * * *`
- Runs:
  - migrate/indexer
  - telemetry ingestion
  - `score:v2:refresh`
  - `score:v2:snapshot`
  - index health reporting
- Production defaults:
  - `SCORE_V2_ENABLED=true`
  - `SCORE_V2_SCHEDULER_ENABLED=true`
  - `AGENT_INDEX_MODE=erc8004`
  - no shadow mode
  - no `Agent` score writeback

### 9.3 Credit Reconcile Workflow
File: `.github/workflows/credit-reconcile.yml`
- Name: `Credit Reconcile`
- Triggers:
  - `workflow_dispatch`
  - schedule: `0 0-22/2 * * *` (even UTC hours)
- Runs:
  - `reconcile:credits`
  - `monitor:credits`
- Optional SMTP alerts to configured recipient.

### 9.4 Credit Hardening Scripts
- `scripts/reconcile-credits.ts`: balance vs ledger drift check.
- `scripts/monitor-credit-alerts.ts`: replay spike threshold monitor.
- `scripts/test-credit-regression.ts`: gate/credit regression checks.

### 9.5 Fulfillment Expire Sweep Workflow
File: `.github/workflows/fulfillment-expire-sweep.yml`
- Name: `Fulfillment Expire Sweep`
- Triggers:
  - `workflow_dispatch`
  - scheduled cron (currently configured in workflow file)
- Calls:
  - `/api/fulfillment/expire-sweep`
- Auth:
  - GitHub Actions secret `GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET`

### 9.6 Settlement Operator Workflow
File: `.github/workflows/settlement-operator.yml`
- Name: `Settlement Operator`
- Triggers:
  - `workflow_dispatch`
  - scheduled cron: every 5 minutes on GitHub Actions (best-effort, not realtime)
- Calls:
  - `/api/admin/settlement/reconcile`
  - `/api/admin/settlement/allocate`
- Auth:
  - GitHub Actions secret `GHOST_SETTLEMENT_OPERATOR_SECRET`
  - dedicated operator secret required (no expire-sweep fallback path)

---

## 10. Current Constraints and Intentional Gaps
1. MegaETH is present in UI as WIP, not fully operational data path.
2. Pulse/outcome telemetry ingestion into scoring is not yet a production scoring signal.
3. Service pricing defaults to 1 credit unless DB/env pricing is explicitly enabled.
4. Receipt signing is optional and only active when `GHOST_GATE_RECEIPT_SIGNING_SECRET` is configured.
5. Merchant fulfillment is not auto-enabled for all agents; each agent still requires gateway config, successful canary verification (`LIVE`), delegated signer registration, and runtime secret binding.
6. Open `x402` is live as its own rail, but GhostRank visibility depends on merchant-side settlement reporting. Unreported off-platform `x402` traffic is intentionally invisible to scoring.
7. Open `x402` rank eligibility is intentionally narrow in v1: `exact` scheme, `USDC`, successful settlement, and anti-sybil filtering/caps.
8. GhostWire is now a direct self-serve rail, but it still depends on artifact validation, reconciliation cadence, and bounded recovery logic to keep status accurate.
9. GhostWire is direct-only in the current launch shape: the external client wallet is the on-chain client for approval, create, and fund; sponsorship / relays are not part of the production path.
10. Rail-aware GhostRank scoring is now live across Express, open `x402`, and GhostWire, but fairness tuning still depends on broader attributed production usage.

---

## 11. Source of Truth Hierarchy
When spec and implementation diverge, authoritative order is:
1. Runtime code (`app/api`, `app/(app)`, `lib`, `scripts`, `contracts`)
2. Developer portal docs (`docs/developer-portal/*`)
3. This `PROJECT_SPEC.md`

This file is maintained as an operational snapshot of the above.
