# GHOST PROTOCOL: MASTER SPECIFICATION
**Version:** 1.8
**Status:** Live on Base (Mainnet), Postgres-backed indexing/scoring/credit ledger, DB-native rank/dashboard/profile routes

---

## 1. MISSION & CORE LOGIC
Ghost Protocol is the infrastructure layer for the Autonomous Agent Economy. We index ERC-8004 agents and transform them from isolated scripts into solvent, rankable businesses via two integrated products:
1.  **GhostRank:** A decentralized leaderboard for discovery and reputation.
2.  **GhostGate:** A monetization SDK and access control gateway.

### The "Truthful Data" Architecture
We strictly separate **Public Data** (Unclaimed) from **Proprietary Data** (Claimed).
* **Unclaimed Agents (The "Ghost" State):**
    * **Source:** Raw on-chain data (ERC-8004 registries).
    * **Visuals:** Yield and Uptime must render as `---` (Null/Empty State).
    * **Scoring:** Reputation is derived *solely* from Transaction Volume.
* **Claimed Agents (The "Machine" State):**
    * **Source:** GhostGate SDK Telemetry + On-chain data.
    * **Visuals:** Yield and Uptime render real values (e.g., "0.45 ETH", "99.9%").
    * **Scoring:** Reputation is a weighted composite of Volume, Uptime, and Yield.

---

## 2. GHOSTRANK SPECIFICATION (Dashboard & Logic)

### A. Data Pipeline & Inputs
The canonical backend store is PostgreSQL (Prisma) with the following core models:
* **`Agent`:** Indexed ERC-8004 agents used by API consumers and ranking services.
  * Includes identity fields: `address`, `agentId` (unique), `creator`, `owner`.
  * Includes scoring/state fields: `txCount`, `tier`, `reputation`, `rankScore`, `yield`, `uptime`, `status`.
* **`SystemState`:** Stateful cursor storage (for example, `agent_indexer.lastSyncedBlock`) used by background indexers.
* **`CreditBalance`:** Per-wallet virtual credit balances and per-wallet sync cursor (`lastSyncedBlock`).
* **Inputs:** Agent address, creator/owner address, transaction count, and telemetry (`yield`, `uptime`) from DB.
* **Claimed Logic (as-built):** Scoring currently infers claimed state from `Agent.status` keyword matching (`claimed`/`verified`/`monetized`), while some UI paths may also infer from non-zero telemetry.
* **Leaderboard API:** `/api/agents` reads `Agent` rows ordered by rank metrics (`rankScore`, `reputation`, `txCount`) and returns:
  * `agentId`, `owner`, `creator`, `name`, `status`
  * `tier`, `txCount`, `reputation`, `rankScore`, `yield`, `uptime`
  * `totalAgents` (dynamic denominator)
  * `lastSyncedBlock` (for Sync Height card)
* **Owner Filtering:** `/api/agents` supports `owner` query filtering (case-insensitive) for merchant workflows.
* **UI State:** `/rank`, `/dashboard`, and `/agent/[id]` are DB/API-backed and no longer depend on legacy static leaderboard JSON files.

### B. The Scoring Algorithms (Hard Requirements)
Codex must implement these exact formulas.

**1. Reputation Score (0-100)**
* **Formula:** `Reputation = (TxVolume_norm * 0.3) + (Uptime_% * 0.5) + (Yield_norm * 0.2)`
* **Constraint:** For Unclaimed agents, Uptime and Yield are treated as zero for scoring and rendered as `---` in leaderboard UI. Formula defaults to `TxVolume_norm` (capped at 80/100).

**2. Rank Score (Leaderboard Position)**
* **Formula:** `Rank = (Reputation * 0.7) + (Velocity * 0.3)`
* **Velocity (as-built MVP):** `Velocity = velocityNorm`, where `velocityNorm` is a logarithmic 0-100 normalization of tx count.
* **Critical Math Fix Implemented:** Rank now uses normalized velocity in the final formula (not raw tx count), preventing tx magnitude from overwhelming reputation.

### C. User Interface Requirements
* **Network Selector:** A dropdown menu toggling between `BASE (LIVE)` and `MEGAETH (WIP)`.
* **Top Metric Cards (`/rank`):** `total_agents`, `network_status`, `sync_height`, `claimed_agents`.
* **The Grid:**
    * **Columns:** RANK, AGENT (with "CLAIMED" badge if true), TXS, REPUTATION (Color-coded), YIELD, UPTIME, ACTION.
    * **Action Button:**
        * If Owner: "MANAGE" (Go to Merchant Console).
        * If Consumer: "ACCESS" (Go to Purchase/Consumption Flow).

---

## 3. GHOSTGATE SPECIFICATION (SDK & Gateway)

### A. System Architecture
* **SDKs:** Python (Available), Node.js (Available, beta/in-progress parity).
* **Role:** SDK clients prepare signed access requests against GhostGate (`/api/gate/[...slug]`) for protected services.
* **Node SDK (as-built):** `GhostAgent` supports configurable `baseUrl`, `privateKey`, `serviceSlug`, and credit-cost header; `connect(apiKey)` performs EIP-712 signing and gateway auth.
* **Function:** Gateway verifies EIP-712 headers (`x-ghost-sig`, `x-ghost-payload`) and cryptographically recovers signer address to authorize/charge access.

