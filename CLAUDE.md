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
npm run start:http    # start with HTTP transport on port 3333
node dist/index.js --transport http --port 3333  # HTTP only (requires OAUTH_OWNER_PASSWORD and OAUTH_ISSUER_URL in .env)
node dist/index.js --transport both --port 3333  # stdio + HTTP simultaneously
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

### Serializer (`src/serializer/`)

Reverse of the parser — converts structured data back to markdown files.

- **`frontmatter.ts`** — Serializes frontmatter fields back to YAML + body markdown.
- **`path.ts`** — Path generation and sanitization for new node files.
- **`node-to-file.ts`** — Converts node data to complete markdown file content.
- **`writer.ts`** — File write operations with write-lock integration.
- **`patch.ts`** — `patchFrontmatter(fileContent, mutations)` — surgical regex-based frontmatter patching. Applies `rename_key` and `coerce_value` mutations to raw YAML without re-serializing the whole file. Body preserved byte-for-byte.
- **`index.ts`** — Re-exports serializer functions.

### Key Design Decisions

- **Markdown is canonical.** DB is always rebuildable from files. Structure lives in frontmatter + wiki-links.
- **Multi-typed nodes.** Files declare `types: [meeting, task]` in frontmatter. Types are additive.
- **Wiki-links are relationships.** `[[target]]` and `[[target|alias]]` in frontmatter fields become typed relationships; in body they become contextual links.
- **`title` and `types` are meta-keys** excluded from `fields` array — they're handled separately.
- **gray-matter auto-converts dates** to `Date` objects. `inferType` checks `instanceof Date`.
- **`Position` type** comes from `unist`, not `mdast`.

### Coercion Layer (`src/coercion/`)

Write-path input coercion engine. Normalizes caller-provided field values to match schema definitions before serialization. Runs between tool handler and validator in `create-node`, `update-node`, and `batch-mutate`.

- **`types.ts`** — `CoercionChange`, `CoercionResult`, `CoercionIssue`, `CoercionPolicies`, `GlobalFieldDefinition`, `GlobalFieldsConfig`, `UnknownFieldPolicy` types.
- **`coerce.ts`** — `coerceFields(fields, mergeResult, globalFields?, policies?)` applies coercion rules: scalar→list wrapping, reference wrapping (`"Alice"` → `"[[Alice]]"`), boolean coercion (`"true"` → `true`), number coercion (`"42"` → `42`), case-insensitive enum matching (`"TODO"` → `"todo"`). Resolves field type via fallback chain: per-type schema → global field definition → no coercion. Returns coerced fields + change log + issues array. Accepts `CoercionPolicies` object with `unknownFields` (`warn`/`strip`/`reject`) and `enumValidation` (`coerce`/`warn`/`reject`) policies. Backward-compatible: also accepts legacy string for `unknownFields`. Multi-type conflict handling: fields that appear in `mergeResult.conflicts` (incompatible type definitions across schemas) are recognized as schema-defined and pass through unvalidated with a `type_conflict` warning — never treated as unknown.
- **`aliases.ts`** — `resolveAliases(fields, knownFieldNames)` maps field name variations to canonical names: case-insensitive match, camelCase→snake_case, snake_case→space-separated. Runs before value coercion.
- **`globals.ts`** — `loadGlobalFields(vaultPath)` reads `.schemas/_global.yaml` for cross-type field definitions. Returns `Record<string, GlobalFieldDefinition>`. Expands `canonical_name` entries.
- **`index.ts`** — Re-exports all types and functions.

### Enforcement Layer (`src/enforcement/`)

Per-type enforcement configuration. Reads `.vault-engine/enforcement.yaml` to determine how strictly each schema type enforces field constraints. Loaded once at server startup alongside global fields.

- **`types.ts`** — `EnforcementConfig` (mirrors YAML shape), `ResolvedPolicies` (flat resolved object), policy types: `NormalizeOnIndexPolicy` (`off`/`warn`/`fix`), `UnknownFieldsPolicy` (`warn`/`strip`/`reject`), `EnumValidationPolicy` (`coerce`/`warn`/`reject`).
- **`loader.ts`** — `loadEnforcementConfig(vaultPath)` reads YAML, validates policy values, fills defaults. `resolveEnforcementPolicies(config, types)` resolves per-type overrides for a node's type set using "most restrictive wins" for multi-type nodes.
- **`index.ts`** — Re-exports all types and functions.

