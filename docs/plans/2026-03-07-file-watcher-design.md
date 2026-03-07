# File Watcher Design

## Context

Task 6 of Phase 1. The file watcher keeps the SQLite index in sync with the vault filesystem by watching for `.md` file changes and triggering per-file indexing.

Dependencies: `indexFile`, `deleteFile` from `src/sync/indexer.ts`, chokidar v5.

## Decisions

### Per-file indexing (not batch)

Chokidar tells us exactly which file changed. We call `indexFile`/`deleteFile` directly for each event rather than running `incrementalIndex` (which scans the entire vault). This avoids redundant stat calls on unchanged files.

### Per-file debounce

A `Map<string, Timer>` tracks pending timers keyed by relative path. When an event fires:
1. Clear any existing timer for that path
2. Set a new timer (`debounceMs`, default 300ms)
3. When the timer fires, execute the index/delete operation

This handles rapid saves (editor auto-save, format-on-save) without double-indexing.

### Silent operation (no events/callbacks)

The watcher's only job in Phase 1 is "keep the index fresh." No event emitter, no callbacks, no observability hooks. These can be added later when the MCP server needs them.

### Write-lock stub for Phase 3

A `Set<string>` of paths currently being written by the engine. The watcher checks this set before processing — if the path is in the set, skip it.

Exported as `acquireWriteLock(path)` / `releaseWriteLock(path)`. Nothing calls these in Phase 1; the serializer will use them in Phase 3 to prevent re-indexing engine-written files.

## API

```typescript
export interface WatcherOptions {
  debounceMs?: number;    // default 300
  ignorePaths?: string[]; // globs to ignore, e.g. ['.obsidian/**']
}

export function watchVault(
  db: Database.Database,
  vaultPath: string,
  opts?: WatcherOptions,
): { close(): Promise<void> }

export function acquireWriteLock(relativePath: string): void
export function releaseWriteLock(relativePath: string): void
```

## Event Mapping

| Chokidar event | Action |
|---|---|
| `add` | Read file, `parseFile`, `indexFile` |
| `change` | Same as `add` (idempotent delete-then-insert) |
| `unlink` | `deleteFile(db, relativePath)` |

## Ignore Patterns

Chokidar's `ignored` option. Default ignores: `**/node_modules/**`, `**/.git/**`. User-provided `ignorePaths` merged in. Only `**/*.md` files are watched (chokidar glob filter).

## Error Handling

If `parseFile` or `indexFile` throws for a single file, log to stderr and continue. One bad file does not stop the watcher.

## Testing Strategy

Integration tests with a real temp directory and real chokidar watching. Write/modify/delete files, assert DB state after waiting for debounce to settle.

Test cases:
- New `.md` file added → node appears in DB
- `.md` file modified → DB content updates
- `.md` file deleted → node removed from DB
- Non-`.md` file changes are ignored
- Rapid writes debounced to single index operation
- Write-locked path is skipped
