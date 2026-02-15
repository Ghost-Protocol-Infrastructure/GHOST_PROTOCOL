# POST-LAUNCH ROADMAP & KNOWN ISSUES

## 1. Scoring Engine
- **Issue:** Transaction Count is currently derived from the Owner Wallet nonce, not the specific Agent Contract.
- **Fix:** Implement internal transaction indexing for accurate agent-level activity.

## 2. Merchant UI
- **Issue:** Financials (Earnings/Withdrawals) are currently placeholder UI.
- **Fix:** Wire up `GhostVault.sol` reads to display real ETH balances and enable withdrawals via UI.

## 3. Telemetry
- **Issue:** SDK Heartbeats are sent but not ingested by the scoring engine.
- **Fix:** Implement Time-Series DB (Redis/Influx) to ingest heartbeats and calculate "True Uptime."

## 4. Scoring Logic
- **Issue:** Yield & Uptime scores are currently derived from local telemetry proxies, not live GhostVault events.
- **Fix:** Update `scripts/score-leads.ts` to query 24h GhostVault volume for the "Yield" component.

## 5. Backend Scalability
- **Issue:** The Credit Sync service rescans the entire event log history on every request.
- **Fix:** Implement a "Last Scanned Block" cursor in the database to only fetch new events.

## 6. SDK Coverage
- **Issue:** Node.js SDK is not yet available (Python SDK only in Phase 1).
- **Fix:** Implement and publish the Node.js GhostGate SDK with EIP-712 request signing and Gateway integration parity.

## 7. Sybil Resistance
- **Issue:** Ranking can still be skewed by raw transaction-count patterns.
- **Fix:** Weight "Unique Wallet Interactions" higher than raw Tx Count to reduce wash-trading influence.

## 8. Data Persistence (Critical)
- **Issue:** The Credit Ledger is currently file-based (`data/credits.json`), which is ephemeral in serverless environments.
- **Current Mitigation:** The system rescans the entire blockchain history on every sync to rebuild the state.
- **Fix:** Migrate to a persistent database (Postgres/Redis) to decouple state from the runtime environment.