**Config file format** (`.vault-engine/enforcement.yaml`):
```yaml
enforcement:
  normalize_on_index:
    default: warn       # off | warn | fix
    per_type:
      task: fix
  unknown_fields:
    default: warn       # warn | strip | reject
    per_type:
      task: reject
  enum_validation:
    default: coerce     # coerce | warn | reject
    per_type:
      task: reject
```

Absent file → all defaults (`warn`/`warn`/`coerce`). Invalid values silently fall back to defaults. Multi-type nodes get the strictest policy across all their types.

### DB Layer (`src/db/`)

Database connection and schema management.

- **`connection.ts`** — `openDatabase(dbPath)` factory. Configures WAL mode, foreign keys, busy timeout. Creates parent directories for file-based DBs.
- **`schema.ts`** — `createSchema(db)` runs idempotent DDL: 7 tables (nodes, node_types, nodes_fts, fields, relationships, schemas, files), 9 indices, 3 FTS5 sync triggers. No migration tracking — DB is rebuildable. `nodes` table uses `file_mtime` (last disk modification time) and `indexed_at` (when the engine last indexed the node) rather than a generic `updated_at`.
- **`index.ts`** — Re-exports `openDatabase` and `createSchema`.

### Sync Layer (`src/sync/`)

File-to-database indexing pipeline.

- **`indexer.ts`** — `indexFile(db, parsed, relativePath, mtime, raw)` writes one parsed file into all DB tables (nodes, node_types, fields, relationships, files). Uses delete-then-insert for child tables. Does not manage transactions. `deleteFile(db, relativePath)` removes all DB rows for a file path (relationships, fields, node_types, nodes, files). `rebuildIndex(db, vaultPath)` scans all `.md` files, clears the DB, and indexes everything in one transaction. `incrementalIndex(db, vaultPath)` scans files, compares mtime then SHA-256 hash against the `files` table, only re-indexes changed/new files, and removes DB entries for deleted files. Returns `{ indexed, skipped, deleted }`.
- **`watcher.ts`** — `watchVault(db, vaultPath, opts?)` creates a chokidar watcher on the vault directory. Returns `{ close(), ready }`. Watches only `.md` files with `ignoreInitial: true`. Per-file debounce (default 300ms) prevents double-indexing on rapid saves. `add`/`change` events trigger `parseFile` + `indexFile`; `unlink` triggers `deleteFile`. Write lock functions (`acquireWriteLock`/`releaseWriteLock`/`isWriteLocked`) allow Phase 3 serializer to prevent re-indexing of engine-written files. Global write lock functions (`acquireGlobalWriteLock`/`releaseGlobalWriteLock`/`isGlobalWriteLocked`) suppress ALL watcher events during bulk operations like normalize-fields. Per-file locks remain for single-file write tools.
- **`reconciler.ts`** — `reconcileOnce(db, vaultPath)` runs `incrementalIndex` on demand. `startReconciler(db, vaultPath, opts?)` runs it periodically (30s first tick, 5m interval). Safety net for dropped chokidar events. Shares indexing logic with the watcher — same `incrementalIndex` under the hood.
- **`index.ts`** — Re-exports `indexFile`, `rebuildIndex`, `deleteFile`, `incrementalIndex`, `watchVault`, `acquireWriteLock`, `releaseWriteLock`, `isWriteLocked`.

### Search Layer (`src/search/`)

Full-text search over indexed content.

- **`types.ts`** — `SearchOptions` (query, schemaType, limit) and `SearchResult` (id, filePath, nodeType, types, fields, contentText, rank).
- **`search.ts`** — `search(db, options)` queries FTS5 with optional type filtering. Two-phase SQL: FTS5 MATCH for ranked node IDs, then batch-loads types and fields. Returns `SearchResult[]` ordered by bm25 rank.
- **`index.ts`** — Re-exports `search`, `SearchOptions`, `SearchResult`.

