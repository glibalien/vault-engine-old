# MCP Tools (Phase 1 Read-Only) — Design

## Overview

Four read-only MCP tools that serve as thin wrappers around DB queries. The MCP server is the delivery layer; all real logic lives in the parser + DB + indexer built in Tasks 1–6.

## Decisions

- **Single file:** `src/mcp/server.ts` — 4 tools don't warrant a multi-file split. Refactor when more tools arrive.
- **Transport:** stdio only. SSE deferred.
- **Direct SQL:** Tool handlers query the DB directly. No abstraction layer. Shared helper for node hydration.
- **`list-types` instead of `list-schemas`:** Phase 1 has no YAML schema loader. Query `node_types` for discovered types + counts instead of the empty `schemas` table.
- **`query-nodes` filter subset:** `eq` operator only for field filters. Comparison operators (`gt`, `lt`, `contains`, `in`) deferred. `order_by` included (trivial SQL).
- **No `include_children`:** Sub-file block indexing doesn't exist in Phase 1.

## Server Setup

`src/mcp/server.ts` exports `createServer(db: Database.Database): McpServer`:
- Creates `McpServer` with name `"vault-engine"`, version `"0.1.0"`
- Registers all 4 tools
- Returns the `McpServer` instance (caller handles transport)

`src/index.ts` entry point:
- Opens database (CLI arg or default `.vault-engine/vault.db`)
- Creates schema
- Creates MCP server with db
- Connects `StdioServerTransport`

Server does not manage watcher or indexing. Vault assumed to be already indexed.

## Tool Definitions

### `get-node`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `node_id` | string | yes | — | Vault-relative file path |
| `include_relationships` | boolean | no | false | Include incoming/outgoing relationships |

**Response:** `{ id, file_path, node_type, types[], fields{}, content_text, content_md, updated_at }` plus optional `relationships[]` with `{ source_id, target_id, rel_type, context }`.

**Error:** "Node not found: {id}" if nonexistent.

### `query-nodes`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schema_type` | string | no | — | Filter by type in `node_types` |
| `full_text` | string | no | — | FTS5 search query |
| `filters` | array | no | — | Each: `{ field, operator: "eq", value }` |
| `limit` | number | no | 20 | Max results |
| `order_by` | string | no | `updated_at DESC` | Field name + optional ` ASC`/` DESC` |

At least one of `schema_type`, `full_text`, or `filters` required.

**Response:** Array of node objects (same as `get-node` but without `content_md`). Ordered by FTS5 rank when `full_text` provided, otherwise by `order_by`.

### `get-recent`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schema_type` | string | no | — | Filter by type |
| `since` | string | no | — | ISO date, nodes updated after this |
| `limit` | number | no | 20 | Max results |

**Response:** Array of node objects ordered by `updated_at DESC`.

### `list-types`

No parameters.

**Response:** Array of `{ name, count }` — distinct types from `node_types` with node counts.

## SQL Query Patterns

### Shared helper: node hydration

`loadNodeDetails(db, nodeIds)` batch-loads types and fields for a set of node IDs. Used by `get-node`, `query-nodes`, and `get-recent`. ~20 lines, lives in `server.ts`.

### `query-nodes` dynamic SQL

1. **FTS path** (when `full_text` provided): `nodes_fts` JOIN `nodes`, ordered by `fts.rank`
2. **Non-FTS path**: Start from `nodes` table directly
3. **Type filter**: `JOIN node_types nt ON nt.node_id = n.id WHERE nt.schema_type = ?`
4. **Field equality**: One `JOIN fields` per filter — `f.key = ? AND f.value_text = ?`
5. **Order by**: Field name → join `fields` and sort by `value_text`/`value_number`/`value_date`. `updated_at` → sort on `nodes.updated_at`.

All parameters are bound, never interpolated.

### `get-recent` SQL

`SELECT FROM nodes ORDER BY updated_at DESC` with optional type join and `WHERE updated_at > ?`.

## Error Handling & Response Format

### Errors

Return `{ content: [{ type: "text", text: "Error: ..." }], isError: true }` for:
- Nonexistent node ID
- Empty query (no filters)
- Invalid `order_by` direction
- FTS5 syntax errors

### Response format

`{ content: [{ type: "text", text: JSON.stringify(result) }] }` with snake_case keys.

Fields flattened to `key: value_text` (not `{ value, type }` shape). Simpler for agent consumption.

## Testing

`tests/mcp/server.test.ts` — create in-memory DB, populate with `createSchema` + `indexFile`, call tool handlers directly (no transport).

Cases:
- Each tool's happy path
- `get-node` with missing node
- `query-nodes` with each filter type and combinations
- `query-nodes` with `order_by`
- `get-recent` with and without `since`
- `list-types` with populated and empty DB
- Error cases (empty query, bad node ID)
