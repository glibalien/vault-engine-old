# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

vault-engine is a local-first, MCP-native knowledge graph engine that indexes markdown vaults into SQLite for structured querying. Markdown files are canonical — the database is a derived, rebuildable index. The agent (via MCP tools) is the primary interface; editors are viewports.

See `vault-engine-architecture.md` for the full architecture, `docs/phase-1-overview.md` for current implementation status, and `vault-engine-enhancements.md` for the post-Phase 6 roadmap.

## Commands

```bash
npm test              # run all tests (vitest)
npm run test:watch    # run tests in watch mode
npx vitest run tests/parser/wiki-links.test.ts  # run a single test file
npm run build         # compile TypeScript (tsc)
npx tsc --noEmit      # type-check without emitting
npm run dev           # run with tsx watch (hot reload)
```

## Architecture

**ESM TypeScript project** — `"type": "module"` with Node16 module resolution. All internal imports use `.js` extensions (e.g., `import { foo } from './bar.js'`).

### Parser Pipeline (`src/parser/`)

The core data flow: raw `.md` file → `ParsedFile` object.

```
parseFile(filePath, raw)
  ├── parseMarkdown(raw)         → MDAST with wikiLink nodes (unified/remark + remarkFrontmatter + remarkWikiLink)
  ├── parseFrontmatter(raw)      → { data, content, types, fields, wikiLinks }  (gray-matter + regex)
  ├── extractWikiLinksFromMdast() → body wiki-links from wikiLink AST nodes
  └── extractPlainText()         → plain text for FTS (reads wikiLink node target/alias)
```

- **`types.ts`** — Shared interfaces: `ParsedFile`, `WikiLink`, `WikiLinkNode`, `FieldEntry`. Module augmentation registers `WikiLinkNode` as mdast phrasing content.
- **`remark-wiki-link.ts`** — Custom remark transform plugin. Splits `[[target]]` and `[[target|alias]]` in text nodes into first-class `wikiLink` AST nodes. Runs after remarkParse + remarkFrontmatter.
- **`markdown.ts`** — unified pipeline (remarkParse + remarkFrontmatter + remarkWikiLink). `parseMarkdown` calls `runSync` to execute transforms. `extractPlainText` handles `wikiLink` nodes directly.
- **`frontmatter.ts`** — gray-matter wrapper. Infers field types (reference/list/date/number/boolean/string). Extracts wiki-links from frontmatter YAML values via regex.
- **`wiki-links.ts`** — `extractWikiLinksFromMdast` walks `wikiLink` AST nodes (not regex on text). `extractWikiLinksFromString` provides regex extraction for frontmatter values.
- **`index.ts`** — `parseFile()` orchestrator, re-exports types.

### Key Design Decisions

- **Markdown is canonical.** DB is always rebuildable from files. Structure lives in frontmatter + wiki-links.
- **Multi-typed nodes.** Files declare `types: [meeting, task]` in frontmatter. Types are additive.
- **Wiki-links are relationships.** `[[target]]` and `[[target|alias]]` in frontmatter fields become typed relationships; in body they become contextual links.
- **`title` and `types` are meta-keys** excluded from `fields` array — they're handled separately.
- **gray-matter auto-converts dates** to `Date` objects. `inferType` checks `instanceof Date`.
- **`Position` type** comes from `unist`, not `mdast`.

### DB Layer (`src/db/`)

Database connection and schema management.

- **`connection.ts`** — `openDatabase(dbPath)` factory. Configures WAL mode, foreign keys, busy timeout. Creates parent directories for file-based DBs.
- **`schema.ts`** — `createSchema(db)` runs idempotent DDL: 7 tables (nodes, node_types, nodes_fts, fields, relationships, schemas, files), 9 indices, 3 FTS5 sync triggers. No migration tracking — DB is rebuildable.
- **`index.ts`** — Re-exports `openDatabase` and `createSchema`.

### Sync Layer (`src/sync/`)

