import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { reconcileOnce, startReconciler } from '../../src/sync/reconciler.js';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function createTempVault(): string {
  return mkdtempSync(join(tmpdir(), 'reconciler-test-'));
}

describe('reconcileOnce', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = createTempVault();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('detects and indexes a new file written directly to disk', () => {
    writeFileSync(
      join(vaultPath, 'new-note.md'),
      '---\ntitle: "New Note"\ntypes: [note]\n---\nSome content',
    );

    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);

    const node = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get('new-note.md') as any;
    expect(node).toBeDefined();
    expect(node.title).toBe('New Note');
  });

  it('detects and removes a deleted file', () => {
    writeFileSync(
      join(vaultPath, 'to-delete.md'),
      '---\ntitle: "Delete Me"\ntypes: [note]\n---\nContent',
    );
    reconcileOnce(db, vaultPath);

    unlinkSync(join(vaultPath, 'to-delete.md'));

    const result = reconcileOnce(db, vaultPath);
    expect(result.deleted).toBe(1);

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('to-delete.md');
    expect(node).toBeUndefined();
  });

  it('skips files that have not changed', () => {
    writeFileSync(
      join(vaultPath, 'stable.md'),
      '---\ntitle: "Stable"\ntypes: [note]\n---\nContent',
    );
    reconcileOnce(db, vaultPath);

    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('handles files in subdirectories', () => {
    mkdirSync(join(vaultPath, 'notes'), { recursive: true });
    writeFileSync(
      join(vaultPath, 'notes', 'deep.md'),
      '---\ntitle: "Deep Note"\ntypes: [note]\n---\nContent',
    );

    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(1);

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('notes/deep.md');
    expect(node).toBeDefined();
  });
});

describe('startReconciler', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = createTempVault();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('periodically detects new files via timer', async () => {
    const handle = startReconciler(db, vaultPath, { intervalMs: 100, firstTickMs: 20 });

    try {
      writeFileSync(
        join(vaultPath, 'timed.md'),
        '---\ntitle: "Timed"\ntypes: [note]\n---\nContent',
      );

      await new Promise(resolve => setTimeout(resolve, 80));

      const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('timed.md');
      expect(node).toBeDefined();
    } finally {
      handle.close();
    }
  });
});
