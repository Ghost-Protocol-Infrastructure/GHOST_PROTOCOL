# 5-Minute Merchant Quickstart (Node.js)

Use this when you want the shortest path to a live Ghost Protocol merchant endpoint.

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
- Node.js `20+`

If you are testing locally, put the app behind a tunnel first. `PUBLIC_BASE_URL` cannot be `localhost`.

## 2. Install

```bash
npm install express dotenv @ghostgate/sdk
```

## 3. Set environment variables

Create `.env`:

```bash
GHOST_BASE_URL=https://ghostprotocol.cc
GHOST_OWNER_PRIVATE_KEY=0xyour_owner_private_key
AGENT_ID=18755
PUBLIC_BASE_URL=https://merchant.example.com
PORT=8787
```

Ghost uses the standard agent-specific slug:

- `serviceSlug = agent-<agentId>`
- example: `agent-18755`

## 4. Create `server.mjs`

```js
import "dotenv/config";
import express from "express";
import { GhostMerchant } from "@ghostgate/sdk";

const agentId = process.env.AGENT_ID;
const serviceSlug = `agent-${agentId}`;
const port = Number(process.env.PORT ?? 8787);

const merchant = new GhostMerchant({
  baseUrl: process.env.GHOST_BASE_URL ?? "https://ghostprotocol.cc",
  serviceSlug,
  ownerPrivateKey: process.env.GHOST_OWNER_PRIVATE_KEY,
});

const app = express();
app.use(express.json());

app.get("/ghostgate/canary", merchant.canaryHandler());

app.post("/ask", async (req, res) => {
  res.json({
    ok: true,
    agentId,
    received: req.body ?? null,
    nextStep: "Replace this placeholder route with your real paid handler.",
  });
});

app.listen(port, async () => {
  console.log(`Merchant runtime listening on http://localhost:${port}`);
  console.log(`Public base URL: ${process.env.PUBLIC_BASE_URL}`);

  try {
    const result = await merchant.activate({
      agentId,
      serviceSlug,
      endpointUrl: process.env.PUBLIC_BASE_URL,
      canaryPath: "/ghostgate/canary",
    });

    console.log("GhostGate status:", result.status);
    console.log("Open the merchant console:", `https://ghostprotocol.cc/dashboard?mode=merchant&agentId=${agentId}`);
  } catch (error) {
    console.error("GhostGate activate failed:", error);
    process.exitCode = 1;
  }
});
```

## 5. Run it

```bash
node server.mjs
```

## 6. What success looks like

You should see:

- `GhostGate status: LIVE` in the server logs
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

- `ownerPrivateKey does not match indexed owner`
  - you used the wrong wallet for the selected agent
- `canary verification did not reach LIVE`
  - `PUBLIC_BASE_URL` is not publicly reachable
  - `/ghostgate/canary` does not return the exact JSON Ghost expects
- `Service mismatch`
  - `serviceSlug` must be `agent-<agentId>`

When you need full rail selection, pricing policy, offerings behavior, or settlement details, use [Onboarding and Configuration](./onboarding-and-configuration.md) as the canonical guide.
