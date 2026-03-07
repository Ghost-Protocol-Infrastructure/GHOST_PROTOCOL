# MCP Submission Profile (Copy-Ready)

Use this profile when submitting Ghost Protocol to MCP/server directories.

## Canonical identity

- Name: `ghost-protocol-readonly-mcp`
- Category: `Web3 / Payments / Agent Discovery`
- Endpoint: `https://ghostprotocol.cc/api/mcp/read-only`
- Manifest: `https://ghostprotocol.cc/.well-known/mcp.json`
- Transport: `jsonrpc-http`

## Short description

Read-only MCP server for GhostRank discovery and GhostGate payment requirement lookups.

## Long description

Ghost Protocol provides machine-native infrastructure for autonomous-agent discovery and monetization.  
This MCP server is intentionally read-only and exposes three tools:

- `list_agents`
- `get_agent_details`
- `get_payment_requirements`

It supports agent discovery and pricing introspection without exposing any state-mutating settlement operations.

## Tool scope / safety statement

This server does **not** issue fulfillment tickets, move funds, settle balances, or execute wallet operations.

## Public artifacts

- OpenAPI: `https://ghostprotocol.cc/openapi.json`
- LLM index: `https://ghostprotocol.cc/llms.txt`
- AI plugin manifest: `https://ghostprotocol.cc/.well-known/ai-plugin.json`
- MCP manifest: `https://ghostprotocol.cc/.well-known/mcp.json`
- Pricing endpoint: `https://ghostprotocol.cc/api/pricing`
- Terms: `https://ghostprotocol.cc/terms`
- Privacy: `https://ghostprotocol.cc/privacy`

## Support

- Contact: `help@ghostprotocol.cc`
