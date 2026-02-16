# POST-LAUNCH ROADMAP & STATUS

## 1. Scoring Engine (Active)
- **Issue:** Transaction count is still derived from owner wallet nonce, not strictly from the agent contract.
- **Fix:** Implement agent-level transaction indexing for accurate per-agent activity scoring.

## 2. Merchant UI (Active)
- **Issue:** Financials (Earnings/Withdrawals) remain partially placeholder.
- **Fix:** Wire direct `GhostVault.sol` reads to render real balances and enable withdrawals in UI.

## 3. Telemetry Ingestion (Active)
- **Issue:** SDK heartbeats are emitted but not fully ingested by scoring infrastructure.
- **Fix:** Implement durable time-series ingestion (Redis/Influx/ClickHouse) for uptime and service quality metrics.

## 4. Scoring Logic (Active)
- **Issue:** Yield and uptime signals still rely on proxy/local data in parts of the scoring pipeline.
- **Fix:** Update `scripts/score-leads.ts` and/or successor DB scoring pipeline to consume live 24h GhostVault volume plus ingested uptime metrics.

## 5. Backend Scalability (Completed)
- **Completed:** Credit sync no longer rescans full history per request; it uses `CreditBalance.lastSyncedBlock` as a wallet-level cursor.
- **Completed:** Agent indexer is stateful through `SystemState` (`agent_indexer.lastSyncedBlock`) and only scans new ranges.

## 6. SDK Coverage (Active)
- **Issue:** Node.js SDK is not yet feature-complete (Python-first rollout).
- **Fix:** Publish Node.js GhostGate SDK with EIP-712 signing and parity with Python middleware features.

## 7. Sybil Resistance (Active)
- **Issue:** Ranking can still be skewed by raw transaction-count behavior.
- **Fix:** Weight unique wallet interactions higher than raw volume and add anti-wash heuristics.

## 8. Data Persistence (Completed)
- **Completed:** Credit ledger moved from file-based storage to Postgres (`CreditBalance` via Prisma).
- **Completed:** Agent index persistence moved to Postgres (`Agent` + `SystemState`) with automated migration/index runs in CI.

## 9. DB-First UI Integration (Active)
- **Issue:** Some UI surfaces still read static `data/leads-scored.json`.
- **Fix:** Migrate all leaderboard and dashboard reads to `/api/agents` (Postgres-backed), then retire legacy JSON dependencies.

## 10. Indexer Throughput & Operations (Active)
- **Issue:** Initial backfills can run long depending on RPC provider limits and chain range.
- **Fix:** Continue tuning `AGENT_INDEX_CHUNK_SIZE`, RPC fallback ordering, and operational observability (checkpoint logs/metrics/alerts).

## 11. Next.js server for data storage