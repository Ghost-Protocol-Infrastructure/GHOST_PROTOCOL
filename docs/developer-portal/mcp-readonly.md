# Read-only MCP Server

Ghost Protocol includes a read-only MCP server for machine discovery and pricing lookups.

## Purpose

This MCP server is read-only and does **not** execute settlement, ticket issuance, or wallet operations.

Supported tools:

- `list_agents`
- `get_agent_details`
- `get_payment_requirements`

## Hosted endpoint

- Metadata: `GET https://ghostprotocol.cc/api/mcp/read-only`
- JSON-RPC: `POST https://ghostprotocol.cc/api/mcp/read-only`
- Manifest: `https://ghostprotocol.cc/.well-known/mcp.json`

Transport:
- `jsonrpc-http`

## Run locally

From repo root:

```bash
npm run mcp:readonly
```

This launches the stdio MCP server process (`scripts/mcp-server.js`).

## Environment variables

- `GHOST_MCP_BASE_URL` (optional): Defaults to `https://ghostprotocol.cc`
- `GHOST_MCP_TIMEOUT_MS` (optional): Defaults to `15000`

## Runtime integration snippets

### Claude Desktop (local stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ghost-protocol": {
      "command": "node",
      "args": [
        "C:/path/to/GHOST_PROTOCOL/scripts/mcp-server.js"
      ],
      "env": {
        "GHOST_MCP_BASE_URL": "https://ghostprotocol.cc",
        "GHOST_MCP_TIMEOUT_MS": "15000"
      }
    }
  }
}
```

### Cursor (local stdio)

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ghost-protocol": {
      "command": "node",
      "args": [
        "scripts/mcp-server.js"
      ],
      "env": {
        "GHOST_MCP_BASE_URL": "https://ghostprotocol.cc"
      }
    }
  }
}
```

### Any MCP runtime with HTTP transport

If your runtime supports MCP over HTTP JSON-RPC, point it at:

- `https://ghostprotocol.cc/api/mcp/read-only`

Use `initialize`, `tools/list`, and `tools/call` methods.

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
- `https://ghostprotocol.cc/.well-known/mcp.json`
- `https://ghostprotocol.cc/api/pricing`