File-to-database indexing pipeline.

- **`indexer.ts`** — `indexFile(db, parsed, relativePath, mtime, raw)` writes one parsed file into all DB tables (nodes, node_types, fields, relationships, files). Uses delete-then-insert for child tables. Does not manage transactions. `deleteFile(db, relativePath)` removes all DB rows for a file path (relationships, fields, node_types, nodes, files). `rebuildIndex(db, vaultPath)` scans all `.md` files, clears the DB, and indexes everything in one transaction. `incrementalIndex(db, vaultPath)` scans files, compares mtime then SHA-256 hash against the `files` table, only re-indexes changed/new files, and removes DB entries for deleted files. Returns `{ indexed, skipped, deleted }`.
- **`watcher.ts`** — `watchVault(db, vaultPath, opts?)` creates a chokidar watcher on the vault directory. Returns `{ close(), ready }`. Watches only `.md` files with `ignoreInitial: true`. Per-file debounce (default 300ms) prevents double-indexing on rapid saves. `add`/`change` events trigger `parseFile` + `indexFile`; `unlink` triggers `deleteFile`. Write lock functions (`acquireWriteLock`/`releaseWriteLock`/`isWriteLocked`) allow Phase 3 serializer to prevent re-indexing of engine-written files.
- **`index.ts`** — Re-exports `indexFile`, `rebuildIndex`, `deleteFile`, `incrementalIndex`, `watchVault`, `acquireWriteLock`, `releaseWriteLock`, `isWriteLocked`.

### Search Layer (`src/search/`)

Full-text search over indexed content.

- **`types.ts`** — `SearchOptions` (query, schemaType, limit) and `SearchResult` (id, filePath, nodeType, types, fields, contentText, rank).
- **`search.ts`** — `search(db, options)` queries FTS5 with optional type filtering. Two-phase SQL: FTS5 MATCH for ranked node IDs, then batch-loads types and fields. Returns `SearchResult[]` ordered by bm25 rank.
- **`index.ts`** — Re-exports `search`, `SearchOptions`, `SearchResult`.

### MCP Layer (`src/mcp/`)

MCP server exposing query, mutation, and workflow tools over the indexed vault.

- **`server.ts`** — `createServer(db, vaultPath)` creates an `McpServer` with 20 tools registered. Returns the server instance (caller connects transport). Contains `hydrateNodes` (batch-loads types + fields), `loadNodeForValidation` (reconstructs `FieldEntry[]` from DB), `inferFieldType` (JS value → `FieldValueType`), and `toolError` (structured error response) helpers.
  - **`list-types`** — No params. Returns distinct types from `node_types` with counts.
  - **`get-node`** — Returns full node details by ID (vault-relative path). Optional `include_relationships` and `include_computed` flags.
  - **`get-recent`** — Returns nodes ordered by `updated_at DESC`. Optional `schema_type` and `since` filters.
  - **`query-nodes`** — Structured search with optional `schema_type`, `full_text` (FTS5), field `filters` (8 operators: eq, neq, gt, lt, gte, lte, contains, in), `order_by`, and `limit`. Dynamic SQL construction with bound parameters.
  - **`list-schemas`** — No params. Returns schema summaries (name, display_name, icon, extends, ancestors, field_count) from the `schemas` table. Distinct from `list-types` (indexed data vs YAML definitions).
  - **`describe-schema`** — Returns full `ResolvedSchema` by name, including inherited fields.
  - **`validate-node`** — Two modes: by `node_id` (loads from DB) or hypothetical (`types: string[]` + `fields`). Runs `mergeSchemaFields` + `validateNode` pipeline.
  - **`create-node`** — Creates a new markdown file with frontmatter. Validates schemas, generates path, writes file, indexes.
  - **`update-node`** — Updates fields/body of existing node. Merge semantics for fields, replace/append for body.
  - **`add-relationship`** — Adds wiki-link reference between nodes (field or body).
  - **`remove-relationship`** — Removes wiki-link reference between nodes.
  - **`rename-node`** — Renames a node and updates all incoming references across the vault.
  - **`batch-mutate`** — Atomic batch of create/update/delete/link/unlink operations with filesystem rollback.
  - **`semantic-search`** — Vector similarity search using embeddings (requires embedding config).
  - **`traverse-graph`** — N-hop BFS graph traversal with direction/type/depth controls.
  - **`daily-summary`** — Dashboard: overdue tasks, due today/this week, recent activity, active project stats.
  - **`project-status`** — Full project details with task breakdown by status, completion %, overdue tasks.
  - **`create-meeting-notes`** — Creates meeting node, auto-resolves/creates attendee nodes via batch-mutate.
  - **`extract-tasks`** — Creates task nodes from a source node with back-references via batch-mutate.
  - **`infer-schemas`** — Analyzes indexed vault data to infer schema definitions. Reports field types, frequencies, enum candidates, discrepancies against existing schemas, and shared fields across types. Three modes: report (analysis only), merge (expand existing schemas with inferred data), overwrite (replace schemas entirely).
