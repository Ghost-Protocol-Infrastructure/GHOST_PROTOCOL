# API Reference

All endpoints below reflect the current Next.js API implementation.

## Authentication model

Ghost Gate uses signed headers:

- `x-ghost-sig`: EIP-712 signature
- `x-ghost-payload`: JSON payload string
- `x-ghost-credit-cost`: optional request cost override

No bearer token is required for gate authorization. Signature validity and credits are the source of truth.

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

Heartbeat endpoint (currently lightweight/stubbed).

### Success response (`200`)

```json
{
  "status": "alive",
  "timestamp": 1739722000000
}
```

## `POST /api/telemetry/pulse`

Heartbeat payload endpoint (currently lightweight/stubbed).

### Request body

No strict schema is currently enforced.

### Success response (`200`)

```json
{
  "status": "ok",
  "timestamp": 1739722000000
}
```

## `POST /api/telemetry/outcome`

Consumer outcome endpoint (currently stubbed).

### Request body

No strict schema is currently enforced.

### Success response (`200`)

```json
{
  "status": "ok"
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

Read ranked agents from Postgres (or active snapshot if enabled).

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

### Error response (`400`)

Invalid owner filter:

```json
{
  "error": "Invalid owner address."
}
```
