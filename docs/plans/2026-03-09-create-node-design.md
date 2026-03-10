# `create-node` MCP Tool — Design (Phase 3 Task 3)

## Overview

First mutation tool in the write path. Validates fields, serializes to markdown, writes to disk, indexes into the DB, and returns the created node with validation warnings.

## Tool Parameters

```typescript
server.tool('create-node', {
  title: z.string(),
  types: z.array(z.string()).optional().default([]),
  fields: z.record(z.string(), z.unknown()).optional().default({}),
  body: z.string().optional(),
  parent_path: z.string().optional(),
  relationships: z.array(z.object({
    target: z.string(),   // "Bob" or "[[Bob]]"
    rel_type: z.string(), // schema field name for frontmatter, "wiki-link" for body
  })).optional().default([]),
})
```

- `title` — required. Every node needs one.
- `types` — defaults to `[]`. Schema-less nodes are valid (no validation, still produces well-formed markdown).
- `fields` — defaults to `{}`. Processed first.
- `body` — optional body content.
- `parent_path` — overrides schema `filename_template`. File lands at `<parent_path>/<sanitized_title>.md`.
- `relationships` — optional. Processed after fields, merging on top.

## Pipeline

`createNode(params)` helper function inside the `createServer` closure:

1. **Validate** — If any types have schemas, run `mergeSchemaFields(db, types)` + `validateNode`. Collect warnings; never reject.
2. **Process relationships** — For each relationship:
   - Normalize target to `[[target]]` if not already wrapped.
   - If `rel_type` matches a schema field (from merge result in step 1): set value for scalar fields, append for list fields. For schema-less nodes, fall back to checking if existing field value is an array.
   - Otherwise: append `[[target]]` to body.
3. **Compute field order** — `computeFieldOrder(types, db)` for schema-driven frontmatter ordering.
4. **Serialize** — `serializeNode({ title, types, fields, body, fieldOrder })` → complete markdown string.
5. **Generate path** — If `parent_path` provided: `<parent_path>/<sanitized_title>.md` (same sanitization as `generateFilePath`). Otherwise: `generateFilePath(title, types, fields, db)`.
6. **Check existence** — `existsSync(join(vaultPath, relativePath))` → error if file already exists.
7. **Write** — `writeNodeFile(vaultPath, relativePath, content)`.
8. **Stat** — `statSync(join(vaultPath, relativePath))` for mtime. Guarantees the mtime in DB matches what the filesystem reports, so incremental indexer won't flag it as changed.
9. **Parse + Index** — `parseFile(relativePath, content)` then `indexFile(db, parsed, relativePath, mtime, content)` + `resolveReferences(db)`, wrapped in `db.transaction()`.
10. **Return** — Hydrated node (via `hydrateNodes`) + validation warnings array.

## Path Generation

- **With `parent_path`:** `<parent_path>/<sanitized_title>.md`. Uses the same `UNSAFE_CHARS_RE` sanitization as `generateFilePath` in `src/serializer/path.ts`. Ensures no double slashes, trailing slash on parent_path handled.
- **Without `parent_path`:** delegates to `generateFilePath(title, types, fields, db)`. Falls back to `{{title}}.md` if no schema has a `filename_template`.

## Relationship Processing

Fields are processed first. Relationships merge on top using set-or-append logic:

- **List detection:** Use `mergeSchemaFields` result (step 1) when schemas exist — it's the authoritative source. For schema-less nodes, fall back to checking if the current field value is already an array.
- **Scalar field:** `fields[rel_type] = "[[target]]"` (overwrites).
- **List field:** append `"[[target]]"` to existing array (or create `["[[target]]"]`).
- **No matching field / body:** append `[[target]]` to body text with newline separation.

## Return Shape

**Success:**
```json
{
  "node": { "id": "tasks/review.md", "file_path": "...", "types": [...], "fields": {...}, "content_text": "...", "updated_at": "..." },
  "warnings": [{ "field": "status", "message": "..." }]
}
```

Node shape matches `get-node` output (via `hydrateNodes`). Warnings array from `validateNode` — empty if no schemas or all valid.

**Errors** (all with `isError: true`):
- File exists: `"Error: File already exists at tasks/Review proposal.md. Use update-node to modify existing nodes or choose a different title."`
- Missing template variable: bubbles from `generateFilePath` with template + available vars.
- Write failure: caught and returned with error message.

## API Change

`createServer(db)` → `createServer(db, vaultPath)`. Entry point `src/index.ts` passes `vaultPath` through.

## Files Modified

- `src/mcp/server.ts` — add `vaultPath` param, `createNode` helper, `create-node` tool registration
- `src/index.ts` — pass `vaultPath` to `createServer`

No new files.

## Design Decisions

- **`stat()` over programmatic timestamp** — mtime from `statSync` guarantees DB matches filesystem, preventing unnecessary re-indexes by incremental indexer.
- **Helper inside closure, not separate module** — `createNode` captures `db`/`vaultPath` from closure. Task 7 (`batch-mutate`) can call it directly. Extract to separate module if/when Task 7 reveals the need.
- **Parse the serialized string, don't re-read from disk** — we already have the content in memory. `parseFile` only needs the raw string.
- **Warn, don't reject** — consistent with Phase 2 validation design. Schema violations produce warnings but the node is still created.
- **Relationships merge on top of fields** — simple, consistent rule. No conflict resolution needed.
