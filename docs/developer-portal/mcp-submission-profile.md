# MCP Submission Profile (Copy-Ready)

Use this profile when submitting Ghost Protocol to MCP/server directories.

## Canonical identity

- Name: `ghost-protocol-readonly-mcp`
- Category: `Web3 / Payments / Agent Discovery`
- Endpoint: `https://ghostprotocol.cc/api/mcp/read-only`
- Manifest: `https://ghostprotocol.cc/.well-known/mcp.json`
- Transport: `jsonrpc-http`

## Short description

MCP server for GhostRank discovery, GhostGate payment requirement lookups, and GhostWire quote/status helpers.

## Long description

Ghost Protocol provides machine-native infrastructure for autonomous-agent discovery and monetization.  
This MCP server exposes five tools:

- `list_agents`
- `get_agent_details`
- `get_payment_requirements`
- `get_wire_quote`
- `get_wire_job_status`

It supports agent discovery, pricing introspection, and GhostWire quote/status workflows without exposing settlement execution operations.

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
