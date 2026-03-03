# API Reference

All endpoints below reflect the current Next.js API implementation.

## Authentication model

Ghost Gate uses signed headers:

- `x-ghost-sig`: EIP-712 signature
- `x-ghost-payload`: JSON payload string
- `x-ghost-credit-cost`: optional request cost override

No bearer token is required for gate authorization. Signature validity and credits are the source of truth.

## Fulfillment API Families

Fulfillment adds two API groups:

1. `Agent Gateway lifecycle` (`/api/agent-gateway/*`)
2. `Fulfillment state machine` (`/api/fulfillment/*`)

Admin writes under `/api/agent-gateway/*` are owner-wallet signed operations with nonce replay protection.
Operator routes under `/api/fulfillment/*` use bearer secret auth.
Settlement operator/support routes under `/api/admin/settlement/*` use bearer secret auth.

## `GET/POST /api/agent-gateway/config`

Manage/read merchant endpoint + canary binding for an agent.

- `GET` query:
  - `agentId` (required)
  - `includeHistory` (optional: `1/true`)
  - `historyLimit` (optional)
- `POST` body (owner-signed admin write):
  - `agentId`, `ownerAddress`, `actorAddress`, `serviceSlug`, `endpointUrl`, `canaryPath`, `canaryMethod`
  - `authPayload`, `authSignature`

When configured, readiness resets to `CONFIGURED` until canary verify succeeds.

`GET` responses now also include settlement summary buckets for the selected agent context:
- `pending`
- `submitted`
- `confirmed`
- `failed`

## `POST /api/agent-gateway/verify`

Runs canary validation for configured gateway and updates readiness (`LIVE` / `DEGRADED` / `CONFIGURED`).

Body:
- `agentId`, `ownerAddress`, `actorAddress`, `serviceSlug`
- `authPayload`, `authSignature`

Returns:
- `200` on pass (`verified=true`, `readinessStatus=LIVE`)
- `422` on canary failure

## Delegated signer endpoints

### `GET /api/agent-gateway/delegated-signers?agentId=<id>`

Public-read list of active/revoked delegated signers for a gateway.

### `POST /api/agent-gateway/delegated-signers/register`

Owner-signed registration of delegated runtime signer.

Body:
- `agentId`, `ownerAddress`, `actorAddress`, `serviceSlug`, `signerAddress`
- `label` (optional)
- `authPayload`, `authSignature`

Constraints:
- Maximum active signers: `2`
- Duplicate active signer registration is idempotent (`alreadyActive=true`)

### `POST /api/agent-gateway/delegated-signers/revoke`

Owner-signed revocation by `delegatedSignerId`.

Body:
- `agentId`, `ownerAddress`, `actorAddress`, `serviceSlug`, `delegatedSignerId`
- `authPayload`, `authSignature`

Idempotent:
- Revoking an already-revoked signer returns `200` with `alreadyRevoked=true`.

## `POST /api/fulfillment/ticket`

Issue a fulfillment hold and signed ticket for a `LIVE` service.

### Request body

```json
{
  "serviceSlug": "agent-18755",
  "method": "POST",
  "path": "/ask",
  "cost": 1,
  "query": "mode=consumer",
  "clientRequestId": "fx-123",
  "ticketRequestAuth": {
    "payload": "<base64url-typed-message>",
    "signature": "0x..."
  }
}
```

### Success response (`200`)

Returns:
- `ticketId`
- `merchantTarget` (`endpointUrl`, `path`)
- `ticket` envelope (`version`, `payload`, `signature`)
- hold/balance transitions in `validated` (`creditsBefore/After`, `heldCreditsBefore/After`)

### Common errors

- `423 SERVICE_NOT_LIVE`
- `409 SERVICE_PRICING_UNAVAILABLE`
- `400 COST_MISMATCH`
- `402 INSUFFICIENT_CREDITS`
- `409 HOLD_CAP_EXCEEDED`
- `409 REPLAY`
- `500 FULFILLMENT_SIGNER_NOT_CONFIGURED`

## `POST /api/fulfillment/capture`

## Settlement operator endpoints

### `POST /api/admin/settlement/allocate`

Claims the next oldest batch of pending merchant earnings and submits it to GhostVault.

### `POST /api/admin/settlement/reconcile`

Reconciles submitted merchant earnings against on-chain `processedSettlementIds` and tx receipts.

