# GhostGate Python SDK

Python SDK for Ghost Protocol:

- `Express` access via `connect()`
- standards-native `x402` requests via `request_x402()`
- automatic x402 settlement reporting for long-lived Python servers
- merchant x402 settlement reporting via `report_x402_settlement()`
- `GhostWire` direct escrow helpers

## Install

```bash
pip install ghostgate-sdk
```

## Express example

```python
import os
from ghostgate import GhostGate, build_wire_request_spec_hash

sdk = GhostGate(
    api_key=os.environ["GHOST_API_KEY"],
    private_key=os.environ["GHOST_SIGNER_PRIVATE_KEY"],
    base_url=os.getenv("GHOST_GATE_BASE_URL", "https://ghostprotocol.cc"),
    chain_id=8453,
    service_slug="agent-18755",
    credit_cost=5,
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

For long-lived Python servers, auto-reporting is the default onboarding path.

Available Python x402 surfaces:

- `create_settlement_evidence(...)`
- `create_x402_settlement_reporter(...)`
- `with_ghost_x402_fastapi(...)`
- `with_ghost_x402_flask(...)`
- `report_x402_settlement(...)`

The canonical settlement evidence contract is the same across SDKs:

- `request_id`
- `payment_reference`
- `payer_identity`
- `payer_address`
- `scheme`
- `network`
- `chain_id`
- `asset`
- `amount_atomic`
- `decimals`
- `success`
- `status_code`
- `latency_ms`
- `occurred_at`
- `metadata`

### Automatic reporting example

```python
from ghostgate import GhostGate, GhostX402AdapterConfig, with_ghost_x402_fastapi

sdk = GhostGate(
    private_key=os.environ["GHOST_SIGNER_PRIVATE_KEY"],
    base_url=os.getenv("GHOST_GATE_BASE_URL", "https://ghostprotocol.cc"),
    chain_id=8453,
    service_slug="agent-18755",
)

reporter = sdk.create_x402_settlement_reporter(
    runtime="python_server",
    on_event=lambda event: print(event["name"], event["queueSize"]),
)

config = GhostX402AdapterConfig(
    gate=sdk,
    agent_id="18755",
    payment_requirements={
        "scheme": "exact",
        "network": "base",
        "maxAmountRequired": "1000000",
        "resource": "https://merchant.example.com/ask",
        "description": "Paid ask endpoint",
        "mimeType": "application/json",
        "payTo": "0x1111111111111111111111111111111111111111",
        "maxTimeoutSeconds": 300,
        "asset": "USDC",
        "extra": {"decimals": 6},
    },
    x402_client=object(),
    reporter=reporter,
    decode_payment_header=lambda _header: {"scheme": "exact", "network": "base"},
    verify_payment=lambda _input: {"isValid": True, "payer": "0xpayer"},
    settle_payment=lambda _input: {
        "success": True,
        "transaction": "0xabc123",
        "network": "base",
        "payer": "0xpayer",
    },
)

paid_handler = with_ghost_x402_fastapi(
    config,
    lambda _args: {"ok": True},
)
```

Use `reporter.get_snapshot()["counters"]` and `on_event` to measure:

- `payment_verified`
- `report_enqueued`
- `report_sent`
- `report_accepted`
- `duplicate`
- `report_dropped`

### Manual fallback

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

Keep the direct `report_x402_settlement(...)` path available for unsupported runtimes, incident recovery, or custom merchants that do not use the framework wrappers.

## Canonical methods

- `connect(...)`
- `request_x402(...)`
- `report_x402_settlement(...)`
- `create_x402_settlement_reporter(...)`
- `with_ghost_x402_fastapi(...)`
- `with_ghost_x402_flask(...)`
- `pulse(...)`
- `outcome(...)`
- `start_heartbeat(...)`
- `create_wire_quote(...)`
- `prepare_wire_job(...)`
- `record_wire_artifacts(...)`
- `get_wire_job(...)`
- `wait_for_wire_terminal(...)`
- `get_wire_deliverable(...)`
- `build_wire_request_spec_hash(...)`

## GhostWire request example

```python
request_payload = {
    "prompt": "Roast my wallet honestly.",
    "walletAddress": "0xclient...",
    "metadata": {
        "skill": "booski",
        "tone": "merciless",
    },
}

prepared = sdk.prepare_wire_job(
    quote_id="wq_123",
    client="0xclient...",
    provider="0xprovider...",
    evaluator="0xevaluator...",
    request=request_payload,
    spec_hash=build_wire_request_spec_hash(request_payload),
    metadata_uri="https://merchant.example.com/ghostwire/deliverable?contract=0x...&job=3",
)
```

Automatic x402 reporting in the MVP is first-class for long-lived Python servers with `runtime="python_server"`.

Use:

- `runtime="python_server"` for long-lived servers
- `runtime="serverless_python"` for best-effort auto-reporting in short-lived runtimes
- direct `report_x402_settlement(...)` as the manual fallback when you want explicit control

Backward-compatible aliases are also available:

- `send_pulse(...)`
- `report_consumer_outcome(...)`

## Notes

- `connect()` is Express only.
- `Express` carries a `2.5%` Ghost protocol fee and is intended for premium managed paid access.
- Recommended default for `Express` is `5+` credits per request. Use `x402` for cheap or high-frequency paid access.
- `request_x402()` is the real x402 helper, but it is intentionally low-level: it returns the initial challenge unless you supply a retry `payment_header`.
- GhostRank credit for x402 should normally come from the framework wrapper + shared reporter path on supported runtimes. Keep direct `report_x402_settlement(...)` as the fallback.
- For GhostWire, `request` is the consumer-authored task payload. Keep `metadata_uri` for the merchant-controlled deliverable locator.
- Use signer private keys only in trusted backend/server/CLI environments.
