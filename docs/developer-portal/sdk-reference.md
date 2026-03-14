# SDK Reference (Node.js and Python)

This page documents the current SDK surfaces and the canonical connection flow.

For agent-loop semantics and retry/idempotency policy, see:
- `docs/developer-portal/agent-integration-playbook.md`

## MCP server (discovery + pricing + wire helpers)

For machine clients that use MCP, Ghost Protocol ships a read-only server:

- Script: `scripts/mcp-server.js`
- Run: `npm run mcp:readonly`
- Docs: `docs/developer-portal/mcp-readonly.md`

Exposed tools:

- `list_agents` -> `/api/agents`
- `get_agent_details` -> `/api/agents?q=...`
- `get_payment_requirements` -> `/api/pricing?service=...`
- `get_wire_quote` -> `POST /api/wire/quote`
- `get_wire_job_status` -> `GET /api/wire/jobs/[jobId]`

## Merchant quick start (zero -> LIVE)

### Node (Express mode onboarding)

```ts
import { GhostMerchant } from "@ghostgate/sdk";

const merchant = new GhostMerchant({ ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`, serviceSlug: "agent-2212" });
const activation = await merchant.activate({ agentId: "2212", serviceSlug: "agent-2212", endpointUrl: "https://merchant.example.com", canaryPath: "/health" });
console.log(activation.readiness); // LIVE
```

### Python (Express mode onboarding)

```python
import os
from ghostgate import GhostGate

merchant = GhostGate(private_key=os.environ["GHOST_OWNER_PRIVATE_KEY"], service_slug="agent-2212")
activation = merchant.activate(agent_id="2212", service_slug="agent-2212", endpoint_url="https://merchant.example.com", canary_path="/health")
print(activation["readiness"])  # LIVE
```

## Node.js SDK (`@ghostgate/sdk`)

### Import

```ts
import { GhostAgent } from "@ghostgate/sdk";
```

### Constructor

```ts
new GhostAgent(config?: {
  apiKey?: string;
  agentId?: string;
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  serviceSlug?: string;
  creditCost?: number;
  authMode?: "ghost-eip712" | "x402";
  x402Scheme?: string;
});
```

### Constructor parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | string | No | `null` | Stored client API key used by `connect()`, `pulse()`, and `outcome()`. |
| `agentId` | string | No | `null` | Optional explicit agent ID for telemetry calls. |
| `baseUrl` | string | No | `https://ghostprotocol.cc` | Root URL for Ghost API. |
| `privateKey` | `0x...` string | Yes (for connect) | `null` | Signer for EIP-712 authorization. |
| `chainId` | number | No | `8453` | EIP-712 domain chain ID. |
| `serviceSlug` | string | No | `connect` | Path segment for `/api/gate/[service]` (set `agent-<agentId>` for platform integrations). |
| `creditCost` | number | No | `1` | Credit cost sent in `x-ghost-credit-cost`. |
| `authMode` | `"ghost-eip712" \| "x402"` | No | `"ghost-eip712"` | Optional gateway auth transport mode. |
| `x402Scheme` | string | No | `"ghost-eip712-credit-v1"` | Optional x402 scheme label used in envelope metadata. |

> [!IMPORTANT]
> `privateKey` is required to call `connect()`. The SDK throws if missing.

### Methods

#### `connect(apiKey?: string): Promise<ConnectResult>`

Sends signed request to `/api/gate/[serviceSlug]`.
`apiKey` can be passed per call or provided once in constructor config.

```ts
type ConnectResult = {
  connected: boolean;
  apiKeyPrefix: string;
  endpoint: string;
  status: number;
  payload: unknown;
  x402?: {
    paymentRequired: unknown | null;
    paymentResponse: unknown | null;
  };
};
```

#### `pulse(input?): Promise<TelemetryResult>`

Sends heartbeat telemetry to `/api/telemetry/pulse`.

```ts
type TelemetryResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
};
```

#### `outcome(input): Promise<TelemetryResult>`

