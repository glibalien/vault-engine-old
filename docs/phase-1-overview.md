# Phase 1: Read-Only Foundation — Overview & Order of Operations

**Goal:** Index a vault into SQLite, serve read queries via MCP.

## Dependency Graph

```
Project Scaffolding (implicit prereq)
    ├──► Markdown Parser Pipeline ──► Frontmatter Extraction ──┐
    │                              ──► Wiki-link Extraction  ──┤
    │                                                          │
    └──► SQLite Schema Creation ───────────────────────────────┤
                                                               ▼
                                                    Full Rebuild (indexer)
                                                       │        │
                                                       ▼        ▼
                                                  FTS5 Search   Incremental Indexing
                                                       │        │
                                                       │        ▼
                                                       │     File Watcher
                                                       │        │
                                                       ▼        ▼
                                                     MCP Tools (query layer)
```

## Order of Operations

### 0. Project Scaffolding

`package.json`, `tsconfig.json`, test framework (vitest), directory structure, install deps (`unified`, `remark`, `better-sqlite3`, `gray-matter`, `chokidar`, `@modelcontextprotocol/sdk`). Everything blocks on this.

### 1. Markdown Parser Pipeline + Frontmatter + Wiki-links

The optimal first real task. Reasons:

- Most foundational — nothing can be indexed without parsing
- Highest uncertainty — remark plugin composition, wiki-link edge cases, frontmatter with `types` arrays containing `[[references]]`. Better to discover surprises early.
- Testable in complete isolation with fixture `.md` files — no DB, no MCP, no watcher needed
- Frontmatter extraction and wiki-link extraction are tightly coupled to the parser (they're remark plugins or AST walkers), so they belong together as one unit of work

### 2. SQLite Schema Creation + DB Connection

The DDL from the architecture doc is well-defined. Create tables, indices, FTS5 virtual table, WAL mode setup. Low risk, fast to implement, and independently testable.

### 3. Full Rebuild (Indexer)

Where parsing meets the DB — the `file → parse → upsert` pipeline. The integration point. Build as a "scan all files, parse each, insert structured data" command. Validates that the parser output shape matches what the DB expects.

### 4. Basic FTS5 Search

Wire up FTS5 queries against indexed content. Quick win once data is in the DB, validates the indexing pipeline end-to-end.

### 5. Incremental Indexing

Add the `files` table hash/mtime tracking so only changed files get re-indexed. Refinement of the full rebuild — same parse+insert logic, gated by change detection.

### 6. File Watcher

Chokidar watching the vault directory, debounced, triggering incremental indexing. Straightforward once the indexer exists. Also needs the write-lock/hash-check loop prevention stubbed (even though writes aren't in Phase 1).

### 7. MCP Tools (`get-node`, `query-nodes`, `get-recent`, `list-schemas`)

Last. The MCP server is the delivery layer, not the logic. All the real work is in the parser + DB + indexer. MCP tools are thin wrappers around DB queries. Building them last means the entire read pipeline is testable before adding the protocol layer.

## Phase 1 Checklist

- [ ] Markdown parser pipeline (unified/remark → MDAST)
- [ ] Frontmatter extraction with `types` array support
- [ ] Wiki-link extraction (frontmatter refs + body links)
- [ ] SQLite schema creation + node/node_types/field/relationship insertion
- [ ] File watcher with debounce
- [ ] Incremental indexing (only changed files)
- [ ] Full rebuild command
- [ ] MCP tools: `get-node`, `query-nodes`, `get-recent`, `list-schemas`
- [ ] Basic FTS5 search

## Milestone

Agent can query the vault structurally: "find all nodes with types including task where status is todo" returns correct results.
