# GhostWire Webhooks

GhostWire can POST signed lifecycle events to your backend when a wire job moves through the ERC-8183 state machine.

## Event model

GhostWire emits one lifecycle webhook per state transition:

- `wire.job.open`
- `wire.job.funded`
- `wire.job.submitted`
- `wire.job.completed`
- `wire.job.rejected`
- `wire.job.expired`

These map directly to the mirrored GhostWire lifecycle:

- `OPEN`
- `FUNDED`
- `SUBMITTED`
- terminal:
  - `COMPLETED`
  - `REJECTED`
  - `EXPIRED`

`wire.job.completed`, `wire.job.rejected`, and `wire.job.expired` always include a terminal settlement payload.

## Delivery contract

GhostWire sends `POST` requests with `content-type: application/json` and these headers:

- `x-ghost-event-id`
- `x-ghost-event-type`
- `x-ghost-timestamp`
- `x-ghost-signature`
- `x-ghost-delivery-attempt`

Signature format:

```text
v1=<hex_hmac_sha256>
```

Signed payload:

```text
${timestamp}.${rawBody}
```

Rules:

- Verify the signature against the raw request body, not parsed JSON.
- Enforce a `5` minute replay window.
- Deduplicate on `x-ghost-event-id`.
- Return any `2xx` status only after you have durably recorded the event.

## Example payloads

### `wire.job.open`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "OPEN",
  "contractState": "OPEN",
  "createdAt": "2026-03-10T20:00:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  }
}
```

### `wire.job.funded`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "FUNDED",
  "contractState": "FUNDED",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "contractJobId": "42",
  "createTxHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fundTxHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "observedAt": "2026-03-10T20:03:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  }
}
```

### `wire.job.submitted`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "SUBMITTED",
  "contractState": "SUBMITTED",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "contractJobId": "42",
  "fundTxHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "observedAt": "2026-03-10T20:10:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  }
}
```

### `wire.job.completed`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "COMPLETED",
  "contractState": "COMPLETED",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "contractJobId": "42",
  "terminalDisposition": "COMPLETED",
  "terminalTxHash": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "observedAt": "2026-03-10T20:20:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  },
  "settlement": {
    "providerPayout": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolRevenue": { "asset": "USDC", "amount": "12500000", "decimals": 6 },
    "actualNetworkSpend": { "asset": "ETH", "amount": "1840000000000000", "decimals": 18 },
    "unusedNetworkReserveRefund": { "asset": "ETH", "amount": "1160000000000000", "decimals": 18 }
  }
}
```

### `wire.job.rejected`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "REJECTED",
  "contractState": "REJECTED",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "contractJobId": "42",
  "terminalDisposition": "REJECTED",
  "terminalTxHash": "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "observedAt": "2026-03-10T20:21:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  },
  "settlement": {
    "providerPayout": { "asset": "USDC", "amount": "0", "decimals": 6 },
    "protocolRevenue": { "asset": "USDC", "amount": "0", "decimals": 6 },
    "actualNetworkSpend": { "asset": "ETH", "amount": "1900000000000000", "decimals": 18 },
    "unusedNetworkReserveRefund": { "asset": "ETH", "amount": "1100000000000000", "decimals": 18 }
  }
}
```

### `wire.job.expired`

```json
{
  "jobId": "wj_123",
  "quoteId": "wq_123",
  "state": "EXPIRED",
  "contractState": "EXPIRED",
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "contractJobId": "42",
  "terminalDisposition": "EXPIRED",
  "terminalTxHash": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "observedAt": "2026-03-10T20:22:00.000Z",
  "pricing": {
    "principal": { "asset": "USDC", "amount": "500000000", "decimals": 6 },
    "protocolFee": { "asset": "USDC", "amount": "12500000", "decimals": 6, "bps": 250 },
    "networkReserve": { "asset": "ETH", "amount": "3000000000000000", "decimals": 18, "chainId": 8453 }
  },
  "settlement": {
    "providerPayout": { "asset": "USDC", "amount": "0", "decimals": 6 },
    "protocolRevenue": { "asset": "USDC", "amount": "0", "decimals": 6 },
    "actualNetworkSpend": { "asset": "ETH", "amount": "1750000000000000", "decimals": 18 },
    "unusedNetworkReserveRefund": { "asset": "ETH", "amount": "1250000000000000", "decimals": 18 }
  }
}
```

## Node.js verification example

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const app = express();
const secret = process.env.GHOSTWIRE_WEBHOOK_SECRET ?? "";

app.post(
  "/ghostwire/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const timestamp = req.header("x-ghost-timestamp") ?? "";
    const signature = req.header("x-ghost-signature") ?? "";
    const eventId = req.header("x-ghost-event-id") ?? "";
    const rawBody = req.body.toString("utf8");

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = `v1=${createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex")}`;

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(signature.trim());
    const fresh =
      /^\d+$/.test(timestamp) &&
      Math.abs(Math.floor(Date.now() / 1000) - Number.parseInt(timestamp, 10)) <= 300;

    const valid =
      fresh &&
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer);

    if (!valid) {
      res.status(401).json({ ok: false, error: "Invalid GhostWire webhook signature." });
      return;
    }

    const payload = JSON.parse(rawBody) as { jobId: string; state: string };
    console.log("accepted", { eventId, jobId: payload.jobId, state: payload.state });
    res.status(200).json({ ok: true });
  },
);
```

## Python verification example

```python
import hashlib
import hmac
import json
import os
import time
from flask import Flask, request, jsonify

app = Flask(__name__)
SECRET = (os.environ.get("GHOSTWIRE_WEBHOOK_SECRET") or "").encode("utf-8")


def verify(timestamp: str, signature: str, raw_body: bytes) -> bool:
    if not timestamp.isdigit():
        return False
    if abs(int(time.time()) - int(timestamp)) > 300:
        return False

    payload = f"{timestamp}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = "v1=" + hmac.new(SECRET, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip())


@app.post("/ghostwire/webhook")
def ghostwire_webhook():
    timestamp = request.headers.get("x-ghost-timestamp", "")
    signature = request.headers.get("x-ghost-signature", "")
    event_id = request.headers.get("x-ghost-event-id", "")
    raw_body = request.get_data(cache=False)

    if not verify(timestamp, signature, raw_body):
        return jsonify({"ok": False, "error": "Invalid GhostWire webhook signature."}), 401

    payload = json.loads(raw_body.decode("utf-8"))
    print("accepted", {"eventId": event_id, "jobId": payload["jobId"], "state": payload["state"]})
    return jsonify({"ok": True}), 200
```

## Operational notes

- `wire.job.submitted` is automatic only after the underlying ERC-8183 `submit` transaction is on-chain and confirmed.
- `wire.job.completed` and `wire.job.rejected` are reconciled automatically once the evaluator finalizes the on-chain job.
- `wire.job.expired` can be triggered automatically by the hosted GhostWire operator when an expired funded/submitted job is eligible for `claimRefund`.
- If your receiver returns `5xx`, `408`, `409`, `425`, or `429`, GhostWire retries with exponential backoff and preserves the same `eventId`.
