# GhostGate Python SDK

Python SDK for Ghost Protocol:

- `Express` access via `connect()`
- standards-native `x402` requests via `request_x402()`
- merchant x402 settlement reporting via `report_x402_settlement()`
- `GhostWire` direct escrow helpers

## Install

```bash
pip install ghostgate-sdk
```

## Express example

```python
import os
from ghostgate import GhostGate

sdk = GhostGate(
    api_key=os.environ["GHOST_API_KEY"],
    private_key=os.environ["GHOST_SIGNER_PRIVATE_KEY"],
    base_url=os.getenv("GHOST_GATE_BASE_URL", "https://ghostprotocol.cc"),
    chain_id=8453,
    service_slug="agent-18755",
    credit_cost=1,
)

result = sdk.connect()
print(result)
```

## x402 example

`request_x402()` is the low-level Python helper. Without `payment_header`, it returns the initial merchant response, which may be a `402` challenge. Pass a valid `payment_header` on the retry if you want to complete the flow yourself.

```python
import os
from ghostgate import GhostGate

sdk = GhostGate(
    private_key=os.environ["GHOST_SIGNER_PRIVATE_KEY"],
    chain_id=8453,
)

result = sdk.request_x402(
    url="https://merchant.example.com/ask",
    method="POST",
    body={"prompt": "hello"},
)

print(result)
```

## Merchant x402 settlement reporting

```python
report = sdk.report_x402_settlement(
    agent_id="18755",
    service_slug="agent-18755",
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

print(report)
```

## Canonical methods

- `connect(...)`
- `request_x402(...)`
- `report_x402_settlement(...)`
- `pulse(...)`
- `outcome(...)`
- `start_heartbeat(...)`
- `create_wire_quote(...)`
- `prepare_wire_job(...)`
- `record_wire_artifacts(...)`
- `get_wire_job(...)`
- `wait_for_wire_terminal(...)`
- `get_wire_deliverable(...)`

Backward-compatible aliases are also available:

- `send_pulse(...)`
- `report_consumer_outcome(...)`

## Notes

- `connect()` is Express only.
- `Express` carries a `2.5%` Ghost protocol fee and is intended for premium managed paid access.
- Recommended default for `Express` is `5+` credits per request. Use `x402` for cheap or high-frequency paid access.
- `request_x402()` is the real x402 helper, but it is intentionally low-level: it returns the initial challenge unless you supply a retry `payment_header`.
- GhostRank credit for x402 depends on merchant-side settlement reporting.
- Use signer private keys only in trusted backend/server/CLI environments.