### MCP Layer (`src/mcp/`)

MCP server exposing query, mutation, and workflow tools over the indexed vault.

- **`server.ts`** — `createServer(db, vaultPath)` creates an `McpServer` with 25 tools registered. Returns the server instance (caller connects transport). Contains `hydrateNodes` (batch-loads types + fields), `loadNodeForValidation` (reconstructs `FieldEntry[]` from DB), `inferFieldType` (JS value → `FieldValueType`), and `toolError` (structured error response) helpers.
  - **`list-types`** — No params. Returns distinct types from `node_types` with counts.
  - **`get-node`** — Returns full node details by ID (vault-relative path) or title. Optional `title` param for wiki-link-style lookup when directory is unknown. Optional `include_relationships` and `include_computed` flags.
  - **`query-nodes`** — Structured search with optional `schema_type`, `full_text` (FTS5), field `filters` (8 operators: eq, neq, gt, lt, gte, lte, contains, in), `references` (relationship-based filtering by target/direction/rel_type), `path_prefix` (folder scoping), `since` (indexed_at filter — nodes the engine indexed after a given time), `modified_since` (file_mtime filter — files modified on disk after a given time), `order_by`, and `limit`. Reference-aware field filtering (strips `[[]]` brackets for eq/neq/contains/in). SQL construction extracted to `query-builder.ts`.
  - **`list-schemas`** — No params. Returns schema summaries (name, display_name, icon, extends, ancestors, field_count) from the `schemas` table. Distinct from `list-types` (indexed data vs YAML definitions).
  - **`describe-schema`** — Returns full `ResolvedSchema` by name, including inherited fields.
  - **`validate-node`** — Two modes: by `node_id` (loads from DB) or hypothetical (`types: string[]` + `fields`). Runs `mergeSchemaFields` + `validateNode` pipeline.
  - **`create-node`** — Creates a new markdown file with frontmatter. Validates schemas, generates path, writes file, indexes.
  - **`update-node`** — Updates fields/body/title/types of existing node. Single-node mode (`node_id`) or bulk query mode (`query` with schema_type/filters). Bulk mode restricted to field-only updates (body, append_body, title, types forbidden). Optional `dry_run` in query mode. Merge semantics for fields, replace/append for body.
  - **`delete-node`** — Deletes a single node by ID. Removes file from disk, cascades DB rows, runs `resolveReferences` to clear stale pointers.
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
  - **`read-embedded`** — Reads `![[embed]]` attachments from a node. Resolves embed paths (Attachments/ → root → sibling → recursive search), then reads by type: images as base64 MCP image blocks, audio transcribed via Fireworks Whisper API (OpenAI SDK), documents via pdf-parse/mammoth/fs. Returns array of content blocks with summary. Requires `FIREWORKS_API_KEY` env var for audio only.
  - **`summarize-node`** — Content assembly tool. Reads a node and all its `![[embedded]]` attachments, returning everything as MCP content blocks. Accepts `node_id` or `title` (resolved via wiki-link logic). Returns: metadata header, node body as-is, then each embed's extracted content (audio transcripts, images as base64, documents as text) with `## Type: filename` headers. Missing embeds get `⚠️` warnings. The calling model handles summarization.
  - **`normalize-fields`** — Normalizes frontmatter field names and value shapes across the vault to match schema definitions. Two modes: `audit` (report what would change) and `apply` (execute). Optional `schema_type` filter and explicit `rules` param; when rules omitted, auto-infers from schema definitions. Apply mode uses global write lock, file rollback on failure, and re-indexes after patching.
  - **`find-duplicates`** — Detects nodes with similar/identical titles. Levenshtein distance with bucketing for performance. Optional `schema_type` filter, `threshold` (0.0–1.0), `limit`, and `include_fields` (Jaccard similarity on field overlap, weighted 0.7 title + 0.3 fields).
  - **`update-schema`** — Direct, surgical modifications to `.schemas/*.yaml` schema definitions. Five operations: `add_field`, `remove_field`, `rename_field`, `update_field` (merge semantics), `set_metadata` (display_name, icon, extends, serialization). Multiple operations per call, applied sequentially to an in-memory copy. Validates before write (field types, enum values, extends chain). Rollback on `loadSchemas` failure. Creates new schemas if name doesn't exist. Warns when overriding inherited fields. Reloads schemas into DB immediately after write. Does not touch vault files — use `normalize-fields` to propagate changes.