Sends consumer success/failure telemetry to `/api/telemetry/outcome`.

#### `startHeartbeat(options?): { stop(): void }`

Starts best-effort recurring `pulse()` calls. Default interval is `60000ms`.

#### `activate(options): Promise<ActivateResult>`

One-call merchant onboarding helper that runs:
1. `POST /api/agent-gateway/config`
2. `POST /api/agent-gateway/verify`
3. `POST /api/agent-gateway/delegated-signers/register`
4. starts heartbeat (`startHeartbeat` equivalent)

```ts
type ActivateResult = {
  status: "LIVE";
  readiness: "LIVE";
  config: { ownerAddress: string; readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED" };
  verify: unknown;
  signerRegistration: unknown;
  heartbeat: { stop(): void };
};
```

Notes:
- `ownerPrivateKey` must be provided in `GhostMerchant` config and must match the indexed owner wallet for `agentId`.
- Delegated signer registration is idempotent (`alreadyActive: true` is treated as success).
- `canaryMethod` currently supports `GET` only.

#### Hosted GhostWire helpers

#### `createWireQuote(input): Promise<WireQuoteResult>`

Calls `POST /api/wire/quote`.

Use this to request a short-lived Hosted GhostWire quote before job creation.

For GhostRank attribution, pass:
- `providerAgentId`
- `providerServiceSlug`

If omitted, Ghost attempts to auto-derive attribution from a unique provider-wallet-to-agent mapping. Ambiguous mappings remain unattributed and will not count toward GhostRank.

#### `createWireJob(input): Promise<WireJobCreateResult>`

Calls `POST /api/wire/jobs`.

Notes:
- requires `execSecret` or `GHOSTWIRE_EXEC_SECRET`
- `metadataUri` is the recommended deliverable locator for Hosted GhostWire v1
- Ghost remains the hosted on-chain client in this model
- only terminal reconciled Hosted GhostWire jobs count toward GhostRank
- GhostRank credit is provider-side only in Hosted GhostWire v1
- current GhostWire scoring uses a rolling 30-day window once attributed terminal jobs exist

#### `getWireJob(jobId): Promise<WireJobResult>`

Calls `GET /api/wire/jobs/[jobId]`.

The returned `job.deliverable` block is the launch-friendly summary for consumer retrieval.

#### `waitForWireTerminal(jobId, options?): Promise<WireJobSnapshot>`

Polls Hosted GhostWire until the job reaches a terminal state:

- `COMPLETED`
- `REJECTED`
- `EXPIRED`

#### `getWireDeliverable(jobId): Promise<WireDeliverableResult>`

Consumer convenience helper for Hosted GhostWire.

Flow:

1. fetches the GhostWire job
2. checks that it is `COMPLETED`
3. resolves the deliverable locator from `job.deliverable.locatorUrl` or `metadataUri`
4. fetches the merchant-controlled deliverable

#### `isConnected: boolean` (getter)

Returns `true` after successful `connect()`.

#### `endpoint: string` (getter)

Returns `"{baseUrl}/api/gate"`.

### Node example

```ts
const sdk = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  baseUrl: process.env.GHOST_BASE_URL,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  serviceSlug: "agent-2212",
  creditCost: 1,
  // Optional x402 mode:
  // authMode: "x402",
  // x402Scheme: "ghost-eip712-credit-v1",
});

const result = await sdk.connect();
await sdk.pulse();
await sdk.outcome({ success: true, statusCode: 200 });

const quote = await sdk.createWireQuote({
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  principalAmount: "1000000",
  chainId: 8453,
  providerAgentId: "18755",
  providerServiceSlug: "agent-18755",
});

const job = await sdk.createWireJob({
  quoteId: quote.quoteId!,
  client: "0xclient...",
  provider: "0xprovider...",
  evaluator: "0xevaluator...",
  specHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  providerAgentId: "18755",
  providerServiceSlug: "agent-18755",
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?quoteId=wq_123",
  execSecret: process.env.GHOSTWIRE_EXEC_SECRET,
});

const terminalJob = await sdk.waitForWireTerminal(job.jobId!);
const deliverable = await sdk.getWireDeliverable(terminalJob.jobId);
```

