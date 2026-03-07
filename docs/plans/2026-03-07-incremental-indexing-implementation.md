# Incremental Indexing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `deleteFile` and `incrementalIndex` to the sync layer so only new, modified, or deleted files trigger DB updates.

**Architecture:** `incrementalIndex` scans all `.md` files on disk, compares mtime/hash against the `files` table, and only re-parses files that changed. Deleted files are cleaned up. Everything runs in one transaction. Reuses existing `indexFile` for the actual parse+insert work.

**Tech Stack:** TypeScript, better-sqlite3, node:crypto (SHA-256), node:fs, vitest

---

### Task 1: `deleteFile` — tests

**Files:**
- Test: `tests/sync/indexer.test.ts`

Tests go inside a new `describe('deleteFile', ...)` block after the existing `describe('indexFile', ...)` block.

**Step 1: Write failing tests for `deleteFile`**

Add this to `tests/sync/indexer.test.ts` after line 165 (after the `indexFile` describe block closes):

```typescript
describe('deleteFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedFile(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('removes node, types, fields, relationships, and files rows', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    seedFile('tasks/review.md', raw);

    deleteFile(db, 'tasks/review.md');

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('tasks/review.md')).toBeUndefined();
    expect(db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM fields WHERE node_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM relationships WHERE source_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md')).toBeUndefined();
  });

  it('does not affect other files', () => {
    const raw1 = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const raw2 = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    seedFile('tasks/review.md', raw1);
    seedFile('people/alice.md', raw2);

    deleteFile(db, 'tasks/review.md');

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('people/alice.md')).toBeDefined();
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('people/alice.md')).toBeDefined();
  });

  it('is a no-op for nonexistent paths', () => {
    expect(() => deleteFile(db, 'nonexistent.md')).not.toThrow();
  });
});
```

Also update the import on line 7 to include `deleteFile`:

```typescript
import { indexFile, rebuildIndex, deleteFile } from '../../src/sync/indexer.js';
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — `deleteFile` is not exported

---

### Task 2: `deleteFile` — implementation

**Files:**
- Modify: `src/sync/indexer.ts`

**Step 3: Implement `deleteFile`**

Add this function to `src/sync/indexer.ts` after the `indexFile` function (after line 86):

```typescript
export function deleteFile(db: Database.Database, relativePath: string): void {
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(relativePath);
  db.prepare('DELETE FROM files WHERE path = ?').run(relativePath);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All `deleteFile` tests PASS

**Step 5: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "add deleteFile function to remove all DB rows for a file path"
```

---

### Task 3: `incrementalIndex` — tests for new files

`incrementalIndex` reads files from disk, so tests need a temp directory where files can be added, modified, and deleted between calls. All `incrementalIndex` tests go in a single new `describe('incrementalIndex', ...)` block.

**Files:**
- Test: `tests/sync/indexer.test.ts`

**Step 6: Write tests for indexing new files**

Add this `describe` block at the end of the test file. It creates a temp directory, copies fixtures into it, and runs `incrementalIndex`.

Add these imports at the top of the file:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
```

Then add the describe block:

```typescript
describe('incrementalIndex', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  function writeVaultFile(relPath: string, content: string) {
    const abs = join(tmpVault, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('indexes all files when DB is empty', () => {
    writeVaultFile('notes/hello.md', '# Hello\nWorld.');
    writeVaultFile('notes/bye.md', '# Bye\nSee you.');

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);

    const nodes = db.prepare('SELECT id FROM nodes ORDER BY id').all() as any[];
    expect(nodes.map(n => n.id)).toEqual(['notes/bye.md', 'notes/hello.md']);
  });

  it('populates files table with mtime and hash', () => {
    writeVaultFile('test.md', '# Test');

    incrementalIndex(db, tmpVault);

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('test.md') as any;
    expect(file).toBeDefined();
    expect(file.mtime).toBeTruthy();
    expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

Also update the import to include `incrementalIndex`:

```typescript
import { indexFile, rebuildIndex, deleteFile, incrementalIndex } from '../../src/sync/indexer.js';
```

**Step 7: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — `incrementalIndex` is not exported

---

### Task 4: `incrementalIndex` — minimal implementation (new files only)

**Files:**
- Modify: `src/sync/indexer.ts`

**Step 8: Implement `incrementalIndex` (full algorithm)**

Add this function to `src/sync/indexer.ts` after `deleteFile`:

```typescript
export function incrementalIndex(
  db: Database.Database,
  vaultPath: string,
): { indexed: number; skipped: number; deleted: number } {
  const mdFiles = globMd(vaultPath);

  const run = db.transaction(() => {
    // Load existing file records into a map
    const existingFiles = new Map<string, { mtime: string; hash: string }>();
    const rows = db.prepare('SELECT path, mtime, hash FROM files').all() as Array<{ path: string; mtime: string; hash: string }>;
    for (const row of rows) {
      existingFiles.set(row.path, { mtime: row.mtime, hash: row.hash });
    }

    let indexed = 0;
    let skipped = 0;

    for (const absPath of mdFiles) {
      const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
      const mtime = statSync(absPath).mtime.toISOString();
      const existing = existingFiles.get(rel);

      // Mark as seen
      existingFiles.delete(rel);

      if (existing && existing.mtime === mtime) {
        // Mtime matches — skip
        skipped++;
        continue;
      }

      const raw = readFileSync(absPath, 'utf-8');

      if (existing) {
        // Mtime differs — check hash
        const hash = createHash('sha256').update(raw).digest('hex');
        if (hash === existing.hash) {
          // Content unchanged — just update mtime
          db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, rel);
          skipped++;
          continue;
        }
      }

      // New file or content changed — parse and index
      try {
        const parsed = parseFile(rel, raw);
        indexFile(db, parsed, rel, mtime, raw);
        indexed++;
      } catch {
        // Skip files that fail to parse
      }
    }

    // Delete files that are in DB but no longer on disk
    let deleted = 0;
    for (const [path] of existingFiles) {
      deleteFile(db, path);
      deleted++;
    }

    return { indexed, skipped, deleted };
  });

  return run();
}
```

**Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All `incrementalIndex` new-file tests PASS

**Step 10: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "add incrementalIndex and deleteFile functions"
```

