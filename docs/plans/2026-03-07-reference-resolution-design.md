# Reference Resolution Design

Phase 2 Task 4. Resolves raw wiki-link target strings in `relationships.target_id` to actual node IDs.

## Schema Changes

Add to `createSchema()` (DB is rebuildable, no migration tracking):

```sql
-- nodes table: add title column
title TEXT  -- in the CREATE TABLE, after content_md

-- relationships table: add resolved column
resolved_target_id TEXT  -- nullable, references nodes(id)

-- new index for stale cleanup
CREATE INDEX idx_rel_resolved ON relationships(resolved_target_id);
```

## Title Population

`indexFile()` populates `nodes.title` on every insert:

1. If frontmatter has `title` field, use it
2. Otherwise, derive from filename: strip directory and `.md` extension, preserve original casing and spacing
   - `people/Alice Smith.md` -> `Alice Smith`
   - `meetings/Q1 Planning.md` -> `Q1 Planning`
   - No slug-ification — the stored title reflects what the user actually named the file

## Resolution Algorithm

`resolveReferences(db)` runs as a single end-of-transaction pass:

1. **Clear stale resolutions** — `UPDATE relationships SET resolved_target_id = NULL WHERE resolved_target_id NOT IN (SELECT id FROM nodes)`
2. **Build lookup tables** from all nodes (queried once):
   - `Map<lowercase_title, node_id[]>` — title-based lookup
   - `Map<lowercase_stem, node_id[]>` — filename stem lookup (path without directory and `.md`)
   - `Map<lowercase_path_suffix, node_id[]>` — progressively longer path suffixes for disambiguation
3. **Resolve unresolved rows** — query `WHERE resolved_target_id IS NULL`, for each:
   - Case-insensitive match against title map
   - If no title match, try filename stem map
   - If multiple matches at either stage, try shortest unique path match (see below)
   - Exactly one match -> set `resolved_target_id`
   - Ambiguous or no match -> leave NULL

## Shortest Unique Path Match

Handles disambiguation when multiple nodes share the same title or filename stem.

For wiki-link `[[work/Meeting Notes]]`:
- Strip `.md` from all node IDs
- Check which paths end with `work/meeting notes` (case-insensitive)
- Exactly one match -> resolved
- Multiple matches at same suffix depth -> leave NULL (truly ambiguous)

For wiki-link `[[Meeting Notes]]` with two matches (`work/Meeting Notes.md`, `personal/Meeting Notes.md`):
- Title/stem lookup returns two candidates
- Wiki-link target has no path component to disambiguate -> leave NULL
- User must write `[[work/Meeting Notes]]` or `[[personal/Meeting Notes]]` to disambiguate

## Integration Points

- **`indexFile()`** — Populate `nodes.title` column on insert
- **`rebuildIndex()`** — Call `resolveReferences(db)` after all files indexed, inside the transaction
- **`incrementalIndex()`** — Call `resolveReferences(db)` after all changes processed, inside the transaction
- **`watchVault()`** — Call `resolveReferences(db)` after each file change event's `indexFile`/`deleteFile`, inside the per-event transaction

## API Surface

```typescript
// src/sync/resolver.ts
export function resolveReferences(db: Database.Database): { resolved: number; unresolved: number };
export function resolveTarget(db: Database.Database, wikiLinkTarget: string): string | null;
```

`resolveTarget` is a standalone function for resolving a single wiki-link target. Used internally by `resolveReferences` and exposed for MCP tools or future use.

## What This Does NOT Include

- Updating MCP tool responses to use `resolved_target_id` (Task 5 scope)
- Schema-aware reference validation, e.g., checking `target_schema: person` (Task 3 validation scope)
- Write-path reference updates on rename (Phase 3)