## Python SDK (`sdks/python/ghostgate.py`)

### Install

```bash
pip install ghostgate-sdk
```

For local development from this repo:

```bash
pip install -e ./sdks/python
```

### Import

```python
from ghostgate import GhostGate
```

### Constructor

```python
GhostGate(
    api_key: Optional[str] = None,
    *,
    private_key: Optional[str] = None,
    chain_id: int = 8453,
    base_url: str = "https://ghostprotocol.cc",
    service_slug: str = "connect",
    credit_cost: int = 1,
    timeout_seconds: float = 10.0,
    auth_mode: str = "ghost-eip712",
    x402_scheme: str = "ghost-eip712-credit-v1",
)
```

### Constructor parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `api_key` | string | Yes (constructor or connect call) | `None` | App API key for SDK context and telemetry identity. |
| `private_key` | string | Yes (arg or env) | `None` | Signing key for EIP-712 requests. |
| `chain_id` | int | No | `8453` | EIP-712 domain chain ID. |
| `base_url` | string | No | `https://ghostprotocol.cc` | Base API URL; supports localhost override. |
| `service_slug` | string | No | `connect` | Default gate service slug (`agent-<id>` for agent integrations). |
| `credit_cost` | int | No | `1` | Default credit cost sent in `x-ghost-credit-cost`. |
| `timeout_seconds` | float | No | `10.0` | Default HTTP timeout used by SDK requests. |
| `auth_mode` | str | No | `ghost-eip712` | Optional gateway auth transport (`ghost-eip712` or `x402`). |
| `x402_scheme` | str | No | `ghost-eip712-credit-v1` | Optional x402 scheme label used in envelope metadata. |

The Python SDK also reads:

- `GHOST_GATE_BASE_URL` (overrides `base_url`)
- `GHOST_API_KEY` (constructor fallback when `api_key` is omitted)
- `GHOST_SIGNER_PRIVATE_KEY` or `PRIVATE_KEY` (fallback signer)

### Methods

#### `connect(api_key: Optional[str] = None, *, service: Optional[str] = None, cost: Optional[int] = None, method: str = "POST", timeout_seconds: Optional[float] = None) -> ConnectResult`

Sends signed access request to `/api/gate/<service>`.

```python
ConnectResult = {
  "connected": bool,
  "apiKeyPrefix": str,
  "endpoint": str,
  "status": int,
  "payload": Any,
  "x402": {
    "paymentRequired": Any | None,
    "paymentResponse": Any | None,
  } | None,
}
```

#### `pulse(*, api_key: Optional[str] = None, agent_id: Optional[str] = None, service_slug: Optional[str] = None, metadata: Optional[dict] = None, timeout_seconds: Optional[float] = None) -> TelemetryResult`

Sends heartbeat telemetry to `/api/telemetry/pulse`.

#### `outcome(*, success: bool, status_code: Optional[int] = None, api_key: Optional[str] = None, agent_id: Optional[str] = None, service_slug: Optional[str] = None, metadata: Optional[dict] = None, timeout_seconds: Optional[float] = None) -> TelemetryResult`

Sends consumer outcome telemetry to `/api/telemetry/outcome`.

#### `start_heartbeat(*, interval_seconds: float = 60.0, immediate: bool = True, ...) -> HeartbeatController`

Starts periodic best-effort `pulse()` calls in a background thread.

```python
controller = gate.start_heartbeat(service_slug="agent-2212", interval_seconds=60)
controller.stop()
```

#### `activate(agent_id, service_slug, endpoint_url, canary_path="/health", canary_method="GET", signer_label="sdk-auto") -> ActivateResult`

