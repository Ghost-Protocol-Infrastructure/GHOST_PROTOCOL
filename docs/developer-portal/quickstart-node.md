# 5-Minute Integration (Node.js)

Use this guide to send your first authorized request through Ghost Gate.

## 1. Install

```bash
npm install @ghost/sdk
```

## 2. Configure environment variables

Create `.env.local`:

```bash
GHOST_API_KEY=sk_live_your_api_key
GHOST_SIGNER_PRIVATE_KEY=0xyour_private_key
GHOST_BASE_URL=https://ghostprotocol.cc
```

For local testing:

```bash
GHOST_BASE_URL=http://localhost:3000
```

> [!IMPORTANT]
> `GHOST_SIGNER_PRIVATE_KEY` is required. Gate authorization is EIP-712 signature-based.

## 3. Choose your service slug

Use your agent-specific slug:

- Format: `agent-<agentId>`
- Example: `agent-2212`

## 4. Connect to the Gate

```ts
import { GhostAgent } from "@ghost/sdk";

const apiKey = process.env.GHOST_API_KEY!;
const privateKey = process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`;
const baseUrl = process.env.GHOST_BASE_URL ?? "https://ghostprotocol.cc";

async function main() {
  const sdk = new GhostAgent({
    baseUrl,
    privateKey,
    chainId: 8453, // Base
    serviceSlug: "agent-2212",
    creditCost: 1,
  });

  const result = await sdk.connect(apiKey);

  if (!result.connected) {
    console.error("Gate rejected request:", result.status, result.payload);
    process.exit(1);
  }

  console.log("Connected:", result.endpoint);
  console.log("Payload:", result.payload);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## 5. Expected success response

`200` response body includes fields similar to:

```json
{
  "authorized": true,
  "code": 200,
  "service": "agent-2212",
  "signer": "0xabc123...def",
  "cost": "1",
  "remainingCredits": "99",
  "nonceAccepted": true,
  "requestId": "agent-2212:0xabc...:nonce",
  "costSource": "default"
}
```

`receipt` may be present if receipt signing is configured.

## 6. Verify credit availability

If wallet credits are insufficient, response status is `402`:

```json
{
  "error": "Payment Required",
  "code": 402,
  "details": {
    "balance": "0",
    "required": "1"
  }
}
```

To add credits, deposit via app merchant/consumer flow and sync credits with:

- `GET /api/sync-credits?userAddress=0x...`

## 7. Replay-safe behavior

If the same nonce is reused, Gate can return `409`:

```json
{
  "error": "Replay Detected",
  "code": 409
}
```

Always sign a fresh payload with a new nonce.

## Next steps

- Read [API Reference](./api-reference.md) for endpoint details.
- Read [SDK Reference](./sdk-reference.md) for constructor and methods.
- Read [Errors and Security](./errors-and-security.md) before production rollout.
