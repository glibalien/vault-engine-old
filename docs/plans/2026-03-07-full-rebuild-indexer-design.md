# Full Rebuild Indexer — Design

## Overview

The indexer connects the parser pipeline to the database. It's the `file → parse → upsert` integration point — Phase 1, Step 3.

Two functions in `src/sync/indexer.ts`:

- **`indexFile(db, parsed, relativePath, mtime)`** — writes one parsed file's data into all DB tables. Does not manage transactions — caller controls the boundary.
- **`rebuildIndex(db, vaultPath)`** — scans all `.md` files, clears all tables, parses and indexes each file in one transaction. Returns `{ filesIndexed: number }`.

## Node ID Strategy

File-level nodes use the **vault-relative file path** as their ID (e.g., `tasks/review-vendor-proposals.md`). Simple, stable, human-readable. Rename operations (Phase 3) update the ID.

## `indexFile` Data Mapping

Given a `ParsedFile` from the parser:

### nodes table
- `id` = vault-relative path
- `file_path` = same as id
- `node_type` = `'file'`
- `content_text` = `parsed.contentText`
- `content_md` = `parsed.contentMd`
- `parent_id`, `position_start`, `position_end` = null
- `depth` = 0

### node_types table
One row per entry in `parsed.types`.

### fields table
One row per `FieldEntry` in `parsed.fields`:
- `value_text` = stringified value (JSON for arrays, `.toISOString()` for dates, `String()` for rest)
- `value_type` = `fieldEntry.valueType`
- `value_number` = populated when `valueType === 'number'`
- `value_date` = ISO string when `valueType === 'date'`

### relationships table
One row per `WikiLink` in `parsed.wikiLinks`:
- `source_id` = node ID (vault-relative path)
- `target_id` = `wikiLink.target` (raw string — may be unresolved)
- `rel_type` = field name for frontmatter links (e.g., `assignee`), `'wiki-link'` for body links
- `context` = `wikiLink.context` if present

### files table
- `path` = vault-relative path
- `mtime` = file mtime from filesystem
- `hash` = SHA-256 of raw file content

## Insert Strategy

`indexFile` uses **delete-then-insert** for child tables:

1. `DELETE FROM relationships WHERE source_id = ?`
2. `DELETE FROM node_types WHERE node_id = ?`
3. `DELETE FROM fields WHERE node_id = ?`
4. `INSERT OR REPLACE INTO nodes` (keyed on path)
5. `INSERT INTO node_types` (fresh rows)
6. `INSERT INTO fields` (fresh rows)
7. `INSERT INTO relationships` (fresh rows)
8. `INSERT OR REPLACE INTO files` (keyed on path)

For `rebuildIndex`, the whole rebuild clears all tables at the start (children before parents for FK order), then inserts everything fresh — no per-file deletes needed.

## `rebuildIndex` Flow

1. Begin transaction
2. Clear all tables (relationships, fields, node_types, nodes, files — ordered for FK constraints)
3. Glob `**/*.md` under `vaultPath`
4. For each file:
   a. `readFileSync` file contents
   b. Compute vault-relative path
   c. Get file mtime via `statSync`
   d. `parseFile(relativePath, raw)`
   e. `indexFile(db, parsed, relativePath, mtime)`
5. Commit transaction
6. Return `{ filesIndexed: number }`

File reading is synchronous — we're inside a synchronous SQLite transaction. If a single file fails to parse, log a warning and skip it.

## Schema Change

The `relationships` table FK constraint on `target_id` must be dropped. Dangling wiki-link targets are valid — the target string is stored as-is and resolved to real node IDs in Phase 2. The `source_id` FK is kept since the source node always exists at index time.