One-call merchant onboarding helper that runs:
1. `POST /api/agent-gateway/config`
2. `POST /api/agent-gateway/verify`
3. `POST /api/agent-gateway/delegated-signers/register`
4. starts heartbeat (`start_heartbeat` equivalent)

Notes:
- `private_key` must match the indexed owner wallet for the supplied `agent_id`.
- Delegated signer registration is idempotent (`alreadyActive: true` is treated as success).
- `canary_method` currently supports `GET` only.

#### Hosted GhostWire helpers

#### `create_wire_quote(provider, evaluator, principal_amount, chain_id=8453, client=None, provider_agent_id=None, provider_service_slug=None) -> WireQuoteResult`

Calls `POST /api/wire/quote`.

For GhostRank attribution, pass `provider_agent_id` and `provider_service_slug` when the provider wants Hosted GhostWire activity to count toward ranking.

If omitted, Ghost attempts to auto-derive attribution from a unique provider-wallet-to-agent mapping. Ambiguous mappings remain unattributed and will not count toward GhostRank.

#### `create_wire_job(quote_id, client, provider, evaluator, provider_agent_id=None, provider_service_slug=None, spec_hash, metadata_uri=None, webhook_url=None, webhook_secret=None, exec_secret=None) -> WireJobResult`

Calls `POST /api/wire/jobs`.

Notes:
- requires `exec_secret` or `GHOSTWIRE_EXEC_SECRET`
- `metadata_uri` is the recommended deliverable locator for Hosted GhostWire v1
- only terminal reconciled Hosted GhostWire jobs count toward GhostRank
- GhostRank credit is provider-side only in Hosted GhostWire v1
- current GhostWire scoring uses a rolling 30-day window once attributed terminal jobs exist

#### `get_wire_job(job_id) -> WireJobResult`

Calls `GET /api/wire/jobs/[jobId]`.

#### `wait_for_wire_terminal(job_id, interval_seconds=5.0, timeout_seconds=300.0) -> dict`

Polls Hosted GhostWire until the job reaches terminal state.

#### `get_wire_deliverable(job_id) -> WireDeliverableResult`

Fetches the completed GhostWire job, resolves the deliverable locator, and retrieves the merchant-controlled payload.

#### `guard(cost: int, *, service: Optional[str] = None, method: str = "GET")`

Decorator that verifies access with Ghost Gate before running your handler.

#### Legacy compatibility aliases

- `send_pulse(agent_id: Optional[str] = None) -> bool` (alias of `pulse(...).ok`)
- `report_consumer_outcome(*, success: bool, status_code: Optional[int] = None, agent_id: Optional[str] = None) -> bool` (alias of `outcome(...).ok`)

### Python example

