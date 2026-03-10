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
| Smithery | LISTED | https://smithery.ai/servers/ghostprotocol/readonly-mcp |
| MCP.so | SUBMIT | Requires signed-in web submission (auth-gated). |
| mcpservers.org | SUBMIT | Submitted 2026-03-10; pending review email. |
| Cursor directory (if/when open) | SUBMIT | Use same packet above. |

Copy-ready listing profile:

- `docs/developer-portal/mcp-submission-profile.md`

## Verification checklist before each submission

1. `GET /api/mcp/read-only` returns `ok: true` and expected tool list.
2. `POST /api/mcp/read-only` with `tools/list` returns 200 and tool schema.
3. `/.well-known/mcp.json` resolves and matches live endpoint URL.
4. `openapi.json` and `llms.txt` are reachable from production.

## Automated monitoring

Workflow:

- `.github/workflows/mcp-readonly-monitor.yml`

Schedule:

- Twice per hour (`:17` and `:47`, UTC)

It verifies:

1. `GET /api/mcp/read-only`
2. `GET /.well-known/mcp.json`
3. MCP JSON-RPC `initialize`
4. MCP JSON-RPC `tools/list`
5. MCP JSON-RPC `tools/call` for:
   - `list_agents`
   - `get_payment_requirements`
