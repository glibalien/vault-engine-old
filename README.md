# vault-engine

A local-first, MCP-native knowledge graph engine that indexes markdown vaults into SQLite for structured querying. Markdown files are canonical — the database is a derived, rebuildable index. The agent (via MCP tools) is the primary interface; editors are viewports.

## Design Principles

- **Markdown is canonical.** Every piece of structural data — types, fields, relationships — lives in frontmatter and wiki-links. The database is always rebuildable from files. If the DB is deleted, nothing is lost.
- **Every meaningful entity gets its own file.** Tasks, projects, people, meetings — each is a separate `.md` file with its own frontmatter. Focused, linkable, independently valid.
- **Editor-agnostic.** Does not depend on any specific editor or plugin. Any editor that opens `.md` files works — Obsidian, Typora, VS Code, iA Writer, or plain `vim`.
- **The agent is the primary interface.** Creating nodes, querying, managing tasks, organizing knowledge — all agent-driven via MCP tools. The editor is a viewport for reading and writing prose, not the control surface.
- **Multi-typed, composable nodes.** Any node can have multiple types via `types: [meeting, task]` in frontmatter. Types are additive — they contribute fields and behaviors without constraining identity. Schema inheritance (`extends`) is resolved at the schema level.
- **Relationships are wiki-links.** `[[wiki-links]]` in frontmatter fields become typed relationships; in body they become contextual links. The engine indexes these but does not invent relationships that aren't in the markdown.
- **Incremental by default.** Every operation — indexing, querying, syncing — handles single-file changes without full rebuilds. File watching with per-file debounce keeps the index fresh.
- **Runs on cheap models.** Tool interfaces are explicit, well-documented, and low-ambiguity. Required fields clearly marked, enum values explicit, structured JSON responses. A capable open model should be able to use every tool correctly.
- **Schema-aware with configurable enforcement.** Schemas guide the agent and enable queries. By default, the engine warns on violations — it doesn't reject. Per-type enforcement policies can optionally tighten this (strip unknown fields, reject invalid enums, auto-normalize on index).

## Technology Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (ESM) |
| Database | SQLite via `better-sqlite3` (WAL mode, FTS5) |
| Vector Store | `sqlite-vec` |
| File Watching | `chokidar` |
| Markdown Parser | `unified` + `remark` + custom wiki-link plugin |
| Frontmatter | `gray-matter` |
| MCP Server | `@modelcontextprotocol/sdk` |
| Schema | YAML definitions with inheritance |

## Getting Started

### Prerequisites

- Node.js >= 20

### Install

```bash
npm install
npm run build
```

### Run

```bash
# Point at your markdown vault (stdio transport, default)
node dist/index.js /path/to/vault/.vault-engine/vault.db /path/to/vault

# Or use defaults (creates .vault-engine/vault.db in cwd)
node dist/index.js

# HTTP transport (requires OAUTH_OWNER_PASSWORD and OAUTH_ISSUER_URL in .env)
node dist/index.js --transport http --port 3333

# Both stdio and HTTP simultaneously
node dist/index.js --transport both --port 3333
```

