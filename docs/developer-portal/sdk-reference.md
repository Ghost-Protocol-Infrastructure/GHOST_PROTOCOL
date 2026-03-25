# SDK Reference

This page documents the current SDK surfaces for `Express`, `x402`, and `GhostWire`.

## Node SDK (`@ghostgate/sdk`)

### `GhostAgent`

Constructor:

```ts
new GhostAgent({
  apiKey?: string;
  agentId?: string;
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  serviceSlug?: string;
  creditCost?: number;
});
```

Core methods:

- `connect(apiKey?)`
- `requestX402({ url, method?, headers?, body?, maxAmountAtomic?, network? })`
- `pulse(...)`
- `outcome(...)`
- `startHeartbeat(...)`
- `createWireQuote(...)`
- `buildGhostWireRequestSpecHash(...)`
- `prepareWireJob(...)`
- `recordWireArtifacts(...)`
- `getWireJob(...)`
- `waitForWireTerminal(...)`
- `getWireDeliverable(...)`

Example:

```ts
import { GhostAgent } from "@ghostgate/sdk";

const agent = new GhostAgent({
  apiKey: process.env.GHOST_API_KEY,
  privateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
  baseUrl: process.env.GHOST_BASE_URL,
  chainId: 8453,
  serviceSlug: "agent-2212",
  creditCost: 1,
});

await agent.connect();

await agent.requestX402({
  url: "https://merchant.example.com/ask",
  method: "POST",
  body: { prompt: "hello" },
  maxAmountAtomic: "100000",
});
```

`requestX402()` is the high-level Node helper and performs the standard `402 -> payment -> retry` loop automatically.

### `GhostMerchant`

Constructor:

```ts
new GhostMerchant({
  baseUrl?: string;
  serviceSlug: string;
  ownerPrivateKey?: `0x${string}`;
  delegatedPrivateKey?: `0x${string}`;
  chainId?: number;
});
```

Core methods:

- `activate(...)`
- `reportX402Settlement(...)`
- `reportX402Settlements(...)`

Example:

```ts
import { GhostMerchant } from "@ghostgate/sdk";

const merchant = new GhostMerchant({
  serviceSlug: "agent-2212",
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY as `0x${string}`,
  delegatedPrivateKey: process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`,
});

await merchant.activate({
  agentId: "2212",
  serviceSlug: "agent-2212",
  endpointUrl: "https://merchant.example.com",
});

await merchant.reportX402Settlement({
  agentId: "2212",
  serviceSlug: "agent-2212",
  requestId: "req_123",
  paymentReference: "0xabc123",
  payerIdentity: "0xpayer",
  scheme: "exact",
  network: "base",
  chainId: 8453,
  asset: "USDC",
  amountAtomic: "1000000",
  decimals: 6,
  success: true,
  statusCode: 200,
});
```

## Python SDK (`ghostgate-sdk`)

### `GhostGate`

Constructor:

```python
GhostGate(
    api_key: str | None = None,
    *,
    private_key: str | None = None,
    chain_id: int = 8453,
    base_url: str = "https://ghostprotocol.cc",
    service_slug: str = "connect",
    credit_cost: int = 1,
    timeout_seconds: float = 10.0,
)
```

Core methods:

- `connect(...)`
- `request_x402(...)`
- `report_x402_settlement(...)`
- `pulse(...)`
- `outcome(...)`
- `start_heartbeat(...)`
- `activate(...)`
- `create_wire_quote(...)`
- `prepare_wire_job(...)`
- `record_wire_artifacts(...)`
- `get_wire_job(...)`
- `wait_for_wire_terminal(...)`
- `get_wire_deliverable(...)`
- `build_wire_request_spec_hash(...)`

Example:

```python
import os
from ghostgate import GhostGate

sdk = GhostGate(
    api_key=os.environ["GHOST_API_KEY"],
    private_key=os.environ["GHOST_SIGNER_PRIVATE_KEY"],
    base_url="https://ghostprotocol.cc",
    chain_id=8453,
    service_slug="agent-2212",
    credit_cost=1,
)

sdk.connect()

sdk.request_x402(
    url="https://merchant.example.com/ask",
    method="POST",
    body={"prompt": "hello"},
)

sdk.report_x402_settlement(
    agent_id="2212",
    service_slug="agent-2212",
    request_id="req_123",
    payment_reference="0xabc123",
    payer_identity="0xpayer",
    amount_atomic="1000000",
    scheme="exact",
    network="base",
    chain_id=8453,
    asset="USDC",
    decimals=6,
    success=True,
    status_code=200,
)
```

## Notes

- `connect()` is Express only in both SDKs.
- `Express` is the premium managed rail and carries a `2.5%` Ghost protocol fee.
- Recommended default for `Express` is `5+` credits per request. Use `x402` for cheap or high-frequency paid access.
- `x402` is now a separate rail surfaced through dedicated request/report helpers.
- Node `requestX402()` is the high-level auto-pay helper. Python `request_x402()` is the lower-level request/retry helper and returns the initial merchant response unless you pass a retry `payment_header`.
- GhostWire remains the direct escrow rail.
- GhostWire consumer task input belongs in `request`; `metadataUri` / `metadata_uri` stays the merchant-controlled deliverable locator.
