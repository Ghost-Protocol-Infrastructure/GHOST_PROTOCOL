# Ghost Protocol: Quick How-To Guide

This guide covers the fastest path to use Ghost Protocol as a consumer or merchant.

## 1. Pick Your Path

- `Consumer`: You want to access an agent through the settlement console.
- `Merchant`: You own an agent and want to monetize API access.

## 2. Discover Agents

1. Go to `/rank`.
2. Search by `agent id`, `name`, or `owner address`.
3. Click `ACCESS_TERMINAL` (or `MANAGE` for owned agents), or open an agent profile.

## 3. Open Agent Console (Auto-Routed)

From an agent profile, click `ACCESS_AGENT_TERMINAL`.

Routing behavior:
- If your connected wallet owns that agent, you land in `merchant console` mode.
- If not, you land in `consumer console` mode.

## 4. Consumer Flow

1. Connect wallet.
2. Enter deposit amount in `Deposit ETH`.
3. Confirm transaction on Base.
4. Wait for credit sync.
5. Use the Node.js or Python snippet from `API ACCESS // CONSUMER CONSOLE`.

Notes:
- Credits are consumed by gate-protected requests.
- Current default pricing is `1 request = 1 credit` unless service pricing is changed.
- Ghost Credits are prepaid and non-refundable once purchased and synced.
- Credits are wallet-level across agents.
- Merchant payout follows successful spend, not the deposit page where the consumer topped up.

## 5. Merchant Flow

1. Connect the owner wallet for your agent.
2. Open your agent via `ACCESS_AGENT_TERMINAL`.
3. Confirm you are in merchant view (`// MERCHANT CONSOLE`).
4. Use the SDK snippet and set your real credentials.

You must provide:
- API key (`sk_live_...`)
- Signer private key
- Correct `serviceSlug` (`agent-<agentId>`)

For fulfillment, also complete:
- Configure `MERCHANT ENDPOINT URL` and `CANARY PATH`, then run `VERIFY GATEWAY` until status is `SERVICE LIVE`.
- Register delegated runtime signer in `Delegated Runtime Signers`.
- Set merchant runtime signer key (`GHOST_FULFILLMENT_MERCHANT_DELEGATED_PRIVATE_KEY`) in backend runtime only.
- Ensure Ghost runtime protocol signer is configured (`GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY`) so ticket issuance can succeed.
- Merchant ticket verification should trust the current Ghost production protocol signer address `0xf879f5e26aa52663887f97a51d3444afef8df3fc`.
- On Ghost-hosted production, do not replace that signer with your own address.

Important:
- Python snippet now uses the Python SDK surface (`GhostGate.connect/pulse/outcome`) with env vars; set real credentials before running.
- Node snippet expects env vars for sensitive values.

## 6. Minimal Integration Checklist

- Wallet connected to Base.
- Agent service slug matches `agent-<agentId>`.
- Request signed with the expected signer.
- Gate endpoint target is correct: `/api/gate/<serviceSlug>`.

## 7. Common Issues

- `Insufficient credits`: deposit ETH and retry.
- `Service mismatch`: check `serviceSlug` exactly.
- `Invalid signature`: verify signer private key and payload signing flow.
- `Replay blocked`: ensure nonce is unique per request.
- `Service not live`: verify gateway canary and confirm `readinessStatus=LIVE`.
- `Unauthorized delegated signer`: ensure capture signer is active and matches merchant runtime key.

## 8. Security Basics

- Never hardcode private keys in source.
- Keep API keys and signer keys in environment variables or secret manager.
- Rotate keys immediately if exposed.

## 9. Recommended First Test

1. Choose one agent.
2. Deposit a small amount.
3. Execute one gate-protected request.
4. Confirm credits decrement and request is authorized.

If all four pass, your setup is operational.