The server indexes the vault on startup (incremental — fast on subsequent runs) and watches for file changes.

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js /path/to/vault/.vault-engine/vault.db /path/to/vault
```

### Add to Claude Code

```
/mcp add vault-engine node /path/to/vault-engine/dist/index.js /path/to/vault/.vault-engine/vault.db /path/to/vault
```

## MCP Tools

### Query Tools

| Tool | Description |
|------|-------------|
| `list-types` | List all node types with counts |
| `get-node` | Get full node details by ID or title, with optional relationships and computed fields |
| `query-nodes` | Structured search with type, full-text (FTS5), field filters (8 operators), reference filtering, path prefix, since date, ordering |
| `semantic-search` | Vector similarity search (requires embedding config) |
| `traverse-graph` | N-hop BFS graph traversal with direction/type/depth controls |
| `find-duplicates` | Detect nodes with similar/identical titles via Levenshtein distance |

### Schema Tools

| Tool | Description |
|------|-------------|
| `list-schemas` | List schema definitions with summaries |
| `describe-schema` | Get full resolved schema with inherited fields and enforcement policies |
| `validate-node` | Validate a node or hypothetical node against schemas |
| `infer-schemas` | Analyze vault data to infer schema definitions (report, merge, or overwrite modes) |
| `update-schema` | Surgically modify schema definitions: add/remove/rename/update fields, set metadata |
| `normalize-fields` | Normalize frontmatter field names and values across the vault to match schemas |

### Mutation Tools

| Tool | Description |
|------|-------------|
| `create-node` | Create a new markdown file with frontmatter and optional relationships |
| `update-node` | Update fields/body/title/types of a node, or bulk-update via query |
| `delete-node` | Delete a node and clean up references |
| `add-relationship` | Add a wiki-link reference between nodes |
| `remove-relationship` | Remove a wiki-link reference between nodes |
| `rename-node` | Rename a node and update all incoming references across the vault |
| `batch-mutate` | Atomic batch of create/update/delete/link/unlink operations |

### Workflow Tools

| Tool | Description |
|------|-------------|
| `daily-summary` | Dashboard: overdue tasks, due today/this week, recent activity |
| `project-status` | Project details with task breakdown, completion %, overdue tasks |
| `create-meeting-notes` | Create meeting node and auto-resolve/create attendee nodes |
| `extract-tasks` | Create task nodes from a source node with back-references |

### Content Tools

| Tool | Description |
|------|-------------|
| `read-embedded` | Read `![[embed]]` attachments: images as base64, audio transcribed via Whisper, documents as text |
| `summarize-node` | Assemble a node and all its embedded content for summarization |

## Project Structure

```
src/
├── index.ts           # Entry point: DB, indexing, MCP server, transport selection
├── parser/            # Markdown → ParsedFile pipeline (remark + wiki-link plugin + frontmatter)
├── db/                # SQLite connection + schema DDL
├── sync/              # File-to-DB indexing (rebuild, incremental, file watcher, reference resolution)
├── search/            # FTS5 full-text search
├── schema/            # YAML schema loader, inheritance, field merging, validation, computed fields
├── serializer/        # Structured data → markdown string, file path generation, frontmatter patching
├── coercion/          # Write-path input coercion (type coercion, alias resolution, global fields)
├── enforcement/       # Per-type enforcement policies (normalize-on-index, unknown fields, enum validation)
├── graph/             # BFS graph traversal
├── embeddings/        # Vector embeddings (chunker, providers, sqlite-vec, background worker)
├── inference/         # Schema inference from vault data (analyzer, generator)
├── attachments/       # Embed resolution and content extraction (images, audio, documents)
├── mcp/               # MCP server + 25 tool handlers
├── transport/         # CLI arg parsing, HTTP transport (Express + OAuth 2.1)
├── auth/              # OAuth 2.1 provider for HTTP transport
└── utils/             # Shared utilities
```

## Schemas

Schema definitions live in `.schemas/*.yaml` in the vault root. They support inheritance (`extends`), field definitions with types and constraints, and serialization templates.

```yaml
# .schemas/task.yaml
name: task
display_name: Task
icon: check
fields:
  status:
    type: enum
    values: [todo, in-progress, done]
    required: true
  due_date:
    type: date
  assignee:
    type: reference
    target_schema: person
serialization:
  filename_template: "tasks/{{title}}.md"
```

## Development

```bash
npm test              # run all tests (vitest)
npm run test:watch    # run tests in watch mode
npm run dev           # run with tsx watch (hot reload)
npm run bench         # run performance benchmarks
npx tsc --noEmit      # type-check without emitting
```

## Architecture

See [`vault-engine-architecture.md`](vault-engine-architecture.md) for the full architecture document and [`docs/`](docs/) for phase overviews and design plans.

## License

MIT
