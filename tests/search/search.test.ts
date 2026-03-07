// tests/search/search.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { search } from '../../src/search/search.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function indexFixture(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('returns matching nodes for a basic query', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].filePath).toBe('tasks/review.md');
    expect(results[0].nodeType).toBe('file');
    expect(results[0].contentText).toContain('vendor');
    expect(typeof results[0].rank).toBe('number');
  });

  it('returns empty array when nothing matches', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'nonexistentterm' });

    expect(results).toEqual([]);
  });

  it('filters results by schemaType', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    indexFixture('sample-person.md', 'people/alice.md');
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    // "budget" appears in meeting body, not in task or person
    const allResults = search(db, { query: 'budget' });
    expect(allResults.length).toBeGreaterThan(0);

    const filtered = search(db, { query: 'budget', schemaType: 'person' });
    expect(filtered).toEqual([]);

    const meetingResults = search(db, { query: 'budget', schemaType: 'meeting' });
    expect(meetingResults).toHaveLength(1);
    expect(meetingResults[0].id).toBe('meetings/q1.md');
  });

  it('returns empty array when schemaType has no matching nodes', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor', schemaType: 'person' });

    expect(results).toEqual([]);
  });
});
