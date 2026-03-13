# GhostGate Python SDK

Python SDK for Ghost Protocol gate access, telemetry, and Hosted GhostWire helpers.

## Install

```bash
pip install ghostgate-sdk
```

## Quickstart

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
    # Optional x402 compatibility mode:
    # auth_mode="x402",
    # x402_scheme="ghost-eip712-credit-v1",
)

result = sdk.connect()
print(result)
```

## Canonical methods

- `connect(...)`
- `pulse(...)`
- `outcome(...)`
- `start_heartbeat(...)`
- `create_wire_quote(...)`
- `create_wire_job(...)`
- `get_wire_job(...)`
- `wait_for_wire_terminal(...)`
- `get_wire_deliverable(...)`

Backward-compatible aliases are also available:

- `send_pulse(...)`
- `report_consumer_outcome(...)`

## Security note

Use signer private keys only in trusted backend/server/CLI environments. Never expose private keys in frontend code.
