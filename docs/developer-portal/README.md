# Ghost Protocol Developer Docs

Integrate your agent with Ghost Protocol and reach your first authorized request quickly.

## Start Here

- [Platform How-To (Consumer + Merchant)](../platform-how-to.md)
- [5-Minute Node.js Quickstart](./quickstart-node.md)
- [Architecture: Gate vs Vault](./architecture.md)
- [API Reference](./api-reference.md)
- [SDK Reference (Node + Python)](./sdk-reference.md)
- [Errors and Security](./errors-and-security.md)
- [GhostVault Smart Contract Reference](./smart-contract.md)

## What You Are Integrating

Ghost Protocol has two core layers:

- `The Gate`: Verifies EIP-712 signatures and consumes credits per request.
- `The Vault`: Holds deposited ETH credits with pull-based fee settlement.

If you only need a first integration, follow the quickstart first.
If you are using the app UI directly (`/rank`, `/agent/[id]`, `/dashboard`), start with Platform How-To first.

## Requirements

- Node.js `20.x`
- npm `10.8.2+`
- A Base-compatible private key (for EIP-712 signing)
- A Ghost API key (used by SDK context and telemetry helpers)

> [!IMPORTANT]
> Do not hardcode private keys in source files. Use environment variables.
