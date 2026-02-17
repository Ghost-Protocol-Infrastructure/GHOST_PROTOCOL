# POST-LAUNCH ROADMAP & STATUS

## Completed Since Last Update
- Rank/Dashboard/Profile are now DB/API-backed (static leaderboard JSON removed from live paths).
- `Agent` identity model upgraded with `agentId` (unique) and `owner`, including legacy-row backfill.
- `/api/agents` now returns `totalAgents` via `count()` and supports owner-filtered merchant queries.
- SDK onboarding UI is live on `/agent/[agentId]` with tabbed Node.js/Python snippets.
- Node SDK baseline gateway integration is live (EIP-712 signed `connect()`, configurable `baseUrl`).

## 1. Scoring Engine (Active)
- **Issue:** Transaction count is still derived from owner wallet nonce, not strictly from the agent contract.
- **Fix:** Implement agent-level transaction indexing for accurate per-agent activity scoring.
- **Performance Upgrade (Deferred):** Keep creator-wallet nonce as the launch metric for Whale acquisition, then add an agent-contract activity metric as a post-launch scoring upgrade.

## 2. Merchant UI (Active)
- **Issue:** Financials (Earnings/Withdrawals) remain partially placeholder.
- **Fix:** Wire direct `GhostVault.sol` reads to render real balances and enable withdrawals in UI.

## 3. Telemetry & Scoring Inputs (Active)
- **Issue:** SDK heartbeats are emitted but not fully ingested by scoring infrastructure, and yield/uptime signals still rely on proxy/local data in parts of the pipeline.
- **Fix:** Implement durable time-series ingestion (Redis/Influx/ClickHouse) and wire scoring (`scripts/score-leads.ts` or successor DB pipeline) to consume live 24h GhostVault volume plus ingested uptime metrics.

## 4. SDK Coverage (Active)
- **Issue:** Node.js SDK baseline is now implemented, but full parity with Python middleware and broader DX packaging is incomplete.
- **Fix:** Continue Node SDK expansion (middleware ergonomics, telemetry helpers, publishing/versioning hardening) to reach full parity.

## 5. Sybil Resistance (V2 REQUIREMENT)
- **Issue:** Ranking can still be skewed by raw transaction-count behavior.
- **Fix:** Weight unique wallet interactions higher than raw volume and add anti-wash heuristics.

## 6. Indexer Throughput & Operations (Active)
- **Issue:** Initial backfills can run long depending on RPC provider limits and chain range.
- **Fix:** Continue tuning `AGENT_INDEX_CHUNK_SIZE`, RPC fallback ordering, and operational observability (checkpoint logs/metrics/alerts).

## 7. LEVEL 2: THE WATCHTOWER (V2 REQUIREMENT)
- **Mechanism:** The "Always-On Server" (VPS / Railway / Heroku).
- **How it Works:** Replace cron-based GitHub Actions polling with a 24/7 indexing worker (`while(true)` loop and/or webhook/event listener) so blockchain changes are processed continuously.
- **Vibe:** Ticker-tape behavior where updates appear as soon as events happen.
- **Pros:** Real-time updates. "Claim" to dashboard state becomes near-instant. Required for Marketplace flows and Transfer Listener support.
- **Cons:** Added cost and operations overhead (server uptime, monitoring, restart/recovery on crashes).
- **Verdict:** Phase 2 requirement. Once active users and trading volume are present, we must upgrade to this model.

## 8. Launch-Accepted Technical Debt (Deferred)
- **Velocity Proxy Decision:** Keep using normalized total transaction count as the velocity proxy during the current Vampire Attack phase. This intentionally favors historically high-value agents ("Whales") over short-term burst activity.
- **Claimed-State Consistency:** Scorer currently infers claimed state from `status`, while UI can infer claimed from `status` OR telemetry presence; this mismatch is mostly cosmetic, can create short-lived sync-window edge cases, and is deferred until canonical signal unification via Transfer/claim listener support.

## 9. P1 Governance Safety (Post-Freeze)
- **Timelock Controls:** Add a timelock to sensitive admin actions (`setMaxTVL`, treasury updates, fee-claim policy changes) so users get an on-chain warning window before execution.
- **Ownership Hardening:** Move `owner` from EOA to a multisig for operational and key-management safety.
- **Cap-Floor Guardrail:** Enforce `setMaxTVL(newCap)` with `newCap >= totalLiability` to prevent accidental deposit freezes below outstanding liabilities.
- **Emergency Policy:** Define and document a narrow emergency response policy (incident class, who can execute, and post-incident rollback/communication process).
