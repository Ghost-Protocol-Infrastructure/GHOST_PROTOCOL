# MCP Directory Submissions

This page tracks Ghost Protocol MCP listing readiness for agent/tool directories.

## Submission packet (canonical)

Use these URLs in every directory submission:

- MCP endpoint: `https://ghostprotocol.cc/api/mcp/read-only`
- MCP metadata: `https://ghostprotocol.cc/api/mcp/read-only` (`GET`)
- MCP manifest: `https://ghostprotocol.cc/.well-known/mcp.json`
- OpenAPI: `https://ghostprotocol.cc/openapi.json`
- LLM index: `https://ghostprotocol.cc/llms.txt`
- AI plugin manifest: `https://ghostprotocol.cc/.well-known/ai-plugin.json`
- Pricing endpoint: `https://ghostprotocol.cc/api/pricing`
- Terms: `https://ghostprotocol.cc/terms`
- Privacy: `https://ghostprotocol.cc/privacy`

Tool list:

- `list_agents`
- `get_agent_details`
- `get_payment_requirements`

Scope statement:

- "Read-only MCP server for agent discovery and pricing requirements. No settlement, ticket issuance, wallet actions, or state mutation."

## Directory targets

Status meanings:
- `READY`: packet complete and endpoint live.
- `SUBMIT`: requires manual external listing submission.
- `LISTED`: public listing confirmed.

| Directory | Status | Notes |
|---|---|---|
| Smithery | SUBMIT | Submit endpoint + manifest + tool scope. |
| MCP.so | SUBMIT | Submit server profile and canonical endpoint. |
| mcpservers.org | SUBMIT | Submit public metadata and capability summary. |
| Cursor directory (if/when open) | SUBMIT | Use same packet above. |

## Verification checklist before each submission

1. `GET /api/mcp/read-only` returns `ok: true` and expected tool list.
2. `POST /api/mcp/read-only` with `tools/list` returns 200 and tool schema.
3. `/.well-known/mcp.json` resolves and matches live endpoint URL.
4. `openapi.json` and `llms.txt` are reachable from production.
