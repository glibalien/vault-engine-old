# File Writer + Write Lock Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `writeNodeFile` and `deleteNodeFile` with write lock coordination, and add a belt-and-suspenders hash check to the watcher to prevent redundant re-indexing of engine-written files.

**Architecture:** Two pure filesystem functions in `src/serializer/writer.ts` (no DB access) using try/finally around write lock acquire/release. A small watcher modification adds SHA-256 hash comparison before re-indexing to catch edge cases where chokidar fires events after lock release.

**Tech Stack:** Node.js `fs` (writeFileSync, mkdirSync, unlinkSync), better-sqlite3 (watcher hash check), vitest, chokidar (integration tests)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/serializer/writer.ts` | `writeNodeFile`, `deleteNodeFile` — filesystem writes with write lock |
| Modify | `src/serializer/index.ts` | Add re-exports for `writeNodeFile`, `deleteNodeFile` |
| Modify | `src/sync/watcher.ts` | Add hash check in `handleAddOrChange` debounced callback |
| Create | `tests/serializer/writer.test.ts` | Unit tests for writer functions |
| Modify | `tests/sync/watcher.test.ts` | Test for hash-based skip |
| Create | `tests/serializer/writer-watcher.test.ts` | Integration: writer + watcher no-reindex |

---

### Task 1: `writeNodeFile` — tests and implementation

**Files:**
- Create: `tests/serializer/writer.test.ts`
- Create: `src/serializer/writer.ts`

- [ ] **Step 1: Write failing tests for `writeNodeFile`**

```typescript
// tests/serializer/writer.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeNodeFile } from '../../src/serializer/writer.js';
import { isWriteLocked } from '../../src/sync/watcher.js';

