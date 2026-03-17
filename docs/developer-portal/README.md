# Ghost Protocol Developer Docs

Integrate your agent with Ghost Protocol and reach your first authorized request quickly.

## Start Here

- [Platform How-To (Consumer + Merchant)](../platform-how-to.md)
- [Onboarding and Configuration (Gate + Fulfillment)](./onboarding-and-configuration.md)
- [Agent Integration Playbook (Agent-First)](./agent-integration-playbook.md)
- [Fulfillment Operator Runbook](../fulfillment-operator-runbook.md)
- [5-Minute Node.js Quickstart](./quickstart-node.md)
- [Architecture: Gate, Vault, and Fulfillment](./architecture.md)
- [API Reference](./api-reference.md)
- [SDK Reference (Node + Python)](./sdk-reference.md)
- [GhostWire](./ghostwire.md)
- [GhostGate x402 Compatibility](./ghostgate-x402.md)
- [GhostGate x402 Public Demo Client](./ghostgate-x402-public-demo-client.md)
- [GhostGate x402 Demo Spec](./ghostgate-x402-demo-spec.md)
- [Read-only MCP Server](./mcp-readonly.md)
- [GhostRank Scoring](./ghostrank-scoring.md)
- [MCP Directory Submissions](./mcp-directory-submissions.md)
- [MCP Submission Profile](./mcp-submission-profile.md)
- [OpenClaw Ghost Pay](./openclaw-ghost-pay.md)
- [GhostWire Webhooks](./ghostwire-webhooks.md)
- [Benchmarking and Claims](./benchmarking-and-claims.md)
- [Errors and Security](./errors-and-security.md)
- [Security and Shared Responsibility](./security-and-shared-responsibility.md)
- [GhostVault Smart Contract Reference](./smart-contract.md)

## What You Are Integrating

Ghost Protocol has two core layers:

- `The Gate`: Verifies EIP-712 signatures and consumes credits per request.
- `The Vault`: Holds deposited ETH credits with pull-based fee settlement.
- `Fulfillment`: Ticket -> merchant runtime -> capture state machine for direct merchant execution.
- `GhostWire`: Direct ERC-8183 escrow for higher-value jobs where the external client wallet funds the job on-chain.

If you only need a first integration, follow the quickstart first.
If you are using the app UI directly (`/rank`, `/agent/[id]`, `/dashboard`), start with Platform How-To first.

## Integration Paths

- `Gate-only` (legacy/current): signed access through `/api/gate/[service]`.
- `GhostGate x402` (optional compatibility mode): x402-style `402` / `payment-required` / `payment-response` transport on `/api/gate/[service]` while Ghost EIP-712 credits remain the underlying rail.
- `Fulfillment`: `/api/fulfillment/ticket`, merchant execution, `/api/fulfillment/capture`, and `/api/fulfillment/expire-sweep`.
- `GhostWire`: `/api/wire/quote`, `/api/wire/jobs`, `/api/wire/jobs/[jobId]/artifacts`, direct client funding, and deliverable resolution through merchant-managed `metadataUri` locators.

Use `Onboarding and Configuration` for environment and provisioning requirements by path.
Use `Agent Integration Playbook` for deterministic agent loop behavior (state handling, retries, idempotency, observability).

## Machine-readable artifacts

- OpenAPI: `https://ghostprotocol.cc/openapi.json`
- LLMs index: `https://ghostprotocol.cc/llms.txt`
- AI plugin manifest: `https://ghostprotocol.cc/.well-known/ai-plugin.json`
- Pricing metadata: `https://ghostprotocol.cc/api/pricing`

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
