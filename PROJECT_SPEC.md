# GHOST PROTOCOL: MASTER SPECIFICATION
**Version:** 1.5 (Unified & Truthful)
**Status:** Live on Base (Phase 1)
**Documents Merged:** Executive Summary, Addendum A, Addendum B

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
* **Role:** Middleware/Decorator for Python (Flask/FastAPI) and Node.js.
* **Function:** Intercepts HTTP requests and verifies the `X-GHOST-TOKEN` header.

### B. Telemetry & Metrics Generation
* **YIELD:** Calculated as `Total Value of Consumed Credits / 24h`.
    * *Logic:* Real-time revenue processed. Verified proof of economic value.
* **UPTIME:** Calculated via **Dual-Verify System**:
    1.  **Merchant-Side:** SDK sends "Pulse" heartbeats every 60s.
    2.  **Consumer-Side:** Gateway tracks success rates of paid tokens. If a consumer pays but receives a 500 Error, Uptime is penalized.

### C. Monetization & Verification
* **Model:** Protocol Take Rate (e.g., 2.5% fee on credits).
* **Credit Logic:** Users buy "Credit Packs" (ETH -> GhostCredits). 1 Credit = 1 Request (default).
* **Optimistic Gating:** To solve latency, GhostGate verifies tokens against a **cached high-speed index (<100ms)** rather than raw chain reads per request. Settlement is asynchronous.

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