describe('writeNodeFile', () => {
  let tmpVault: string;

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('creates a file with the given content', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Hello\n');
  });

  it('creates parent directories recursively', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'tasks/work/review.md', '# Review\n');
    expect(readFileSync(join(tmpVault, 'tasks/work/review.md'), 'utf-8')).toBe('# Review\n');
  });

  it('overwrites an existing file', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Original\n');
    writeNodeFile(tmpVault, 'test.md', '# Updated\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Updated\n');
  });

  it('releases write lock after successful write', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releases write lock on filesystem error', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    // Write to a path where the parent is a file, not a directory
    writeNodeFile(tmpVault, 'blocker', '# Blocker\n');
    expect(() => writeNodeFile(tmpVault, 'blocker/nested.md', '# Fail\n')).toThrow();
    expect(isWriteLocked('blocker/nested.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/writer.test.ts`
Expected: FAIL — `writeNodeFile` not found

- [ ] **Step 3: Implement `writeNodeFile`**

```typescript
// src/serializer/writer.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireWriteLock, releaseWriteLock } from '../sync/watcher.js';

export function writeNodeFile(
  vaultPath: string,
  relativePath: string,
  content: string,
): void {
  acquireWriteLock(relativePath);
  try {
    const absPath = join(vaultPath, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  } finally {
    releaseWriteLock(relativePath);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/writer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/serializer/writer.ts tests/serializer/writer.test.ts
git commit -m "add writeNodeFile with write lock and recursive mkdir"
```

---

### Task 2: `deleteNodeFile` — tests and implementation

**Files:**
- Modify: `tests/serializer/writer.test.ts`
- Modify: `src/serializer/writer.ts`

- [ ] **Step 1: Write failing tests for `deleteNodeFile`**

Add to `tests/serializer/writer.test.ts`:

```typescript
import { writeFileSync } from 'fs';
import { deleteNodeFile } from '../../src/serializer/writer.js';

describe('deleteNodeFile', () => {
  let tmpVault: string;

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('removes the file', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeFileSync(join(tmpVault, 'test.md'), '# Hello\n');
    deleteNodeFile(tmpVault, 'test.md');
    expect(existsSync(join(tmpVault, 'test.md'))).toBe(false);
  });

  it('throws if file does not exist', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    expect(() => deleteNodeFile(tmpVault, 'nonexistent.md')).toThrow();
  });

  it('releases write lock after successful delete', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeFileSync(join(tmpVault, 'test.md'), '# Hello\n');
    deleteNodeFile(tmpVault, 'test.md');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releases write lock on error', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    expect(() => deleteNodeFile(tmpVault, 'nonexistent.md')).toThrow();
    expect(isWriteLocked('nonexistent.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/writer.test.ts`
Expected: FAIL — `deleteNodeFile` not found

- [ ] **Step 3: Implement `deleteNodeFile`**

Add to `src/serializer/writer.ts`:

```typescript
import { unlinkSync } from 'node:fs';

export function deleteNodeFile(
  vaultPath: string,
  relativePath: string,
): void {
  acquireWriteLock(relativePath);
  try {
    unlinkSync(join(vaultPath, relativePath));
  } finally {
    releaseWriteLock(relativePath);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/writer.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/serializer/writer.ts tests/serializer/writer.test.ts
git commit -m "add deleteNodeFile with write lock (no empty dir cleanup in v1)"
```

---

### Task 3: Re-exports and watcher hash check

**Files:**
- Modify: `src/serializer/index.ts`
- Modify: `src/sync/watcher.ts`
- Modify: `tests/sync/watcher.test.ts`

- [ ] **Step 1: Add re-exports to serializer index**

Update `src/serializer/index.ts` to add:

```typescript
export { writeNodeFile, deleteNodeFile } from './writer.js';
```

- [ ] **Step 2: Write failing test for watcher hash check**

Add these imports to the top of `tests/sync/watcher.test.ts` (alongside existing imports):

```typescript
import { statSync } from 'fs';
import { indexFile } from '../../src/sync/indexer.js';
import { parseFile } from '../../src/parser/index.js';
```

Add this test inside the `watchVault` describe block:

```typescript
it('skips re-index when file content unchanged (hash match)', async () => {
  handle = watchVault(db, tmpVault);
  await handle.ready;

  const content = '---\ntitle: Stable\n---\n';
  const rel = 'stable.md';
  const absPath = join(tmpVault, rel);

  // Pre-index the file in the DB
  writeFileSync(absPath, content);
  const parsed = parseFile(rel, content);
  const mtime = statSync(absPath).mtime.toISOString();
  db.transaction(() => {
    indexFile(db, parsed, rel, mtime, content);
  })();

  // Touch the file (rewrite same content) — triggers chokidar change event
  // but hash should match, so watcher skips re-index
  writeFileSync(absPath, content);

  // Write a different file to prove the watcher is processing events
  writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
  );

  // Give time for any stray events
  await new Promise((r) => setTimeout(r, 200));

  // The stable file's DB entry should still have the original mtime
  // (watcher didn't re-index it)
  const filesRow = db.prepare('SELECT mtime FROM files WHERE path = ?').get(rel) as any;
  expect(filesRow.mtime).toBe(mtime);
});
```

- [ ] **Step 3: Run tests to verify the hash-match test fails**

Run: `npx vitest run tests/sync/watcher.test.ts -t "skips re-index when file content unchanged"`
Expected: FAIL — watcher currently re-indexes regardless of hash

- [ ] **Step 4: Add hash check to watcher's `handleAddOrChange`**

Modify `src/sync/watcher.ts` `handleAddOrChange` debounced callback. Add `createHash` to the imports:

```typescript
import { createHash } from 'node:crypto';
```

Then update the debounced callback body in `handleAddOrChange`:

```typescript
debounced(rel, () => {
  try {
    const raw = readFileSync(absPath, 'utf-8');
    const hash = createHash('sha256').update(raw).digest('hex');
    const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(rel) as
      | { hash: string }
      | undefined;
    if (existing && existing.hash === hash) return;

    const mtime = statSync(absPath).mtime.toISOString();
    const parsed = parseFile(rel, raw);
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, raw);
      resolveReferences(db);
    })();
  } catch (err) {
    console.error(`[vault-engine] failed to index ${rel}:`, err);
  }
});
```

Note: `statSync` moves after the hash check so it's only called when we actually re-index.

- [ ] **Step 5: Run all watcher tests**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/serializer/index.ts src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "add watcher hash check and serializer writer re-exports"
```

---

### Task 4: Writer + watcher integration test

**Files:**
- Create: `tests/serializer/writer-watcher.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// tests/serializer/writer-watcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { watchVault } from '../../src/sync/watcher.js';
import { writeNodeFile, deleteNodeFile } from '../../src/serializer/writer.js';
import { indexFile, deleteFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { parseFile } from '../../src/parser/index.js';

function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('writer + watcher integration', () => {
  let db: Database.Database;
  let tmpVault: string;
  let handle: { close(): Promise<void>; ready: Promise<void> };

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-watch-'));
    handle = watchVault(db, tmpVault);
    await handle.ready;
  });

  afterEach(async () => {
    await handle.close();
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('writeNodeFile + immediate index does not cause watcher re-index', async () => {
    const content = '---\ntitle: Engine Written\ntypes: [note]\n---\n';
    const rel = 'engine-note.md';

    // Simulate what create-node will do: write file, then index it
    writeNodeFile(tmpVault, rel, content);
    const parsed = parseFile(rel, content);
    const mtime = statSync(join(tmpVault, rel)).mtime.toISOString();
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, content);
      resolveReferences(db);
    })();

    // Write a marker file to prove watcher is active
    writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
    );

    // Wait for any stray events
    await new Promise((r) => setTimeout(r, 300));

    // The engine-written file should have been indexed exactly once
    // (by our direct indexFile call, not re-indexed by the watcher)
    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(rel) as any;
    expect(node.title).toBe('Engine Written');
  });

  it('deleteNodeFile does not cause watcher to error on deleted file', async () => {
    const content = '---\ntitle: To Delete\ntypes: [note]\n---\n';
    const rel = 'to-delete.md';

    // Create and index the file
    writeNodeFile(tmpVault, rel, content);
    const parsed = parseFile(rel, content);
    const mtime = statSync(join(tmpVault, rel)).mtime.toISOString();
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, content);
    })();

    // Delete via deleteNodeFile (write-locked) and clean up DB
    deleteNodeFile(tmpVault, rel);
    db.transaction(() => {
      deleteFile(db, rel);
    })();

    // Write a marker file to prove watcher is active
    writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
    );

    await new Promise((r) => setTimeout(r, 300));

    // The deleted file should not exist in DB
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(rel)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/serializer/writer-watcher.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 4: Commit**

```bash
git add tests/serializer/writer-watcher.test.ts
git commit -m "add writer + watcher integration tests"
```
