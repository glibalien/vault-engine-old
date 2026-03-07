import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';

describe('schema changes for reference resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('nodes table has a title column', () => {
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as any[];
    const titleCol = cols.find((c: any) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol.type).toBe('TEXT');
  });

  it('relationships table has a resolved_target_id column', () => {
    const cols = db.prepare("PRAGMA table_info('relationships')").all() as any[];
    const resolvedCol = cols.find((c: any) => c.name === 'resolved_target_id');
    expect(resolvedCol).toBeDefined();
    expect(resolvedCol.type).toBe('TEXT');
  });
});
