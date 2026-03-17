# GhostGate Python SDK

Python SDK for Ghost Protocol gate access, telemetry, and direct GhostWire helpers.

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

quote = sdk.create_wire_quote(
    client="0xclient...",
    provider="0xprovider...",
    evaluator="0xevaluator...",
    principal_amount="1000000",
    chain_id=8453,
)

prepared = sdk.prepare_wire_job(
    quote_id=quote["quoteId"],
    client="0xclient...",
    provider="0xprovider...",
    evaluator="0xevaluator...",
    spec_hash="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadata_uri="https://merchant.example.com/ghostwire/deliverable?jobId=wj_123",
)

# Client wallet sends prepared["direct"]["createTxRequest"] here, then reports the hash:
after_create = sdk.record_wire_artifacts(
    job_id=prepared["jobId"],
    client_address="0xclient...",
    create_tx_hash="0xcreate...",
)

# Client wallet sends after_create["direct"]["setBudgetTxRequest"] and
# after_create["direct"]["fundTxRequest"] here, then reports the funding hash.
sdk.record_wire_artifacts(
    job_id=prepared["jobId"],
    client_address="0xclient...",
    fund_tx_hash="0xfund...",
)
```

## Canonical methods

- `connect(...)`
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

## Security note

Use signer private keys only in trusted backend/server/CLI environments. Never expose private keys in frontend code.
