# vault-engine

A local-first, MCP-native knowledge graph engine that indexes markdown vaults into SQLite for structured querying. Markdown files are canonical — the database is a derived, rebuildable index. The agent (via MCP tools) is the primary interface; editors are viewports.

## Design Principles

- **Markdown is canonical.** Every piece of structural data — types, fields, relationships — lives in frontmatter and wiki-links. The database is always rebuildable from files. If the DB is deleted, nothing is lost.
- **Every meaningful entity gets its own file.** Tasks, projects, people, meetings — each is a separate `.md` file with its own frontmatter.
- **Editor-agnostic.** Works with Obsidian, Typora, VS Code, iA Writer, or anything that reads markdown.
- **The agent is the primary interface.** Creating nodes, querying, managing tasks, organizing knowledge — all agent-driven via MCP tools.
- **Multi-typed, composable nodes.** Any node can have multiple types via `types: [meeting, task]` in frontmatter. Types are additive.
- **Relationships are wiki-links.** `[[wiki-links]]` in frontmatter fields become typed relationships; in body they become contextual links.
- **Schema-aware, not schema-enforced.** Schemas guide the agent and enable queries, but files that violate schema are still valid markdown. The engine warns; it doesn't reject.

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
# Point at your markdown vault
node dist/index.js /path/to/vault/.vault-engine/vault.db /path/to/vault

# Or use defaults (creates .vault-engine/vault.db in cwd)
node dist/index.js
```

The server indexes the vault on startup (incremental — fast on subsequent runs) and connects via MCP stdio transport.

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
| `get-node` | Get full node details by ID, with optional relationships and computed fields |
| `get-recent` | Get recently updated nodes, with optional type and date filters |
| `query-nodes` | Structured search with type, full-text, field filters (8 operators), ordering |
| `list-schemas` | List schema definitions with summaries |
| `describe-schema` | Get full resolved schema with inherited fields |
| `validate-node` | Validate a node or hypothetical node against schemas |
| `search` | Full-text search via FTS5 |
| `semantic-search` | Vector similarity search (requires embedding config) |
| `traverse-graph` | N-hop BFS graph traversal with direction/type/depth controls |

### Mutation Tools

| Tool | Description |
|------|-------------|
| `create-node` | Create a new markdown file with frontmatter and optional relationships |
| `update-node` | Update fields and/or body of an existing node |
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

## Project Structure

```
src/
├── index.ts           # Entry point: DB, indexing, MCP server over stdio
├── parser/            # Markdown → ParsedFile pipeline (remark + wiki-link plugin + frontmatter)
├── db/                # SQLite connection + schema DDL
├── sync/              # File-to-DB indexing (rebuild, incremental, file watcher)
├── search/            # FTS5 full-text search
├── schema/            # YAML schema loader, multi-type field merging, validation
├── serializer/        # ParsedFile → markdown string, file path generation
├── graph/             # BFS graph traversal
├── embeddings/        # Vector embeddings (chunker, providers, sqlite-vec, background worker)
├── mcp/               # MCP server + tool handlers
└── utils/             # Shared utilities
```

## Schemas

Schema definitions live in `.schemas/*.yaml` in the vault root. They support inheritance (`extends`), field definitions with types and constraints, and serialization templates.

```yaml
# .schemas/task.yaml
name: task
display_name: Task
icon: checkbox
fields:
  status:
    type: string
    required: true
    enum: [todo, in-progress, done]
  due_date:
    type: date
  assignee:
    type: reference
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
