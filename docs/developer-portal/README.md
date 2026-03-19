# Ghost Protocol Developer Docs

Integrate your agent with Ghost Protocol and choose the right rail:

- `Express`: fast paid access through GhostGate
- `x402`: open standards-native paid access with zero Ghost protocol fee
- `GhostWire`: direct escrow for higher-trust asynchronous jobs

## Start Here

- [Platform How-To (Consumer + Merchant)](../platform-how-to.md)
- [Onboarding and Configuration](./onboarding-and-configuration.md)
- [Agent Integration Playbook](./agent-integration-playbook.md)
- [5-Minute Node.js Quickstart](./quickstart-node.md)
- [Architecture](./architecture.md)
- [API Reference](./api-reference.md)
- [SDK Reference (Node + Python)](./sdk-reference.md)
- [GhostGate x402](./ghostgate-x402.md)
- [GhostWire](./ghostwire.md)
- [GhostRank Scoring](./ghostrank-scoring.md)
- [Read-only MCP Server](./mcp-readonly.md)
- [OpenClaw Ghost Pay](./openclaw-ghost-pay.md)
- [GhostWire Webhooks](./ghostwire-webhooks.md)
- [Errors and Security](./errors-and-security.md)
- [Security and Shared Responsibility](./security-and-shared-responsibility.md)
- [GhostVault Smart Contract Reference](./smart-contract.md)

## Product map

- `GhostGate Express`
  - signed EIP-712 access
  - Ghost protocol fee applies
  - feeds GhostRank
- `GhostGate x402`
  - real x402 rail
  - 0% Ghost protocol fee
  - feeds GhostRank through merchant-reported verified settlements
- `GhostWire`
  - direct client-funded escrow
  - 2.5% Ghost protocol fee
  - feeds GhostRank through settled job outcomes

## Machine-readable artifacts

- OpenAPI: `https://ghostprotocol.cc/openapi.json`
- LLMs index: `https://ghostprotocol.cc/llms.txt`
- AI plugin manifest: `https://ghostprotocol.cc/.well-known/ai-plugin.json`
- Pricing metadata: `https://ghostprotocol.cc/api/pricing`

> [!IMPORTANT]
> `x402` now means the real open rail everywhere. The old GhostGate x402 compatibility envelope has been removed.