- **`update-schema.ts`** — Core `updateSchema(db, vaultPath, schemaName, operations)` function. Reads raw YAML from disk (not resolved DB schema), applies operations, validates, writes via `stringifyYaml(schema, { lineWidth: 0 })`, reloads via `loadSchemas`. File snapshot/rollback pattern for reload failures.
- **`query-builder.ts`** — Extracted SQL construction for `query-nodes`. `buildQuerySql(opts)` handles FTS, type filter, field filters (reference-aware), references JOIN, since, path_prefix, order_by. Reused by `update-node` bulk mode.
- **`duplicates.ts`** — `findDuplicates(db, opts)` implements title similarity (exact + Levenshtein) with optional field overlap refinement.
- **`resolve.ts`** — `resolveById(db, nodeId)` and `resolveByTitle(db, title)` with three-tier normalization: exact → NFC → typographic. Returns `ResolveResult` with `matchType` tracking. `normalizeTypographic(str)` maps smart quotes, em-dashes, ellipsis, NBSP to ASCII equivalents. Used by all tool handlers for node lookup.
- **`workflow-tools.ts`** — Handlers for workflow tools (daily-summary, project-status, create-meeting-notes, extract-tasks). Contains `computeProjectTaskStats` shared helper.

### Attachments Layer (`src/attachments/`)

Embed resolution and content extraction for `![[file]]` attachments.