- **`workflow-tools.ts`** — Handlers for workflow tools (daily-summary, project-status, create-meeting-notes, extract-tasks). Contains `computeProjectTaskStats` shared helper.

### Inference Layer (`src/inference/`)

Schema inference from indexed vault data.

- **`types.ts`** — `InferredField`, `TypeAnalysis`, `Discrepancy`, `InferenceResult`, `InferenceMode`.
- **`analyzer.ts`** — `inferFieldType(rows)` infers `SchemaFieldType` per field with priority-ordered type detection (reference > date > number > boolean > list > string-ref > enum > string). `analyzeVault(db, types?)` queries `fields` + `node_types` tables, computes frequencies, detects discrepancies against existing schemas, identifies shared fields across types.
- **`generator.ts`** — `generateSchemas(analysis, mode, existingSchemas)` produces `SchemaDefinition[]` based on mode. `writeSchemaFiles(schemas, vaultPath)` serializes to `.schemas/*.yaml`. Merge mode preserves existing fields/properties and unions enum values. Overwrite mode produces clean schemas from data.
- **`index.ts`** — Re-exports all types and functions.

### Entry Point (`src/index.ts`)

Opens DB (path from CLI arg or default `.vault-engine/vault.db`), creates schema, loads schemas, runs `incrementalIndex` to populate/refresh the DB on startup, then starts MCP server over stdio transport. Embedding config loaded from `.vault-engine/config.json` if present.

### Schema Layer (`src/schema/`)

YAML-driven schema definitions with inheritance, multi-type field merging, and validation.

- **`types.ts`** — `SchemaDefinition`, `FieldDefinition`, `ResolvedSchema`, `MergedField`, `MergeConflict`, `MergeResult`, `ValidationWarning`, `ValidationResult`.
- **`loader.ts`** — `loadSchemas(db, vaultPath)` reads `.schemas/*.yaml`, resolves `extends` inheritance (topological sort, cycle detection), stores in `schemas` table. `getSchema(db, name)` and `getAllSchemas(db)` read back.
- **`merger.ts`** — `mergeSchemaFields(db, types)` merges field definitions from multiple schemas. Compatible fields merge; incompatible types produce conflicts. Enum values union.
- **`validator.ts`** — `validateNode(parsed, mergeResult)` checks required fields, type compatibility, enum values, reference syntax. Warns, never rejects.
- **`index.ts`** — Re-exports all types and functions.

## Gotchas

- **Zod records** require two arguments: `z.record(z.string(), z.unknown())`, not `z.record(z.unknown())`.

## Testing

Tests use vitest. Test files live in `tests/` mirroring `src/` structure. Fixtures are in `tests/fixtures/` (sample markdown files with frontmatter). Tests run against fixture files using `readFileSync` with `import.meta.dirname` for path resolution.
