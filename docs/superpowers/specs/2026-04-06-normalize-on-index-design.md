# Normalize-on-Index (Layer 3) Design

Layer 3 of the three-layer schema enforcement architecture. When enabled, the indexer automatically normalizes frontmatter field names and values to match schema definitions on every index event — the "self-healing" layer for human edits.

Depends on: coercion engine (`src/coercion/`), enforcement config (`src/enforcement/`), `patchFrontmatter` (`src/serializer/patch.ts`).

## Core Function

New module: `src/sync/normalize-on-index.ts`

```ts
normalizeOnIndex(
  raw: string,
  parsed: ParsedFile,
  absPath: string,
  relativePath: string,
  enforcementConfig: EnforcementConfig,
  globalFields: Record<string, GlobalFieldDefinition>,
  db: Database.Database,
): NormalizeOnIndexResult

interface NormalizeOnIndexResult {
  raw: string;
  parsed: ParsedFile;
  patched: boolean;
  warnings: string[];
}
```

### Logic

1. If `parsed.types` is empty, return unchanged (no schema, nothing to enforce).
2. `resolveEnforcementPolicies(config, parsed.types)` to get the resolved `normalizeOnIndex` policy.
3. If `off`, return unchanged.
4. `mergeSchemaFields(db, parsed.types)` to get merged field definitions.
5. Build `fields` record from `parsed.fields` (`key` -> `value`).
6. `coerceFields(fields, mergeResult, globalFields, { unknownFields, enumValidation })` to get coercion result.
7. If no changes, return unchanged (with warnings array populated from coercion issues if `warn` mode).
8. If `warn`, return unchanged but populate `warnings` from the coercion changes (human-readable descriptions of what would be fixed).
9. If `fix`:
   - Convert coercion changes to `FrontmatterMutation[]` (see mutation mapping below).
   - Call `patchFrontmatter(raw, mutations)` to produce patched file content.
   - Re-parse with `parseFile(relativePath, patchedRaw)`.
   - Return `{ raw: patchedRaw, parsed: reParsed, patched: true, warnings: [] }`.

### Coercion-to-Mutation Mapping

| Coercion rule | Mutation type |
|---|---|
| `alias_map` | `rename_key` (from original key to canonical name) |
| `scalar_to_list` | `coerce_value` (existing — wraps scalar in brackets) |
| `enum_case` | `set_value` (new — replaces value in parsed YAML) |
| `boolean_coerce` | `set_value` |
| `number_coerce` | `set_value` |
| `reference_wrap` | `set_value` |

## `patchFrontmatter` Extension: `set_value` Mutation

New mutation type in `src/serializer/patch.ts`:

```ts
| { type: 'set_value'; key: string; value: unknown }
```

Implementation approach: **parse-mutate-serialize**, not regex. The frontmatter block is already isolated by the existing `---` boundary regex. For `set_value`:

1. Parse the YAML block with `yaml` library (the `parse` function from the `yaml` package, already a dependency).
2. Set `parsed[key] = value`.
3. Re-serialize the YAML with `yaml.stringify()`.
4. Reassemble `--- \n<yaml>\n---\n<body>`.

This replaces the current per-mutation regex approach for `set_value` only. `rename_key` and `coerce_value` continue using their existing regex-based approach since they work on key names and simple structural transforms where regex is reliable.

**Important:** When a mutation set includes `set_value` alongside `rename_key`/`coerce_value`, apply `rename_key` and `coerce_value` first (regex on raw YAML), then apply `set_value` mutations (parse-mutate-serialize on the already-renamed/coerced YAML). This ordering ensures `set_value` operates on canonical key names.

## Integration: Both Call Sites

### Watcher (`src/sync/watcher.ts` — `handleAddOrChange`)

After `parseFile`, before `indexFile`:

```
const parsed = parseFile(rel, raw);
const result = normalizeOnIndex(raw, parsed, absPath, rel, enforcementConfig, globalFields, db);
if (result.patched) {
  acquireWriteLock(rel);
  writeFileSync(absPath, result.raw);
  releaseWriteLock(rel);
  // Re-stat for updated mtime
  mtime = statSync(absPath).mtime.toISOString();
}
db.transaction(() => {
  indexFile(db, result.parsed, rel, mtime, result.raw);
  resolveReferences(db);
})();
```

#### Loop prevention