### `GET /api/admin/settlement/metrics`

Returns pending, in-flight, confirmed, and failed settlement totals plus backlog age and drift diagnostics.

### `GET /api/admin/vault/preflight`

Reports legacy GhostVault liability, accrued fees, and balance before direct cutover.

Capture a held ticket using merchant delegated signer proof.

### Request body

```json
{
  "ticketId": "0x...",
  "deliveryProof": {
    "payload": "<base64url-typed-message>",
    "signature": "0x..."
  },
  "completionMeta": {
    "statusCode": 200,
    "latencyMs": 12
  }
}
```

### Success semantics

- First capture: `200`, `captureDisposition: "CAPTURED"`
- Same ticket + same deliveryProofId replay: `200`, `captureDisposition: "IDEMPOTENT_REPLAY"`

### Common errors

- `403 UNAUTHORIZED_DELEGATED_SIGNER`
- `409 HOLD_EXPIRED`
- `409 HOLD_NOT_ACTIVE`
- `409 CAPTURE_CONFLICT`

## `GET/POST /api/fulfillment/expire-sweep`

Operator endpoint to expire due held tickets and release credits.

Auth:
- `Authorization: Bearer <GHOST_FULFILLMENT_EXPIRE_SWEEP_SECRET>`
- or `x-ghost-fulfillment-expire-secret`

Query/body controls:
- `dryRun` (`true/false`)
- `limit` (bounded)

On execute, expired entries return dual-delta balance transitions:
- `creditsBefore/After`
- `heldCreditsBefore/After`

## Support endpoints (`/api/fulfillment/support/*`)

Auth:
- `Authorization: Bearer <GHOST_FULFILLMENT_SUPPORT_SECRET>`
- or `x-ghost-fulfillment-support-secret`

### `GET /api/fulfillment/support/ticket`

Query:
- `ticketId` (required, bytes32 hex)
- `attemptsLimit` (optional)
- `ledgerLimit` (optional)

Returns hold timeline, capture attempts, related ledger rows, and current wallet balance snapshot.

### `GET /api/fulfillment/support/metrics`

Query:
- `windowMinutes` (optional, default `60`)
- `serviceSlug` (optional)

Returns aggregate hold/capture/ledger transition metrics for operations/support.

## Agent Runtime Semantics (Fulfillment)

When integrating autonomous agents, these semantics are critical:

1. Capture replay with same `ticketId` + same `deliveryProofId`:
   - `200` + `captureDisposition: "IDEMPOTENT_REPLAY"`
2. Capture replay with same `ticketId` + different `deliveryProofId` after capture:
   - `409 CAPTURE_CONFLICT`
3. Expired hold at capture:
   - `409 HOLD_EXPIRED`
4. Non-live service at ticket issuance:
   - `423 SERVICE_NOT_LIVE`

Design agent policies around these deterministic state transitions rather than generic retries.

## `POST /api/gate/[service]`

Authorize access for a service slug and consume credits.

`GET /api/gate/[service]` is also supported with the same headers.

### Path parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `service` | string | Yes | Service slug (for example `agent-2212`, `weather`, `agent/run`). |

### Request headers

| Header | Required | Description |
|---|---|---|
| `x-ghost-sig` | Yes | Hex EIP-712 signature over payload. |
| `x-ghost-payload` | Yes | JSON string: `{"service","timestamp","nonce"}`. |
| `x-ghost-credit-cost` | Optional | Positive integer cost. May be ignored by server policy. |
| `x-ghost-request-id` | Optional | Caller-provided request ID (max length 128). |

Notes:

- If `GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE=false`, `x-ghost-credit-cost` is ignored.
- Server may resolve cost from DB service pricing, env pricing map, or default cost.

### Request example

```bash
curl -X POST "https://ghostprotocol.cc/api/gate/agent-2212" \
  -H "x-ghost-sig: 0xSIGNATURE" \
  -H "x-ghost-payload: {\"service\":\"agent-2212\",\"timestamp\":\"1739722000\",\"nonce\":\"f4f06e31b6f54d1ca6b13e9d8f16b66c\"}" \
  -H "x-ghost-credit-cost: 1" \
  -H "accept: application/json"
```

### Success response (`200`)

