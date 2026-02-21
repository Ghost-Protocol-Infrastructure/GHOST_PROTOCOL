# SDK Reference (Node.js and Python)

This page documents the current SDK surfaces and the canonical connection flow.

## Node.js SDK (`sdks/node/index.ts`)

### Import

```ts
import { GhostAgent } from "@ghost/sdk";
```

### Constructor

```ts
new GhostAgent(config?: {
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  serviceSlug?: string;
  creditCost?: number;
});
```

### Constructor parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseUrl` | string | No | `https://ghostprotocol.cc` | Root URL for Ghost API. |
| `privateKey` | `0x...` string | Yes (for connect) | `null` | Signer for EIP-712 authorization. |
| `chainId` | number | No | `8453` | EIP-712 domain chain ID. |
| `serviceSlug` | string | No | `connect` | Path segment for `/api/gate/[service]` (set `agent-<agentId>` for platform integrations). |
| `creditCost` | number | No | `1` | Credit cost sent in `x-ghost-credit-cost`. |

> [!IMPORTANT]
> `privateKey` is required to call `connect()`. The SDK throws if missing.

### Methods

#### `connect(apiKey: string): Promise<ConnectResult>`

Sends signed request to `/api/gate/[serviceSlug]`.
`apiKey` is used by the SDK for client context/prefix reporting; Gate authorization itself is signature + credits based.

```ts
type ConnectResult = {
  connected: boolean;
  apiKeyPrefix: string;
  endpoint: string;
  status: number;
  payload: unknown;
};
```

#### `isConnected: boolean` (getter)

Returns `true` after successful `connect()`.

#### `endpoint: string` (getter)

Returns `"{baseUrl}/api/gate"`.

### Node example

```ts
const sdk = new GhostAgent({
  baseUrl: process.env.GHOST_BASE_URL,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  serviceSlug: "agent-2212",
  creditCost: 1,
});

const result = await sdk.connect(process.env.GHOST_API_KEY!);
```

## Python SDK (`sdks/python/ghostgate.py`)

### Import

```python
from ghostgate import GhostGate
```

### Constructor

```python
GhostGate(
    api_key: str,
    *,
    private_key: Optional[str] = None,
    chain_id: int = 8453,
    base_url: str = "https://ghostprotocol.cc",
)
```

### Constructor parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `api_key` | string | Yes | - | App API key for telemetry and SDK context. |
| `private_key` | string | Yes (arg or env) | `None` | Signing key for EIP-712 requests. |
| `chain_id` | int | No | `8453` | EIP-712 domain chain ID. |
| `base_url` | string | No | `https://ghostprotocol.cc` | Base API URL; supports localhost override. |

The Python SDK also reads:

- `GHOST_GATE_BASE_URL` (overrides `base_url`)
- `GHOST_SIGNER_PRIVATE_KEY` or `PRIVATE_KEY` (fallback signer)

### Methods

#### `guard(cost: int, *, service: str = "weather", method: str = "GET")`

Decorator that verifies access with Ghost Gate before running your handler.

#### `send_pulse(agent_id: Optional[str] = None) -> bool`

Sends best-effort heartbeat payload to `/api/telemetry/pulse`.
Current server telemetry behavior is lightweight/stubbed.

#### `report_consumer_outcome(*, success: bool, status_code: Optional[int] = None, agent_id: Optional[str] = None) -> bool`

Sends usage outcome to `/api/telemetry/outcome`.

### Python example

```python
from ghostgate import GhostGate

gate = GhostGate(
    api_key="sk_live_your_api_key",
    private_key="0xyour_private_key",
    base_url="http://localhost:3000",
)

@gate.guard(cost=1, service="agent-2212", method="POST")
def handler():
    return {"ok": True}
```

For platform integrations, use service slug format `agent-<agentId>` (example: `agent-2212`).

## Canonical flow mapping: `connect()`, `pulse()`, `outcome()`

Ghost Protocol docs use three canonical integration actions:

1. `connect()` -> Authenticate and consume credits through `/api/gate/[service]`.
2. `pulse()` -> Merchant heartbeat telemetry.
3. `outcome()` -> Consumer success/failure telemetry.

Current SDK names:

| Canonical action | Node SDK | Python SDK |
|---|---|---|
| `connect()` | `connect(apiKey)` | `guard(...)/_verify_access(...)` |
| `pulse()` | HTTP call to `/api/telemetry/pulse` | `send_pulse(...)` |
| `outcome()` | HTTP call to `/api/telemetry/outcome` | `report_consumer_outcome(...)` |
