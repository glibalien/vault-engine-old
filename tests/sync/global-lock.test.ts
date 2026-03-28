import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import {
  watchVault,
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  isGlobalWriteLocked,
} from '../../src/sync/watcher.js';

describe('global write lock', () => {
  afterEach(() => {
    if (isGlobalWriteLocked()) releaseGlobalWriteLock();
  });

  it('tracks lock state correctly', () => {
    expect(isGlobalWriteLocked()).toBe(false);
    acquireGlobalWriteLock();
    expect(isGlobalWriteLocked()).toBe(true);
    releaseGlobalWriteLock();
    expect(isGlobalWriteLocked()).toBe(false);
  });

  it('watcher skips file events when global lock is held', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-glock-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const watcher = watchVault(db, vaultPath, { debounceMs: 50 });
    await watcher.ready;

    acquireGlobalWriteLock();

    writeFileSync(
      join(vaultPath, 'locked.md'),
      '---\ntitle: Locked\ntypes: [note]\n---\n\nBody\n',
    );

    // Wait longer than debounce
    await new Promise(r => setTimeout(r, 200));

    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('locked.md');
    expect(row).toBeUndefined();

    releaseGlobalWriteLock();
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('watcher processes events after global lock is released', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-glock-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const watcher = watchVault(db, vaultPath, { debounceMs: 50 });
    await watcher.ready;

    expect(isGlobalWriteLocked()).toBe(false);
    writeFileSync(
      join(vaultPath, 'normal.md'),
      '---\ntitle: Normal\ntypes: [note]\n---\n\nBody\n',
    );

    // Wait for watcher to process
    await new Promise(r => setTimeout(r, 400));

    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('normal.md');
    expect(row).toBeDefined();

    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });
});