```json
{
  "authorized": true,
  "code": 200,
  "service": "agent-2212",
  "signer": "0xabc123...def456",
  "cost": "1",
  "remainingCredits": "99",
  "nonceAccepted": true,
  "requestId": "agent-2212:0xabc...:nonce",
  "receipt": null,
  "costSource": "default"
}
```

### Error responses

`400` malformed auth

```json
{
  "error": "Missing required auth headers",
  "code": 400
}
```

`401` signature/service errors

```json
{
  "error": "Invalid Signature",
  "code": 401
}
```

`402` insufficient credits

```json
{
  "error": "Payment Required",
  "code": 402,
  "details": {
    "balance": "0",
    "required": "1"
  }
}
```

`409` replay detected

```json
{
  "error": "Replay Detected",
  "code": 409
}
```

## `GET /api/telemetry/pulse`

Heartbeat liveness endpoint.

### Success response (`200`)

```json
{
  "status": "alive",
  "timestamp": 1739722000000
}
```

## `POST /api/telemetry/pulse`

Heartbeat payload endpoint.

### Request body

```json
{
  "apiKey": "sk_live_...",
  "agentId": "18755",
  "serviceSlug": "agent-18755"
}
```

### Success response (`200`)

```json
{
  "status": "ok",
  "timestamp": 1739722000000
}
```

## `POST /api/telemetry/outcome`

Consumer outcome endpoint.

### Request body

```json
{
  "apiKey": "sk_live_...",
  "agentId": "18755",
  "serviceSlug": "agent-18755",
  "success": true,
  "statusCode": 200
}
```

### Success response (`200`)

```json
{
  "status": "ok",
  "timestamp": 1739722000000
}
```

## `GET /api/sync-credits`

Sync credits from GhostVault `Deposited` logs.

### Query parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `userAddress` | string | Yes | EVM address to sync. |

### Request example

```bash
curl "https://ghostprotocol.cc/api/sync-credits?userAddress=0x1234...abcd"
```

### Success response (`200`)

```json
{
  "userAddress": "0x1234...abcd",
  "vaultAddress": "0xVaultAddress",
  "fromBlock": "123",
  "toBlock": "456",
  "headBlock": "470",
  "lastSyncedBlockBefore": "120",
  "lastSyncedBlock": "456",
  "matchedDeposits": 2,
  "depositedWeiSinceLastSync": "20000000000000000",
  "creditPriceWei": "10000000000000",
  "addedCredits": "2000",
  "credits": "2600",
  "partialSync": true,
  "remainingBlocks": "14",
  "nextFromBlock": "457",
  "maxBlocksPerRequest": "500",
  "logChunkSizeUsed": "500"
}
```

## `POST /api/sync-credits`

Alternative sync form with JSON body.

### Request body

```json
{
  "userAddress": "0x1234...abcd"
}
```

### Success response

Same shape as `GET /api/sync-credits`.

## `GET /api/agents`

Read ranked agents from Postgres (or active snapshot if enabled). Response includes background-indexer freshness metadata (`lastSyncedBlock`, `syncHealth`, `syncAgeSeconds`, `lastSyncedAt`).

### Query parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `owner` | string | No | Owner filter (`0x...`, case-insensitive). |
| `q` | string | No | Search by `agentId`, `name`, `address`, `owner`, `creator`. |
| `sort` | string | No | `volume` or default rank ordering. |
| `limit` | number | No | Rows per page (default `100`, max `1000`). |
| `page` | number | No | 1-based page index (default `1`). |

### Success response (`200`)

```json
{
  "totalAgents": 332,
  "activatedAgents": 12,
  "filteredTotal": 45,
  "page": 1,
  "limit": 100,
  "totalPages": 1,
  "filteredAgents": 45,
  "lastSyncedBlock": "42452698",
  "syncHealth": "live",
  "syncAgeSeconds": 90,
  "lastSyncedAt": "2026-02-21T20:14:00.000Z",
  "agents": []
}
```

Notes:
- `lastSyncedBlock` is the last persisted indexer cursor checkpoint (chunk-level), so it can trail current Base head during active indexing/backfills.
- `syncHealth` / `syncAgeSeconds` report indexing freshness and may temporarily degrade during RPC incidents or recovery runs.
- Indexing and scoring are separate background jobs, so rank freshness and chain-index freshness can momentarily diverge.

### Error response (`400`)

Invalid owner filter:

```json
{
  "error": "Invalid owner address."
}
```
