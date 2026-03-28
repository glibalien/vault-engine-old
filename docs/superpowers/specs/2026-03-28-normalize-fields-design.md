# normalize-fields Design Spec

**Goal:** Add a `normalize-fields` MCP tool that normalizes frontmatter field names and value shapes across the vault to match schema definitions.

**Motivation:** Schema inference revealed two systemic consistency problems: field casing duplication (`company` vs `Company`) and value shape inconsistency (bare reference vs array for `list<reference>` fields). Both are artifacts of organic vault growth. The engine has the schema definitions, the index, and the write path to fix these.

---

## Layer 1: `patchFrontmatter()` — `src/serializer/patch.ts`

Pure function: `(fileContent: string, mutations: FrontmatterMutation[]) => string`

### Approach

Regex-based surgical patching. Extract the raw YAML string between `---` markers, apply mutations as regex replacements on that string, reassemble with the original body byte-for-byte.

No gray-matter round-trip for serialization — that would reformat unaffected keys and create noisy diffs. gray-matter is not used here at all; the regex operates directly on the raw YAML text.

### Mutation Types

```typescript
type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string };
```

**`rename_key`:** Regex finds `^from:` at start of line (case-sensitive exact match), replaces the key portion with `to`. Preserves the colon, spacing, and value. Skips if `to` already exists as a key in the YAML (avoids clobbering when both casings are present in the same file).

**`coerce_value`:** Regex finds `^key: value` where value doesn't start with `[`, wraps the value in brackets: `key: [value]`. Only triggers when `targetType` starts with `list`. Single-line values only — block-style YAML arrays are already indexed as lists in the DB and won't be flagged by rule inference.

### Ordering

Mutations applied sequentially in array order. The normalize-fields handler sorts renames before coercions so that a rename+coerce combo on the same field works: rename changes the key name, coerce then matches the new key.

### Edge Cases

- No frontmatter (no `---` markers) → return unchanged
- Empty mutations array → return unchanged
- `from_key` not found in YAML → skip that mutation (no error)
- `to_key` already exists → skip rename (no error)
- Value already an array (`[...]`) → skip coercion

---

## Layer 2: Global Write Lock — `src/sync/watcher.ts`

Three new functions alongside the existing per-file lock:

- `acquireGlobalWriteLock()` — sets a module-level boolean to `true`
- `releaseGlobalWriteLock()` — sets it to `false`
- `isGlobalWriteLocked()` — reads the boolean

When the boolean is true, both `handleAddOrChange` and the `unlink` handler return immediately, before the existing per-file lock check and before debouncing. This suppresses all watcher events during bulk operations.

No modified-file tracking in the lock itself. After release, the caller runs `incrementalIndex()` which scans the full vault and efficiently picks up only changed files via mtime-first, hash-fallback change detection.

### Exports

Add `acquireGlobalWriteLock`, `releaseGlobalWriteLock`, `isGlobalWriteLocked` to `src/sync/watcher.ts` exports and re-export from `src/sync/index.ts`.

---

## Layer 3: `normalize-fields` MCP Tool — `src/mcp/normalize-fields.ts`

### Tool Registration

Registered in `src/mcp/server.ts` with handler delegating to `normalizeFields()` in a separate module.

```typescript
server.tool('normalize-fields', description, {
  mode: z.enum(['audit', 'apply']).default('audit'),
  schema_type: z.string().min(1).optional(),
  rules: z.array(z.object({
    action: z.enum(['rename_key', 'coerce_value']),
    from_key: z.string().min(1),
    to_key: z.string().min(1).optional(),
    target_type: z.string().min(1).optional(),
  })).optional(),
}, handler);
```

### Rule Inference

When `rules` is omitted, auto-infer from schema definitions:

1. Load all resolved schemas (or filter by `schema_type`)
2. For each schema field with canonical name `canonicalKey`:
   - Query DB: `SELECT DISTINCT f.key FROM fields f JOIN node_types nt ... WHERE nt.schema_type = ? AND LOWER(f.key) = LOWER(?) AND f.key != ?` → each variant becomes a `rename_key` rule
   - If field type starts with `list`: query DB for values where `value_type != 'list'` → `coerce_value` rule
3. Deduplicate rules (same from/to pair or same key/targetType)
4. **Skip fields with no schema definition.** Only normalize toward schema-defined canonical forms. Users can pass explicit `rules` for unschematized fields.

### Affected File Discovery

`findAffectedFiles(db, rules, schemaType?)` queries the DB per rule:

- `rename_key`: exact match on `from_key` in `fields` table (with optional `node_types` join for schema_type filter)
- `coerce_value`: case-insensitive match on field key where `value_type != 'list'` (with optional schema_type filter)

Returns:
- `ruleReports`: per-rule summary with `files_affected` count and `sample_files` (first 5)
- `fileMutations`: `Map<string, FrontmatterMutation[]>` — per-file mutation list, renames sorted before coercions

### Audit Mode

Run rule inference (or use explicit rules) → `findAffectedFiles` → return report. No file I/O beyond DB queries.

### Apply Mode

1. Acquire global write lock
2. For each file in `fileMutations`:
   - Read raw content from disk
   - Snapshot original content in `Map<string, string>` for rollback
   - Call `patchFrontmatter(raw, mutations)`
   - Compare result to original — skip if unchanged (no actual mutations applied)
   - Write via `writeNodeFile(vaultPath, fileId, patched, deferredLocks)`
3. On error: restore all snapshots via `writeNodeFile` (same pattern as `batch-mutate`), then re-throw
4. In `finally`: release global write lock + release all deferred per-file locks
5. After successful writes: `incrementalIndex(db, vaultPath)` + `resolveReferences(db)` once
6. Return report with `total_files_affected` = number of files actually written (not just candidates)

### Response Shape

```json
{
  "rules_applied": [
    {
      "action": "rename_key",
      "from_key": "Company",
      "to_key": "company",
      "files_affected": 187,
      "sample_files": ["meetings/a.md", "meetings/b.md"]
    },
    {
      "action": "coerce_value",
      "from_key": "people involved",
      "target_type": "list<reference>",
      "files_affected": 42,
      "sample_files": ["meetings/c.md"]
    }
  ],
  "total_files_affected": 229,
  "mode": "audit"
}
```

### Error Handling

- No schemas loaded → return empty report (no rules to infer)
- `rename_key` rule without `to_key` → validation error
- `coerce_value` rule without `target_type` → validation error
- File read/write failure during apply → rollback all snapshots, return error via `toolError`

---

## File Structure

- **Create:** `src/serializer/patch.ts` — `patchFrontmatter()` + `FrontmatterMutation` type
- **Create:** `src/mcp/normalize-fields.ts` — `inferRules`, `findAffectedFiles`, `normalizeFields`
- **Create:** `tests/serializer/patch.test.ts` — unit tests for patchFrontmatter
- **Create:** `tests/sync/global-lock.test.ts` — global write lock unit tests
- **Create:** `tests/mcp/normalize-fields.test.ts` — MCP tool integration tests
- **Modify:** `src/serializer/index.ts` — re-export `patchFrontmatter` + type
- **Modify:** `src/sync/watcher.ts` — add global write lock functions + watcher check
- **Modify:** `src/sync/index.ts` — re-export global lock functions
- **Modify:** `src/mcp/server.ts` — register normalize-fields tool + import handler

---

## Out of Scope

- Value content normalization (entity resolution)
- Schema-to-schema migration
- Body content normalization
- Frequency-based canonical form guessing for unschematized fields
- Block-style YAML array handling in coerce_value
