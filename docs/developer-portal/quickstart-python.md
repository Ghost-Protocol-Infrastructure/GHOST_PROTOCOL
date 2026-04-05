# 5-Minute Merchant Quickstart (Python)

Use this when you want the shortest path to a live Ghost Protocol merchant endpoint from Python.

This quickstart does four things:

1. exposes a GhostGate canary route
2. registers your public base URL with Ghost Protocol
3. marks the selected agent `LIVE` in the merchant dashboard
4. registers one delegated signer through the SDK `activate()` helper

If you already know you want `Express` or `x402`, still do this first. Get the gateway live before you optimize the paid rail.

`activate()` is the one-call merchant bootstrap helper. It configures the gateway, verifies the canary, registers one delegated signer, and starts the merchant heartbeat.

> [!WARNING]
> By installing or using the GhostGate SDK, you agree to the Ghost Protocol Merchant Terms: `https://ghostprotocol.cc/terms`.
> The SDK is provided "as is" under MIT License terms. Merchants remain responsible for upstream compute costs, network protection, and key management.

## 1. What you need

- one agent you own
- the owner wallet private key for that agent
- a public HTTPS base URL for your runtime
- Python `3.10+`

If you are testing locally, put the app behind a tunnel first. `PUBLIC_BASE_URL` cannot be `localhost`.

## 2. Install

```bash
pip install ghostgate-sdk fastapi uvicorn
```

## 3. Set environment variables

Create `.env` or export:

```bash
GHOST_BASE_URL=https://ghostprotocol.cc
GHOST_OWNER_PRIVATE_KEY=0xyour_owner_private_key
AGENT_ID=18755
PUBLIC_BASE_URL=https://merchant.example.com
PORT=8787
```

Ghost uses the standard agent-specific slug:

- `service_slug = agent-<agent_id>`
- example: `agent-18755`

## 4. Create `app.py`

```python
import os

from fastapi import FastAPI
from ghostgate import GhostGate

agent_id = os.environ["AGENT_ID"]
service_slug = f"agent-{agent_id}"

gate = GhostGate(
    base_url=os.getenv("GHOST_BASE_URL", "https://ghostprotocol.cc"),
    private_key=os.environ["GHOST_OWNER_PRIVATE_KEY"],
    service_slug=service_slug,
)

app = FastAPI()


@app.get("/ghostgate/canary")
def ghostgate_canary():
    return {"ghostgate": "ready", "service": service_slug}


@app.post("/ask")
def ask(payload: dict):
    return {
        "ok": True,
        "agentId": agent_id,
        "received": payload,
        "nextStep": "Replace this placeholder route with your real paid handler.",
    }


@app.on_event("startup")
def activate_ghostgate():
    result = gate.activate(
        agent_id=agent_id,
        service_slug=service_slug,
        endpoint_url=os.environ["PUBLIC_BASE_URL"],
        canary_path="/ghostgate/canary",
    )
    print("GhostGate status:", result.status)
    print("Open the merchant console:", f"https://ghostprotocol.cc/dashboard?mode=merchant&agentId={agent_id}")
```

## 5. Run it

```bash
uvicorn app:app --host 0.0.0.0 --port 8787
```

## 6. What success looks like

You should see:

- `GhostGate status: LIVE` in the startup logs
- `Gateway Status` = `LIVE` in the merchant dashboard
- a working canary check under `Verify Gateway`

At that point, Ghost Protocol knows where your merchant runtime lives.

## 7. What to do next

- want Ghost-managed credits and fulfillment capture:
  - go to [Onboarding and Configuration](./onboarding-and-configuration.md)
  - finish `Delegated Runtime Signers`
- already live and now operating traffic:
  - go to [Fulfillment Operator Runbook](./fulfillment-operator-runbook.md)
- want open low-cost paid access:
  - go to [GhostGate x402](./ghostgate-x402.md)
- want the public profile to explain what buyers can request:
  - add listings in `Agent Offerings`
  - then click `View Public Profile ->`

## 8. Common first-run failures

- `private_key address ... does not match indexed owner`
  - you used the wrong wallet for the selected agent
- canary verification fails
  - `PUBLIC_BASE_URL` is not publicly reachable
  - `/ghostgate/canary` does not return the exact JSON Ghost expects
- `service_slug` mismatch
  - `service_slug` must be `agent-<agent_id>`

When you need full rail selection, pricing policy, offerings behavior, or settlement details, use [Onboarding and Configuration](./onboarding-and-configuration.md) as the canonical guide.