- `acquireWriteLock(rel)` before the file write prevents the watcher from re-processing the file (the watcher's `isWriteLocked(rel)` check returns early).
- `releaseWriteLock(rel)` after the write completes.
- The hash check in `handleAddOrChange` (reads DB hash, compares to file hash) is a secondary safety net — if the watcher somehow fires despite the lock, the hash matches the content we just indexed.
- The write lock window is intentionally short (just the `writeFileSync` call). By the time the watcher's debounce fires (300ms default), the lock is released. But the hash check catches this case since we've already indexed the patched content.

### `incrementalIndex` (`src/sync/indexer.ts`)

New optional options parameter:

```ts
interface IncrementalIndexOptions {
  enforcementConfig?: EnforcementConfig;
  globalFields?: Record<string, GlobalFieldDefinition>;
  skipNormalize?: boolean;
}
```

#### Queued file writes (atomicity)

File writes must not occur during the DB transaction. If the transaction rolls back, we don't want corrected files on disk with a stale DB. Approach:

1. During the loop, run `normalizeOnIndex` per file. If `patched`, queue the write: `pendingWrites.push({ absPath, content: result.raw })`.
2. Pass `result.raw` and `result.parsed` to `indexFile` inside the transaction (so the DB reflects the corrected content).
3. After the transaction commits, flush the write queue: write all patched files to disk.
4. If the transaction rolls back (throws), the write queue is never flushed. Files remain as-is. DB remains as-is. Consistent.

```
const pendingWrites: Array<{ absPath: string; content: string }> = [];

// Inside transaction loop:
const result = normalizeOnIndex(raw, parsed, absPath, rel, ...);
if (result.patched) {
  pendingWrites.push({ absPath, content: result.raw });
  normalized++;
}
indexFile(db, result.parsed, rel, mtime, result.raw);

// After transaction commits:
for (const { absPath, content } of pendingWrites) {
  writeFileSync(absPath, content, 'utf-8');
}
```

No write locks needed during `incrementalIndex` because the watcher hasn't started yet at startup time (watcher starts after `incrementalIndex` in `index.ts`). The mtime stored in the `files` table will be from the original `stat` call, not the post-write stat. This means the next `incrementalIndex` run will see a mtime mismatch, read the file, compute the hash — and find the hash matches (since we wrote the corrected content and indexed the same content). Result: skip. No infinite loop.

#### Return type expansion

```ts
{ indexed: number; skipped: number; deleted: number; normalized: number }
```

`normalized` counts files that were patched by normalize-on-index. These files are also counted in `indexed` (they were indexed with the corrected content).

## Passing Config to Indexer/Watcher

`enforcementConfig` and `globalFields` are loaded in `src/index.ts` (same pure functions already used by the MCP server) and passed to both `incrementalIndex` and `watchVault`:

```ts
const enforcementConfig = loadEnforcementConfig(vaultPath);
const globalFields = loadGlobalFields(vaultPath);

incrementalIndex(db, vaultPath, { enforcementConfig, globalFields });
watchVault(db, vaultPath, { enforcementConfig, globalFields, onSchemaChange: ... });
```

Both accept these as optional fields — when absent, normalize-on-index is skipped (backward compatible). The MCP server continues loading its own copies (they're read-once config from the same files).

The `watchVault` function stores the config in its closure and passes it to `handleAddOrChange`. The `WatcherOptions` interface gains optional `enforcementConfig` and `globalFields` fields.

## Startup Logging

`index.ts` logs after `incrementalIndex`:

```
[vault-engine] indexed 5, skipped 120, deleted 0, normalized 3
```

When `normalized > 0`, an additional line:

```
[vault-engine] normalize-on-index: fixed 3 files (policy: fix for types with fix config)
```

The watcher logs per-file when it normalizes:

```
[vault-engine] watcher: normalized + indexed tasks/review.md (2 field corrections)
```

## Kill Switch

Environment variable: `VAULT_ENGINE_SKIP_NORMALIZE=1`

Checked once in `src/index.ts`. When set, `skipNormalize: true` is passed in the options to both `incrementalIndex` and `watchVault`. Both functions treat it as `normalizeOnIndex: off` for all files regardless of enforcement config.

Startup log when active:

```
[vault-engine] normalize-on-index: disabled via VAULT_ENGINE_SKIP_NORMALIZE
```

## Tests

All tests in `tests/sync/normalize-on-index.test.ts`.

### 1. `fix` mode auto-corrects on index

Create a task file with `Status: Todo` (wrong key casing, wrong enum casing). Enforcement config: `normalize_on_index: fix` for `task` type. Schema defines `status` field with enum `[todo, in_progress, done]`.

- Call `normalizeOnIndex(raw, parsed, ...)`.
- Assert `patched === true`.
- Assert returned `raw` contains `status: todo` (key renamed, value coerced).
- Assert returned `parsed.fields` has the corrected values.

### 2. `warn` mode logs but doesn't modify

Same setup but enforcement config: `normalize_on_index: warn`.

- Assert `patched === false`.
- Assert `warnings` array is non-empty with human-readable descriptions.
- Assert `raw` is unchanged.

### 3. `off` mode skips entirely

- Assert `patched === false`, `warnings` is empty.

### 4. Server-down scenario (incrementalIndex integration)

1. Set up a vault with a task file, enforcement config with `fix`.
2. Run `incrementalIndex` — file is clean, `normalized: 0`.
3. Externally modify the file (simulate Obsidian edit): change `status: todo` to `Status: Todo`.
4. Run `incrementalIndex` again.
5. Assert `normalized: 1`, file on disk now says `status: todo`, DB has corrected value.

### 5. Multi-type strictest-wins

Node with `types: [task, note]`. Task config: `fix`, note config: `warn`. Resolved policy: `fix` (strictest). Assert file gets corrected.

### 6. Convergence

Run `normalizeOnIndex` in `fix` mode. Take the returned `raw` and `parsed`, run `normalizeOnIndex` again on the result. Assert `patched === false` and `warnings` is empty on the second pass. Zero changes means the coercion is idempotent.

### 7. Kill switch

Pass `skipNormalize: true` to `incrementalIndex`. Assert `normalized: 0` even when enforcement config says `fix` and the file has wrong casing.

### 8. No schema is a no-op

File with no `types` in frontmatter. Assert `patched === false` regardless of config.

### 9. Watcher loop prevention (smoke test)

Use the watcher test pattern (chokidar + temp vault). Edit a file with wrong casing. Assert the watcher normalizes it, indexes it once, and doesn't trigger a second index event.
