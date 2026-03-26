# X402 Reporting + Monetization Kit Plan

## Goal
Ship the next two strategic wins in the right order: automatic `x402` settlement reporting for GhostRank, then the first monetization kit for existing HTTP endpoints and stateless MCP-over-HTTP/SSE servers.

## Scope
- In scope:
  - automatic async `x402` settlement reporting middleware
  - canonical `SettlementEvidence` contract shared across SDK/adapters
  - Node + Python framework adapters
  - OpenClaw/default onboarding wiring
  - HTTP monetization kit MVP
  - MCP payment-aware proxy MVP over HTTP/SSE
- Out of scope:
  - cross-protocol evidence ingestion
  - leaderboard math rewrite
  - Butler-style buyer shell
  - stdio MCP proxying
  - sponsorship / relay work
  - cross-protocol reputation / oracle work
  - first-class Edge/serverless durability guarantees in MVP

## Locked Decisions
- Runtime support matrix:
  - long-lived Node/Python servers are the first-class MVP target
  - `Next.js` support in MVP means `Node runtime only`
  - short-lived/serverless runtimes can use best-effort reporting or manual fallback, but are not counted as first-class durable targets in the initial KPI
- Reporter durability model:
  - long-lived servers use an in-process async outbox with retry/backoff and dedupe
  - request/response paths must never block on Ghost reporting
  - manual reporting remains available as the recovery/escape hatch
- Canonical evidence source:
  - framework wrappers do not infer payment success from arbitrary `200` responses
  - a first-class `SettlementEvidence` object is emitted by the `x402` payment verification/gating layer, then enriched with handler outcome and handed to the reporter
- `hybrid` means:
  - one logical service can be exposed on both `x402` and `Express` at the same time, but clients choose the rail explicitly; Ghost does not silently fall back between rails mid-request
- MCP compatibility boundary:
  - MVP targets stateless, tool-centric MCP-over-HTTP/SSE servers
  - `initialize` and JSON-RPC framing pass through unchanged
  - `tools/list` stays free and may be augmented with structured pricing metadata, falling back to description text only when the client cannot consume the structured shape
  - `tools/call` is the paid, gated execution path

## Tasks
- [ ] Task 1: Lock the runtime support matrix and reporter durability model in [packages/sdk/src/index.ts](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/packages/sdk/src/index.ts), [packages/sdk/README.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/packages/sdk/README.md), and [docs/developer-portal/onboarding-and-configuration.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/docs/developer-portal/onboarding-and-configuration.md). → Verify: the docs and SDK plan state exactly which runtimes are first-class, which are best-effort, and that `Next.js` support is `Node runtime only` for MVP.
- [ ] Task 2: Define the canonical `SettlementEvidence` contract, aligned to the receiver at [app/api/telemetry/x402/settlements/route.ts](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/app/api/telemetry/x402/settlements/route.ts), and make it the only reporting input for SDK/adapters/OpenClaw. → Verify: one shared evidence shape exists for `requestId`, `paymentReference`, `payerIdentity`, `payerAddress`, `scheme`, `network`, `chainId`, `asset`, `amountAtomic`, `decimals`, `success`, `statusCode`, `latencyMs`, `occurredAt`, and `metadata`, with no second reporting model.
- [ ] Task 3: Implement the SDK-side reporter core in [packages/sdk/src/index.ts](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/packages/sdk/src/index.ts) with runtime-aware delivery behavior: in-process queue + retry/backoff + dedupe for long-lived runtimes, and explicit best-effort/manual-fallback behavior for short-lived runtimes. → Verify: unit tests cover duplicate `paymentReference`, transient network failure, retry, drop behavior, and “merchant response succeeds even if reporting fails”.
- [ ] Task 4: Ship Node adapters first for Express, Hono, Fastify, and `Next.js Node runtime` route handlers, and make them own the full `x402` path: `challenge -> payment verification -> handler execution -> SettlementEvidence emission -> async reporting`. → Verify: sample handlers can be wrapped end-to-end without merchant-specific payment plumbing, and a mocked Ghost endpoint receives signed reports asynchronously after successful paid calls.
- [ ] Task 5: Ship Python parity for FastAPI and Flask with the same `SettlementEvidence` contract and non-blocking reporting semantics for long-lived runtimes. → Verify: pytest coverage proves Python helpers emit the same normalized evidence shape and retry behavior as the Node implementation.
- [ ] Task 6: Add reporter observability before rollout with explicit lifecycle counters/logs for `payment_verified`, `report_enqueued`, `report_sent`, `report_accepted`, `duplicate`, and `report_dropped`. → Verify: the `>90%` evidence KPI has a measurable denominator and failure localization path for each supported runtime.
- [ ] Task 7: Make auto-reporting the default onboarding path by updating [docs/developer-portal/onboarding-and-configuration.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/docs/developer-portal/onboarding-and-configuration.md), [packages/sdk/README.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/packages/sdk/README.md), [sdks/python/README.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/sdks/python/README.md), and [integrations/openclaw-ghost-pay/README.md](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/integrations/openclaw-ghost-pay/README.md), while preserving manual reporting as a documented recovery path. → Verify: primary examples use auto-reporting, but low-level manual settlement reporting still exists in docs and SDK/OpenClaw escape hatches.
- [ ] Task 8: Build the HTTP monetization kit MVP as a packaging/config layer over Task 4’s canonical wrappers and `SettlementEvidence` path, not as a second implementation, with config-driven wrappers for `x402`, `Express`, and `hybrid` route monetization plus a `ghost.config.json` shape for pricing and service mapping. → Verify: an existing HTTP handler can be wrapped and monetized end-to-end in under 15 minutes, `hybrid` behavior is documented as dual-advertised rails with explicit rail choice rather than silent fallback, and the kit reuses the same verification/reporting path as Task 4.
- [ ] Task 9: Build the MCP payment-aware proxy MVP for stateless MCP-over-HTTP/SSE using [app/api/pricing/route.ts](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/app/api/pricing/route.ts) and [app/api/mcp/read-only/route.ts](c:/Users/kdina/Documents/ABESR%20PROJECTS/GHOST_PROTOCOL/app/api/mcp/read-only/route.ts) as the reference surfaces, with `initialize`/JSON-RPC pass-through, free `tools/list` plus structured pricing metadata, and payment-gated `tools/call`. → Verify: a stateless upstream MCP server runs unmodified behind the proxy, discovery remains visible without payment, structured pricing metadata is exposed consistently on `tools/list`, and paid tool execution produces GhostRank evidence automatically.
- [ ] Task 10: Run verification last with SDK tests, framework sample apps, OpenClaw smoke coverage, and end-to-end reporting metrics. → Verify: `>90%` of successful `x402` calls on supported long-lived runtimes become GhostRank evidence, HTTP monetization works on at least two frameworks, MCP proxy works for stateless HTTP/SSE servers, and merchant response paths remain non-blocking.

## Done When
- [ ] Automatic `x402` settlement reporting is the default merchant path in Node, Python, and OpenClaw for supported runtimes.
- [ ] The canonical `SettlementEvidence` contract is shared across SDK, adapters, and documentation.
- [ ] Existing HTTP endpoints can be monetized with `x402`, `Express`, or `hybrid` without app redesign.
- [ ] Existing stateless MCP-over-HTTP/SSE servers can be monetized behind a Ghost proxy without upstream server changes.
- [ ] Manual settlement reporting remains available for custom merchants and incident recovery.
