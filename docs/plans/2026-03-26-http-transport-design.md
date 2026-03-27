# HTTP Transport Design

## Overview

Add Streamable HTTP transport as an alternative to stdio, enabling remote MCP clients (claude.ai via Tailscale Funnel, Fireworks Response API, Obsidian chat plugin) to connect to vault-engine over HTTP. The transport is a generic HTTP endpoint with no provider-specific logic. Auth is out of scope — it will be layered in later.

## Consumers

- **claude.ai** — via Tailscale Funnel (remote access to local server)
- **Fireworks Response API** — remote LLM provider calling MCP tools over HTTP
- **Obsidian chat plugin** — local HTTP connection from the plugin

All use standard MCP Streamable HTTP protocol. No consumer-specific logic in the transport layer.

## CLI Interface

New flags parsed from `process.argv` in `src/index.ts`:

- `--transport <stdio|http|both>` — default: `stdio`
- `--port <number>` — default: `3333`, only relevant when transport includes HTTP

Positional args for `dbPath` and `vaultPath` remain unchanged. The flag parser skips positional args.

Examples:
```bash
# Default — stdio only (current behavior, Claude Code)
node dist/index.js

# HTTP only
node dist/index.js --transport http --port 3333

# Both stdio and HTTP simultaneously
node dist/index.js --transport both --port 4000

# With custom DB path + HTTP
node dist/index.js ./my-vault/.vault-engine/vault.db ./my-vault --transport http
```

## Architecture

### Module Structure

New `src/transport/` module:

- **`src/transport/http.ts`** — Exports `startHttpTransport(server: McpServer, port: number): Promise<Express>`. Sets up Express, session management, routing, and logging.
- **`src/transport/index.ts`** — Re-exports `startHttpTransport`.

### Relationship Between Server and Transports

One `McpServer` instance (from `createServer()`) shared across all transports and sessions. Each HTTP session gets its own `StreamableHTTPServerTransport` instance. `server.connect(transport)` is called per session. All sessions share the same DB, watcher, and write lock state.

In `both` mode, the stdio transport and all HTTP session transports coexist on the same `McpServer`.

### HTTP Transport (`src/transport/http.ts`)

Express app with three routes on `/mcp`:

**`POST /mcp`** — Main request handler.
- If the request has no `mcp-session-id` header: assume initialization. Create a new `StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`, call `server.connect(transport)`, wire `onsessioninitialized` to store in sessions map, delegate request to the new transport.
- If the request has an `mcp-session-id` header: look up transport from sessions map, delegate. Return 404 if session not found.

**`GET /mcp`** — SSE stream for server-initiated messages.
- Requires valid `mcp-session-id` header. Delegates to session transport's `handleRequest`.

**`DELETE /mcp`** — Session cleanup.
- Calls `transport.close()`, removes from sessions map.

**Middleware:**
- `express.json()` for body parsing
- Request logging to stderr: `[vault-engine] POST /mcp 200 12ms`

**Startup banner** to stderr: `[vault-engine] HTTP listening on http://localhost:3333/mcp`

### Session Lifecycle

- **Sessions map:** `Map<string, StreamableHTTPServerTransport>` keyed by session ID.
- **Creation:** On initialize request, new transport created and connected to server.
- **Routing:** `mcp-session-id` header used to look up transport. Unknown ID → 404.
- **Cleanup:** `DELETE /mcp` or `transport.onclose` callback removes from map.
- **No TTL/expiry for now** — sessions live until explicitly closed or server shutdown. TTL-based cleanup can be added later.

### Changes to `src/index.ts`

1. Add flag parsing at top (after imports, before DB setup) — extract `--transport` and `--port`.
2. After `createServer()`, branch on transport mode:
   - `stdio` → current behavior (`StdioServerTransport` + `server.connect`)
   - `http` → call `startHttpTransport(server, port)`
   - `both` → do both
3. DB setup, schema loading, indexing, and embedding worker are untouched.

## Dependencies

- **New runtime:** `express`
- **New dev:** `@types/express`, `supertest`, `@types/supertest`
- **Already available:** `@modelcontextprotocol/sdk` (has `StreamableHTTPServerTransport`), `node:crypto` (has `randomUUID`)

## Testing

### Unit Tests (`tests/transport/http.test.ts`)

Using `supertest` against the Express app returned by `startHttpTransport`:

- Initialize request creates a session (returns `mcp-session-id` header)
- Subsequent requests with valid session ID are routed correctly
- Unknown session ID returns 404
- `DELETE /mcp` cleans up the session
- Request logging output (capture stderr)

### Integration Test

Spin up HTTP transport, use the MCP SDK's `StreamableHTTPClientTransport` to connect and call a tool (e.g., `list-types`), verify the response round-trips correctly.

### No Changes to Existing Tests

The stdio path is unchanged. All existing tests continue to work as-is.

## Logging

All logging goes to stderr (not stdout) to avoid corrupting the stdio MCP stream in `both` mode.

- **Startup:** `[vault-engine] HTTP listening on http://localhost:<port>/mcp`
- **Per-request:** `[vault-engine] <METHOD> /mcp <STATUS> <DURATION>ms`
- **Errors:** `[vault-engine] HTTP error: <message>`

## Future Work (Out of Scope)

- **Authentication** — will be layered on as Express middleware later
- **Session TTL/expiry** — cleanup of stale sessions
- **CORS configuration** — add when cross-origin consumers need it
- **TLS** — handled externally (Tailscale Funnel, reverse proxy)
