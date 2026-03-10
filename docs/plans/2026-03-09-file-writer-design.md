# File Writer + Write Lock Integration — Design

**Phase 3, Task 2** — The glue between serializer output and the filesystem, ensuring the watcher doesn't re-index engine-written files.

## API Surface

### `writeNodeFile(vaultPath: string, relativePath: string, content: string): void`

1. `acquireWriteLock(relativePath)`
2. Create parent directories if needed (`mkdirSync` recursive)
3. `writeFileSync(join(vaultPath, relativePath), content, 'utf-8')`
4. `releaseWriteLock(relativePath)` — immediate release

Uses try/finally to guarantee lock release on error.

### `deleteNodeFile(vaultPath: string, relativePath: string): void`

1. `acquireWriteLock(relativePath)`
2. `unlinkSync(join(vaultPath, relativePath))`
3. `releaseWriteLock(relativePath)` — immediate release

Uses try/finally to guarantee lock release on error. Throws if file doesn't exist (caller should check).

**Empty parent directories** are NOT cleaned up after delete. If a schema's `filename_template` puts files in `tasks/work/{{title}}.md`, deleting the last work-task leaves an empty `tasks/work/` directory. This is known behavior for v1 — cleanup deferred.

## File Location

`src/serializer/writer.ts` — no DB access, purely filesystem + write lock coordination.

Re-exported from `src/serializer/index.ts`.

## Write Lock Strategy: Immediate Release + Hash Backup

### Primary defense: write lock

The watcher checks `isWriteLocked(rel)` at event arrival time (before debounce). If the lock is held, the event is dropped entirely. Since `writeFileSync` is synchronous and chokidar fires events on the same thread, the lock is held when the OS notifies chokidar of the change. Immediate release after `writeFileSync` is safe in the common case.

### Belt-and-suspenders: hash check in watcher

If chokidar fires the event slightly after lock release (edge case), the watcher would proceed to re-index. To prevent this redundant work, add a hash check in the watcher's `handleAddOrChange` debounced callback:

```typescript
debounced(rel, () => {
  const raw = readFileSync(absPath, 'utf-8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(rel);
  if (existing && existing.hash === hash) return; // already indexed this content
  // ... proceed with parseFile + indexFile
});
```

**Why this is needed:** `indexFile` does NOT check hashes before writing — it always does delete-then-insert. The incremental indexer (`incrementalIndex`) has hash-based skip logic, but the watcher calls `indexFile` directly. So the hash check must be added to the watcher callback itself.

**Cost:** one extra DB query (`SELECT hash FROM files`) per watcher event that slips past the lock. This is cheap compared to a full parse + index cycle.

## Testing Plan

### Unit tests (`tests/serializer/writer.test.ts`)

- `writeNodeFile` creates file with correct content
- `writeNodeFile` creates parent directories recursively
- `writeNodeFile` overwrites existing file
- `writeNodeFile` releases lock on filesystem error (try/finally)
- `deleteNodeFile` removes file
- `deleteNodeFile` releases lock on filesystem error (try/finally)
- `deleteNodeFile` throws if file doesn't exist

### Watcher hash check (`tests/sync/watcher.test.ts` — additions)

- Watcher skips re-index when file hash matches DB (belt-and-suspenders path)

### Integration test (`tests/serializer/writer-watcher.test.ts`)

- Write file via `writeNodeFile` with active watcher, verify no re-index loop
- Delete file via `deleteNodeFile` with active watcher, verify no re-index of deleted file

## Dependencies

- `acquireWriteLock`, `releaseWriteLock` from `src/sync/watcher.ts` (already exported)
- `node:fs` (`writeFileSync`, `mkdirSync`, `unlinkSync`)
- `node:path` (`join`, `dirname`)
- `node:crypto` (`createHash`) — for watcher hash check modification
