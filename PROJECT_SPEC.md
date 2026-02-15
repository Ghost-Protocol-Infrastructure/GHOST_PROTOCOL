# GHOST PROTOCOL: MASTER SPECIFICATION
**Version:** 1.5
**Status:** Live on Base (Mainnet)

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
The application reads from a unified index (`leads-scored.json`).
* **Inputs:** Wallet Address, Agent ID, Transaction Count.
* **Claimed Logic:** The system checks `monitored-agents.json` (or internal flag) to determine if an agent is Claimed.

### B. The Scoring Algorithms (Hard Requirements)
Codex must implement these exact formulas.

**1. Reputation Score (0-100)**
* **Formula:** `Reputation = (TxVolume_norm * 0.3) + (Uptime_% * 0.5) + (Yield_norm * 0.2)`
* **Constraint:** For Unclaimed agents, Uptime and Yield are `null`. The formula defaults to `TxVolume_norm` (capped at 80/100).

**2. Rank Score (Leaderboard Position)**
* **Formula:** `Rank = (Reputation * 0.7) + (Velocity * 0.3)`
* **Velocity:** Defined as the rate of change in requests/hour (or raw Tx Count for MVP if historical data is missing).

### C. User Interface Requirements
* **Network Selector:** A dropdown menu toggling between `BASE (LIVE)` and `MEGAETH (WIP)`.
* **The Grid:**
    * **Columns:** RANK, AGENT (with "CLAIMED" badge if true), TXS, REPUTATION (Color-coded), YIELD, UPTIME, ACTION.
    * **Action Button:**
        * If Owner: "MANAGE" (Go to Merchant Console).
        * If Consumer: "ACCESS" (Go to Purchase/Consumption Flow).

---

## 3. GHOSTGATE SPECIFICATION (SDK & Gateway)

### A. System Architecture
* **SDKs:** Python (Available), Node.js (Roadmap).
* **Role:** Middleware/Decorator for Python integrations (Flask/FastAPI), with Node.js SDK support planned.
* **Function:** Intercepts HTTP requests and verifies EIP-712 headers (`x-ghost-sig`, `x-ghost-payload`). The Gateway cryptographically recovers the signer address to authorize access.

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
2.  **Sync:** The backend (`/api/sync-credits`) scans the `Deposited` events on Base Mainnet.
3.  **Credit Ledger:** ETH value is converted to Virtual Credits (e.g., 0.001 ETH = 100 Credits) and stored in `data/credits.json`.
4.  **Consumption:** Credit decrement occurs **Server-Side** at the Gateway upon successful signature verification and balance checks.
* **Optimistic Gating:** To solve latency, GhostGate verifies signed access requests against a **cached high-speed index (<100ms)** rather than raw chain reads per request. Settlement is asynchronous.

### D. Credit Consumption & Enforcement
* **Enforcement Point:** Credit decrement is performed server-side by the Gateway, not by client SDKs.
* **SDK Responsibility:** The SDK signs/authenticates requests and forwards request metadata; it does not maintain or decrement local balances.

---

## 4. MERCHANT CONSOLE & ONBOARDING
* **Access:** Unlocked by connecting a wallet that owns an ERC-8004 agent indexed in `leads-scored.json`.
* **Features:**
    * **Portfolio View:** Dropdown to manage multiple agents.
    * **Installation:** Display API Key and dynamic code snippets (`@gate.guard`).
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