### B. Telemetry & Metrics Generation
* **YIELD:** Calculated as `Total ETH Volume processed via GhostVault / 24h`.
    * *Logic:* Real-time revenue processed. Verified proof of economic value.
* **UPTIME:** Calculated via **Dual-Verify System**:
    1.  **Merchant-Side:** SDK sends "Pulse" heartbeats every 60s.
    2.  **Consumer-Side:** Gateway tracks success rates of paid tokens. If a consumer pays but receives a 500 Error, Uptime is penalized.
* **Current As-Built Note:** Telemetry (Yield/Uptime) is currently derived from on-chain inputs and indexed datasets. SDK heartbeats/outcome hooks are implemented, but scoring-engine ingestion remains stubbed (Roadmap Item).

### C. Monetization & Verification: THE GHOSTVAULT
**Role:** The core revenue engine and non-custodial payment rail.

### C-1. On-Chain Settlement
* **Model:** Protocol Take Rate (e.g., 2.5% fee on credits).
* **Payment Rail:** Users deposit Native ETH directly to the GhostVault.
* **Split Logic:** 100% of each deposit is split on-chain immediately: `97.5%` to the target agent's withdrawable balance and `2.5%` to the Protocol Treasury.
* **Verification Logic:** Access is granted via server-side verification of GhostVault `Deposited` events.

### C-2. Virtual Credit Logic (Off-Chain Scaling)
To avoid high-frequency gas fees, Ghost Protocol uses a "Prepaid Native ETH" model:
1.  **Deposit:** User pays ETH to `GhostVault`.
2.  **Sync:** The backend (`/api/sync-credits`) scans `Deposited` events from the wallet cursor (`lastSyncedBlock + 1`) to latest block on Base Mainnet.
3.  **Credit Ledger:** ETH value is converted to Virtual Credits (e.g., 0.001 ETH = 100 Credits) and stored in Postgres (`CreditBalance`) via Prisma transactions.
4.  **Consumption:** Credit decrement occurs **Server-Side** at the Gateway upon successful signature verification and balance checks.
* **Optimistic Gating:** To solve latency, GhostGate verifies signed access requests against a **cached high-speed index (<100ms)** rather than raw chain reads per request. Settlement is asynchronous.

### D. Credit Consumption & Enforcement
* **Enforcement Point:** Credit decrement is performed server-side by the Gateway, not by client SDKs.
* **SDK Responsibility:** The SDK signs/authenticates requests and forwards request metadata; it does not maintain or decrement local balances.

---

## 4. MERCHANT CONSOLE & ONBOARDING
* **Access:** Unlocked by connecting a wallet that owns an ERC-8004 agent indexed in the Postgres `Agent` table.
* **Features:**
    * **Portfolio View:** Dropdown to manage multiple agents.
    * **Installation:** Display API Key and dynamic integration snippets (Node.js + Python tabs) with prefilled `agentId`.
    * **Profile Route:** `/agent/[agentId]` resolves via unique `Agent.agentId` for deterministic profile/integration lookup.
    * **Financials:** View earnings and "Withdraw" (disabled if < threshold).

## 5. RISK MANAGEMENT
* **Sybil Resistance (Roadmap):** Future iterations will weight "Unique Wallet Interactions" higher than raw Tx Count to prevent wash trading.
* **Trust:** Economic Verification (Yield) acts as the anchor for Uptime. You cannot fake revenue without losing money.

## 6. SMART CONTRACT ARCHITECTURE
### 6.1 GhostVault.sol
* **Role:** Core revenue engine for Ghost Protocol.
* **Network:** Base Mainnet.
* **Deployed Address:** `0xE968393bd003331Db6D62DEb614d2B073C9C151C`.

### 6.2 Settlement & Fee Routing Logic
* **Pattern:** Non-custodial, pull-payment architecture.
* **Treasury Routing:** Protocol fees are never held by middleware services; they are routed at deposit-time to Treasury `0x6D1F2814fC91971dB8b58A124eBfeB8bC7504c6f`.
* **Agent Balances:** Agent proceeds accrue as withdrawable balances inside GhostVault and are claimed through `withdraw()`.

## 7. INDEXER OPERATIONS (AS-BUILT)
* **Primary Indexer:** `scripts/index-db.ts` indexes agent registrations into Postgres.
* **Primary Scorer:** `scripts/score-leads.ts` now reads/writes Postgres directly (no static leaderboard JSON output dependency).
* **Identity Backfill:** Indexer now maintains/backfills `agentId` (unique) and `owner` for legacy rows to keep profile and merchant routing consistent.
* **Stateful Cursor:** Cursor key `agent_indexer` is stored in `SystemState.lastSyncedBlock`.
* **Default Bootstrap Block:** `23,000,000` (override with `AGENT_INDEX_START_BLOCK`).
* **Chunking:** Default chunk size is `2,000` blocks (override with `AGENT_INDEX_CHUNK_SIZE`) to stay within strict RPC `eth_getLogs` limits.
* **Fallback Path:** If `AgentRegistered` logs are unavailable in-range, the indexer can fall back to `CreateService` + `ownerOf`.
  * Fallback records are normalized to cleaner labels (`Agent #<serviceId>`) with descriptive metadata.
* **CI Automation:** `.github/workflows/cron.yml` runs on `workflow_dispatch`, `schedule`, and `push` to `main`, then executes:
  * `npm ci`
  * `npx prisma generate`
  * `npm run migrate:indexer`
  * `npm run index:db`
  * `npm run score`
