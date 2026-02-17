# API Reference

All endpoints below reflect the current Next.js API implementation.

## Authentication model

Ghost Gate uses signed headers:

- `x-ghost-sig`: EIP-712 signature
- `x-ghost-payload`: JSON payload string
- `x-ghost-credit-cost`: credit cost for this request

No bearer token is required for gate authorization. Signature validity and credit balance are the source of truth.

## `POST /api/gate/[service]`

Authorize access for a service slug and consume credits.

`GET /api/gate/[service]` is also supported with the same headers.

### Path parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `service` | string | Yes | Service slug to authorize (for example `connect`, `weather`, `agent/run`). |

### Required headers

| Header | Required | Description |
|---|---|---|
| `x-ghost-sig` | Yes | Hex EIP-712 signature over the payload. |
| `x-ghost-payload` | Yes | JSON string: `{"service","timestamp","nonce"}`. |
| `x-ghost-credit-cost` | Yes (recommended) | Positive integer credits to consume. Defaults to server value if omitted. |

### Request example

```bash
curl -X POST "https://ghostprotocol.cc/api/gate/connect" \
  -H "x-ghost-sig: 0xSIGNATURE" \
  -H "x-ghost-payload: {\"service\":\"connect\",\"timestamp\":\"1739722000\",\"nonce\":\"f4f06e31b6f54d1ca6b13e9d8f16b66c\"}" \
  -H "x-ghost-credit-cost: 1" \
  -H "accept: application/json"
```

### Success response (`200`)

```json
{
  "authorized": true,
  "code": 200,
  "service": "connect",
  "signer": "0xabc123...def456",
  "cost": "1",
  "remainingCredits": "99"
}
```

### Error responses

`400`

```json
{
  "error": "Missing required auth headers",
  "code": 400
}
```

`401`

```json
{
  "error": "Invalid Signature",
  "code": 401
}
```

`402`

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

## `POST /api/telemetry/pulse`

Heartbeat endpoint (currently stubbed).

### Request body

No strict schema currently enforced.

### Success response (`200`)

```json
{
  "status": "ok"
}
```

## `POST /api/telemetry/outcome`

Consumer outcome endpoint (currently stubbed).

### Request body

No strict schema currently enforced.

### Success response (`200`)

```json
{
  "status": "ok"
}
```

## `GET /api/sync-credits`

Sync user credits from GhostVault `Deposited` events.

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
  "lastSyncedBlockBefore": "120",
  "lastSyncedBlock": "456",
  "matchedDeposits": 2,
  "depositedWeiSinceLastSync": "20000000000000000",
  "creditPriceWei": "10000000000000",
  "addedCredits": "2000",
  "credits": "2600"
}
```

## `GET /api/agents`

Read ranked agents from Postgres.

### Query parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `owner` | string | No | Filter by owner address (case-insensitive). |
| `sort` | string | No | `volume` or default rank ordering. |
| `limit` | number | No | Max rows (default `200`, max `1000`). |

### Success response (`200`)

```json
{
  "totalAgents": 332,
  "filteredAgents": 12,
  "lastSyncedBlock": "42246258",
  "agents": []
}
```

