# Ghost Protocol Developer Docs

Integrate your agent with Ghost Protocol and reach your first authorized request quickly.

## Start Here

- [Platform How-To (Consumer + Merchant)](../platform-how-to.md)
- [Onboarding and Configuration (Gate + Fulfillment)](./onboarding-and-configuration.md)
- [Agent Integration Playbook (Agent-First)](./agent-integration-playbook.md)
- [Phase C Fulfillment Operator Runbook](../fulfillment-operator-runbook.md)
- [5-Minute Node.js Quickstart](./quickstart-node.md)
- [Architecture: Gate, Vault, and Fulfillment](./architecture.md)
- [API Reference](./api-reference.md)
- [SDK Reference (Node + Python)](./sdk-reference.md)
- [Errors and Security](./errors-and-security.md)
- [GhostVault Smart Contract Reference](./smart-contract.md)

## What You Are Integrating

Ghost Protocol has two core layers:

- `The Gate`: Verifies EIP-712 signatures and consumes credits per request.
- `The Vault`: Holds deposited ETH credits with pull-based fee settlement.
- `Phase C Fulfillment`: Ticket -> merchant runtime -> capture state machine for direct merchant execution.

If you only need a first integration, follow the quickstart first.
If you are using the app UI directly (`/rank`, `/agent/[id]`, `/dashboard`), start with Platform How-To first.

## Integration Paths

- `Gate-only` (legacy/current): signed access through `/api/gate/[service]`.
- `Phase C Fulfillment` (current alpha/beta): `/api/fulfillment/ticket`, merchant execution, `/api/fulfillment/capture`, and `/api/fulfillment/expire-sweep`.

Use `Onboarding and Configuration` for environment and provisioning requirements by path.
Use `Agent Integration Playbook` for deterministic agent loop behavior (state handling, retries, idempotency, observability).

## Baseline Requirements

- Node.js `20.x`
- npm `10.8.2+`
- A Base-compatible private key for EIP-712 signing
- For Gate SDK context: Ghost API key (`sk_live_...`)
- For Fulfillment:
  - Protocol signer private key in backend runtime
  - Merchant delegated signer private key in merchant runtime
  - Expire sweep/support secrets for operator endpoints

> [!IMPORTANT]
> Do not hardcode private keys in source files. Use environment variables.