---

### Task 5: `incrementalIndex` — tests for skipping unchanged files

**Files:**
- Test: `tests/sync/indexer.test.ts`

**Step 11: Write tests for skip behavior**

Add these tests inside the existing `describe('incrementalIndex', ...)` block:

```typescript
  it('skips files with matching mtime', () => {
    writeVaultFile('notes/hello.md', '# Hello');
    incrementalIndex(db, tmpVault);

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('updates mtime but skips re-index when content is unchanged', () => {
    writeVaultFile('notes/hello.md', '# Hello');
    incrementalIndex(db, tmpVault);

    // Touch the file (change mtime without changing content)
    const filePath = join(tmpVault, 'notes/hello.md');
    const future = new Date(Date.now() + 10000);
    utimesSync(filePath, future, future);

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);

    // Mtime should be updated in DB
    const file = db.prepare('SELECT mtime FROM files WHERE path = ?').get('notes/hello.md') as any;
    expect(file.mtime).toBe(future.toISOString());
  });
```

**Step 12: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: PASS (implementation already handles these cases)

**Step 13: Commit**

```bash
git add tests/sync/indexer.test.ts
git commit -m "add tests for incrementalIndex skip behavior"
```

---

### Task 6: `incrementalIndex` — tests for changed files

**Files:**
- Test: `tests/sync/indexer.test.ts`

**Step 14: Write tests for re-indexing changed files**

Add inside the `describe('incrementalIndex', ...)` block:

```typescript
  it('re-indexes files whose content has changed', () => {
    writeVaultFile('notes/hello.md', '# Hello\nOriginal content.');
    incrementalIndex(db, tmpVault);

    writeVaultFile('notes/hello.md', '# Hello\nUpdated content.');

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);

    const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('notes/hello.md') as any;
    expect(node.content_text).toContain('Updated content');
  });

  it('indexes newly added files alongside existing unchanged files', () => {
    writeVaultFile('notes/first.md', '# First');
    incrementalIndex(db, tmpVault);

    writeVaultFile('notes/second.md', '# Second');

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(1);

    const nodes = db.prepare('SELECT id FROM nodes ORDER BY id').all() as any[];
    expect(nodes.map(n => n.id)).toEqual(['notes/first.md', 'notes/second.md']);
  });
```

**Step 15: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: PASS

**Step 16: Commit**

```bash
git add tests/sync/indexer.test.ts
git commit -m "add tests for incrementalIndex change detection"
```

---

### Task 7: `incrementalIndex` — tests for deleted files

**Files:**
- Test: `tests/sync/indexer.test.ts`

**Step 17: Write tests for deletion handling**

Add inside the `describe('incrementalIndex', ...)` block:

```typescript
  it('removes DB entries for files deleted from disk', () => {
    writeVaultFile('notes/keep.md', '# Keep');
    writeVaultFile('notes/remove.md', '# Remove');
    incrementalIndex(db, tmpVault);

    rmSync(join(tmpVault, 'notes/remove.md'));

    const result = incrementalIndex(db, tmpVault);

    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/remove.md')).toBeUndefined();
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('notes/remove.md')).toBeUndefined();
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/keep.md')).toBeDefined();
  });
```

**Step 18: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: PASS

**Step 19: Commit**

```bash
git add tests/sync/indexer.test.ts
git commit -m "add tests for incrementalIndex deletion handling"
```

---

### Task 8: Update module re-exports

**Files:**
- Modify: `src/sync/index.ts`

**Step 20: Add `deleteFile` and `incrementalIndex` to re-exports**

Replace contents of `src/sync/index.ts`:

```typescript
export { indexFile, rebuildIndex, deleteFile, incrementalIndex } from './indexer.js';
```

**Step 21: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 22: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 23: Commit**

```bash
git add src/sync/index.ts
git commit -m "add deleteFile and incrementalIndex to sync module exports"
```
