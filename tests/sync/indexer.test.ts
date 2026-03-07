import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndParse(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    return { parsed: parseFile(relativePath, raw), raw };
  }

  it('inserts a node row with correct fields', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review-vendor-proposals.md');
    indexFile(db, parsed, 'tasks/review-vendor-proposals.md', '2025-03-10T00:00:00.000Z');

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('tasks/review-vendor-proposals.md') as any;
    expect(node).toBeDefined();
    expect(node.file_path).toBe('tasks/review-vendor-proposals.md');
    expect(node.node_type).toBe('file');
    expect(node.content_text).toContain('Review the three vendor proposals');
    expect(node.content_md).toContain('[[Acme Corp Proposal]]');
    expect(node.depth).toBe(0);
    expect(node.parent_id).toBeNull();
  });

  it('inserts node_types for each type', () => {
    const { parsed } = loadAndParse('sample-meeting.md', 'meetings/q1-planning.md');
    indexFile(db, parsed, 'meetings/q1-planning.md', '2025-03-06T00:00:00.000Z');

    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
      .all('meetings/q1-planning.md') as any[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'task']);
  });

  it('inserts no node_types when types array is empty', () => {
    const parsed = parseFile('notes/plain.md', 'Just a plain note.');
    indexFile(db, parsed, 'notes/plain.md', '2025-03-10T00:00:00.000Z');

    const types = db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('notes/plain.md');
    expect(types).toHaveLength(0);
  });
});
