# Read-only MCP Server

Ghost Protocol includes a read-only MCP server for machine discovery and pricing lookups.

## Purpose

This MCP server is read-only and does **not** execute settlement, ticket issuance, or wallet operations.

Supported tools:

- `list_agents`
- `get_agent_details`
- `get_payment_requirements`

## Run locally

From repo root:

```bash
npm run mcp:readonly
```

## Environment variables

- `GHOST_MCP_BASE_URL` (optional): Defaults to `https://ghostprotocol.cc`
- `GHOST_MCP_TIMEOUT_MS` (optional): Defaults to `15000`

## Tool contracts

### `list_agents`

Input:

```json
{
  "query": "optional search term",
  "limit": 20,
  "page": 1
}
```

Data source: `GET /api/agents`

### `get_agent_details`

Input:

```json
{
  "agent_id": "18755"
}
```

Data source: `GET /api/agents?q=<agent_id>`

### `get_payment_requirements`

Input:

```json
{
  "service_slug": "agent-18755"
}
```

Data source: `GET /api/pricing?service=<service_slug>`

Returns chain id, credit unit pricing, request credit cost, and x402 transport compatibility metadata.

## Related machine-readable artifacts

- `https://ghostprotocol.cc/openapi.json`
- `https://ghostprotocol.cc/llms.txt`
- `https://ghostprotocol.cc/.well-known/ai-plugin.json`
- `https://ghostprotocol.cc/api/pricing`
