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

For local testing, set:

```bash
GHOST_BASE_URL=http://localhost:3000
```

> [!IMPORTANT]
> `GHOST_SIGNER_PRIVATE_KEY` is required. Ghost Gate authorization uses EIP-712 signatures, not a plain API-key header.

## 3. Connect to the Gate

```ts
import { GhostAgent } from "@ghost/sdk";

const apiKey = process.env.GHOST_API_KEY!;
const privateKey = process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}`;
const baseUrl = process.env.GHOST_BASE_URL ?? "https://ghostprotocol.cc";

async function main() {
  const sdk = new GhostAgent({
    baseUrl,
    privateKey,
    chainId: 8453,     // Base
    serviceSlug: "connect",
    creditCost: 1,
  });

  const result = await sdk.connect(apiKey);

  if (!result.connected) {
    console.error("Gate rejected request:", result.status, result.payload);
    process.exit(1);
  }

  console.log("Connected:", result.endpoint);
  console.log("Remaining payload:", result.payload);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## 4. Expected success response

On success, Ghost Gate returns a payload similar to:

```json
{
  "authorized": true,
  "code": 200,
  "service": "connect",
  "signer": "0xabc123...def",
  "cost": "1",
  "remainingCredits": "99"
}
```

## 5. Verify credit availability

If your wallet has insufficient credits, response status is `402`:

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

To add credits, deposit into `GhostVault` via your merchant flow and sync credits with:

- `GET /api/sync-credits?userAddress=0x...`

## Next steps

- Read [API Reference](./api-reference.md) for header and payload details.
- Read [SDK Reference](./sdk-reference.md) for full constructor and methods.
- Read [Errors and Security](./errors-and-security.md) before production rollout.