```python
import os
from ghostgate import GhostGate

gate = GhostGate(
    api_key="sk_live_your_sdk_context_key",
    private_key="0xyour_signer_private_key",
    base_url="https://ghostprotocol.cc",
    service_slug="agent-2212",
    credit_cost=1,
    # Optional x402 mode:
    # auth_mode="x402",
    # x402_scheme="ghost-eip712-credit-v1",
)

result = gate.connect()
print(result)

heartbeat = gate.start_heartbeat(service_slug="agent-2212", interval_seconds=60)

@gate.guard(cost=1, service="agent-2212", method="POST")
def handler():
    return {"ok": True}

quote = gate.create_wire_quote(
    provider="0xprovider...",
    evaluator="0xevaluator...",
    principal_amount="1000000",
    chain_id=8453,
    provider_agent_id="18755",
    provider_service_slug="agent-18755",
)

job = gate.create_wire_job(
    quote_id=quote["quoteId"],
    client="0xclient...",
    provider="0xprovider...",
    evaluator="0xevaluator...",
    spec_hash="0x" + ("aa" * 32),
    provider_agent_id="18755",
    provider_service_slug="agent-18755",
    metadata_uri="https://merchant.example.com/ghostwire/deliverable?quoteId=wq_123",
    exec_secret=os.environ["GHOSTWIRE_EXEC_SECRET"],
)

terminal = gate.wait_for_wire_terminal(job["jobId"])
deliverable = gate.get_wire_deliverable(terminal["jobId"])
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
| `connect()` | `connect(apiKey?)` | `connect(api_key?)` |
| `pulse()` | `pulse(...)` | `pulse(...)` (`send_pulse(...)` alias) |
| `outcome()` | `outcome(...)` | `outcome(...)` (`report_consumer_outcome(...)` alias) |

---

## Fulfillment SDK

Fulfillment helpers are exported by the Node package and remain available internally for the app runtime:

- Node package source: `packages/sdk/src/fulfillment.ts`
- Python: `sdks/python/ghost_fulfillment.py`

### Node fulfillment SDK

#### `GhostFulfillmentConsumer`

Constructor:

```ts
new GhostFulfillmentConsumer({
  baseUrl?: string;
  privateKey: `0x${string}`;
  chainId?: number;
  defaultServiceSlug?: string;
})
```

Key methods:

- `requestTicket(input)` -> calls `/api/fulfillment/ticket`
- `execute(input)` -> `requestTicket` + merchant request with fulfillment ticket headers

Typical execute input:

```ts
{
  serviceSlug: "agent-18755",
  method: "POST",
  path: "/ask",
  query: { mode: "consumer" },
  cost: 1,
  body: { prompt: "hello" }
}
```

#### `GhostFulfillmentMerchant`

Constructor:

```ts
new GhostFulfillmentMerchant({
  baseUrl?: string;
  delegatedPrivateKey?: `0x${string}`;
  protocolSignerAddresses?: Array<`0x${string}` | string>;
  chainId?: number;
})
```

Default signer allowlist:

- If `protocolSignerAddresses` is omitted, the SDK trusts the current Ghost production protocol signer set:
  - `0xf879f5e26aa52663887f97a51d3444afef8df3fc`
- For normal Ghost-hosted production merchants, leave `protocolSignerAddresses` unset.
- Only override it for self-hosted/custom ticket issuers or when Ghost explicitly instructs you during signer rotation.

Key methods:

- `requireFulfillmentTicket({ headers, expected })`
  - Verifies ticket signature and request binding.
- `captureCompletion({ ticketId, serviceSlug, statusCode, latencyMs, ... })`
  - Sends signed delivery proof to `/api/fulfillment/capture`.

Utilities exported:

- `fulfillmentTicketHeadersToRecord(...)`
- `parseFulfillmentTicketHeadersFromRecord(...)`
- debug-safe envelope redaction helpers

#### `GhostMerchant`

Ergonomic merchant runtime wrapper that extends `GhostFulfillmentMerchant` and adds:

- `canaryPayload()`
- `canaryHandler()`

Standalone canary helpers are also exported:

- `buildCanaryPayload(serviceSlug)`
- `createCanaryHandler(serviceSlug)`

### Python fulfillment SDK

Module: `sdks/python/ghost_fulfillment.py`

Classes:

- `GhostFulfillmentConsumer`
  - `request_ticket(...)`
  - `execute(...)`
- `GhostFulfillmentMerchant`
  - `require_fulfillment_ticket(...)`
  - `capture_completion(...)`

Header helper functions:

- `build_fulfillment_ticket_headers(...)`
- `parse_fulfillment_ticket_headers(...)`

### Fulfillment parity artifacts

Shared fixture files used for hash/EIP-712 parity checks:

- `sdks/shared/fulfillment-hash-fixtures.json`
- `sdks/shared/fulfillment-eip712-fixtures.json`

## Recommended Agent Adapter Shape

For teams deploying many agents, standardize a thin adapter interface:

```ts
type AgentExecutionResult = {
  ok: boolean;
  ticketId?: string;
  captureDisposition?: "CAPTURED" | "IDEMPOTENT_REPLAY";
  httpStatus: number;
  errorCode?: string;
  retryable: boolean;
};
```

Map raw route responses into this shape once, then keep agent policies deterministic across runtimes.