- **`types.ts`** — `AttachmentType` enum (image/audio/document/unknown), `ResolvedEmbed`, `ReadResult`, `ImageContent`, `TextContent` interfaces. `classifyAttachment(filename)` and `getMimeType(filename)` helpers.
- **`resolver.ts`** — `parseEmbeds(raw)` extracts `![[filename]]` from markdown via regex (not AST — remark-wiki-link doesn't handle `!` prefix). `resolveEmbedPath(filename, vaultPath, sourceDir)` tries Attachments/ → vault root → source dir → recursive search (skips .git, node_modules, .vault-engine). Path traversal protection ensures resolved paths stay inside vault. `resolveEmbeds(raw, vaultPath, sourceDir, filterType?)` combines parsing + resolution.
- **`readers.ts`** — `readImage(path, filename)` returns base64 image block (SVG as text). `readAudio(path, filename)` calls Fireworks Whisper via OpenAI SDK with diarization, formats speaker-labeled transcript. `readDocument(path, filename)` handles PDF (pdf-parse), DOCX (mammoth), TXT/MD (fs). All return `ReadResult` with per-file error handling.
- **`index.ts`** — Re-exports all types and functions.

### Inference Layer (`src/inference/`)

Schema inference from indexed vault data.

- **`types.ts`** — `InferredField`, `TypeAnalysis`, `Discrepancy`, `InferenceResult`, `InferenceMode`.
- **`analyzer.ts`** — `inferFieldType(rows)` infers `SchemaFieldType` per field with priority-ordered type detection (reference > date > number > boolean > list > string-ref > enum > string). `analyzeVault(db, types?)` queries `fields` + `node_types` tables, computes frequencies, detects discrepancies against existing schemas, identifies shared fields across types.
- **`generator.ts`** — `generateSchemas(analysis, mode, existingSchemas)` produces `SchemaDefinition[]` based on mode. `writeSchemaFiles(schemas, vaultPath)` serializes to `.schemas/*.yaml`. Merge mode preserves existing fields/properties and unions enum values. Overwrite mode produces clean schemas from data.
- **`index.ts`** — Re-exports all types and functions.

### Auth Layer (`src/auth/`)

OAuth 2.1 authentication for the HTTP transport, implementing the MCP auth spec.

- **`schema.ts`** — DDL for 3 auth tables (`oauth_clients`, `oauth_codes`, `oauth_tokens`). Created via `createAuthSchema(db)`, idempotent.
- **`store.ts`** — `SqliteClientsStore` implements `OAuthRegisteredClientsStore`. Stores client metadata as JSON blob. Client secrets stored plaintext (SDK constraint).
- **`provider.ts`** — `VaultOAuthProvider` implements `OAuthServerProvider`. Password-gated `/authorize` with HTML form. Opaque tokens via `crypto.randomBytes`, stored as SHA-256 hashes. Access tokens: 1hr, refresh tokens: 30 days with rotation.
- **`env.ts`** — `validateAuthEnv()` validates `OAUTH_OWNER_PASSWORD` and `OAUTH_ISSUER_URL` at startup. HTTPS required (HTTP allowed for localhost only).
- **`index.ts`** — Re-exports.

### Transport Layer (`src/transport/`)

CLI argument parsing and HTTP transport setup.

- **`args.ts`** — `parseArgs(argv)` extracts `--transport` (stdio|http|both, default stdio) and `--port` (default 3333) flags plus positional dbPath/vaultPath.
- **`http.ts`** — `createHttpApp(serverFactory)` creates an Express app with POST/GET/DELETE/HEAD `/mcp` routes. Per-session `StreamableHTTPServerTransport` instances stored in a `Map`. New `McpServer` created per session via factory (MCP SDK constraint: one transport per server). HEAD and sessionless GET return `MCP-Protocol-Version: 2025-03-26` for protocol discovery. `startHttpTransport(serverFactory, port)` calls `createHttpApp` and starts listening. Returns `{ app, httpServer }`. Logs to stderr. Auth integration: when `authConfig` provided, installs `mcpAuthRouter()` (OAuth endpoints) and `requireBearerAuth()` (protects `/mcp`). HEAD and sessionless GET remain unauthenticated for protocol discovery.
- **`index.ts`** — Re-exports `createHttpApp`, `startHttpTransport`, `parseArgs`.

### Entry Point (`src/index.ts`)

Loads `dotenv/config` first (reads `.env` for `FIREWORKS_API_KEY` etc.), then opens DB (path from CLI arg or default `.vault-engine/vault.db`), creates schema, loads schemas, runs `incrementalIndex` to populate/refresh the DB on startup, then starts transport(s) based on `--transport` flag. Default is stdio. HTTP mode validates `OAUTH_OWNER_PASSWORD` and `OAUTH_ISSUER_URL` env vars, creates auth schema, and passes auth config to `startHttpTransport`. Both mode runs stdio and HTTP simultaneously. Embedding config loaded from `.vault-engine/config.json` if present. A `.env.example` template is provided; `.env` is gitignored.

### Schema Layer (`src/schema/`)

YAML-driven schema definitions with inheritance, multi-type field merging, and validation.

- **`types.ts`** — `SchemaDefinition`, `FieldDefinition`, `ResolvedSchema`, `MergedField`, `MergeConflict`, `MergeResult`, `ValidationWarning`, `ValidationResult`.
- **`loader.ts`** — `loadSchemas(db, vaultPath)` reads `.schemas/*.yaml` (skips files starting with `_`, e.g. `_global.yaml`), resolves `extends` inheritance (topological sort, cycle detection), stores in `schemas` table. `getSchema(db, name)` and `getAllSchemas(db)` read back.
- **`merger.ts`** — `mergeSchemaFields(db, types)` merges field definitions from multiple schemas. Compatible fields merge; incompatible types produce conflicts. Enum values union.
- **`validator.ts`** — `validateNode(parsed, mergeResult)` checks required fields, type compatibility, enum values, reference syntax. Warns, never rejects.
- **`index.ts`** — Re-exports all types and functions.

## Gotchas

- **Zod records** require two arguments: `z.record(z.string(), z.unknown())`, not `z.record(z.unknown())`.

## Testing

Tests use vitest. Test files live in `tests/` mirroring `src/` structure. Fixtures are in `tests/fixtures/` (sample markdown files with frontmatter). Tests run against fixture files using `readFileSync` with `import.meta.dirname` for path resolution.
