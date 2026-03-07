import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('openDatabase', () => {
  const dbs: { close(): void }[] = [];
  const tmps: string[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
    tmps.length = 0;
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const row = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(row[0].foreign_keys).toBe(1);
  });

  it('sets busy timeout', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const row = db.pragma('busy_timeout') as { timeout: number }[];
    expect(row[0].timeout).toBe(5000);
  });

  it('enables WAL mode on file-based database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    tmps.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    dbs.push(db);
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0].journal_mode).toBe('wal');
  });

  it('creates parent directories if they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    tmps.push(dir);
    const db = openDatabase(join(dir, 'sub', 'dir', 'test.db'));
    dbs.push(db);
    const row = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(row[0].foreign_keys).toBe(1);
  });
});
