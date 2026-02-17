# POST-LAUNCH ROADMAP & STATUS

## 1. Scoring Engine (Active)
- **Issue:** Transaction count is still derived from owner wallet nonce, not strictly from the agent contract.
- **Fix:** Implement agent-level transaction indexing for accurate per-agent activity scoring.
- **Performance Upgrade (Deferred):** Keep creator-wallet nonce as the launch metric for Whale acquisition, then add an agent-contract activity metric as a post-launch scoring upgrade.

## 2. Merchant UI (Active)
- **Issue:** Financials (Earnings/Withdrawals) remain partially placeholder.
- **Fix:** Wire direct `GhostVault.sol` reads to render real balances and enable withdrawals in UI.

## 3. Telemetry Ingestion (Active)
- **Issue:** SDK heartbeats are emitted but not fully ingested by scoring infrastructure.
- **Fix:** Implement durable time-series ingestion (Redis/Influx/ClickHouse) for uptime and service quality metrics.

## 4. Scoring Logic (Active)
- **Issue:** Yield and uptime signals still rely on proxy/local data in parts of the scoring pipeline.
- **Fix:** Update `scripts/score-leads.ts` and/or successor DB scoring pipeline to consume live 24h GhostVault volume plus ingested uptime metrics.

## 5. SDK Coverage (Active)
- **Issue:** Node.js SDK is not yet feature-complete (Python-first rollout).
- **Fix:** Publish Node.js GhostGate SDK with EIP-712 signing and parity with Python middleware features.

## 6. Sybil Resistance (V2 REQUIREMENT)
- **Issue:** Ranking can still be skewed by raw transaction-count behavior.
- **Fix:** Weight unique wallet interactions higher than raw volume and add anti-wash heuristics.

## 7. Indexer Throughput & Operations (Active)
- **Issue:** Initial backfills can run long depending on RPC provider limits and chain range.
- **Fix:** Continue tuning `AGENT_INDEX_CHUNK_SIZE`, RPC fallback ordering, and operational observability (checkpoint logs/metrics/alerts).

## 8. LEVEL 2: THE WATCHTOWER (V2 REQUIREMENT)
- **Mechanism:** The "Always-On Server" (VPS / Railway / Heroku).
- **How it Works:** Replace cron-based GitHub Actions polling with a 24/7 indexing worker (`while(true)` loop and/or webhook/event listener) so blockchain changes are processed continuously.
- **Vibe:** Ticker-tape behavior where updates appear as soon as events happen.
- **Pros:** Real-time updates. "Claim" to dashboard state becomes near-instant. Required for Marketplace flows and Transfer Listener support.
- **Cons:** Added cost and operations overhead (server uptime, monitoring, restart/recovery on crashes).
- **Verdict:** Phase 2 requirement. Once active users and trading volume are present, we must upgrade to this model.

## 9. Launch-Accepted Technical Debt (Deferred)
- **Velocity Proxy Decision:** Keep using normalized total transaction count as the velocity proxy during the current Vampire Attack phase. This intentionally favors historically high-value agents ("Whales") over short-term burst activity.
- **Claimed-State Consistency:** Scorer currently infers claimed state from `status`, while UI can infer claimed from `status` OR telemetry presence. This is acceptable for launch and will be unified under one canonical signal when Transfer/claim event listener support is added.
- **Audit Context (Claimed-State):** Current mismatch is mostly cosmetic; a short-lived edge case can appear during sync windows. Keep deferred and fold into the canonical claimed-signal unification above.
