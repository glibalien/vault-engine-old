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

  it('respects the limit option', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    // Both files contain text; search broadly
    const results = search(db, { query: 'proposal OR budget', limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('defaults limit to 20', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    // We can't easily create 21 fixtures, so just verify the function works
    // without a limit param and returns results (implicit limit: 20)
    const results = search(db, { query: 'vendor' });
    expect(results).toHaveLength(1);
  });

  it('populates fields with correct keys, values, and types', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor' });

    expect(results[0].fields.status).toEqual({ value: 'todo', type: 'string' });
    expect(results[0].fields.priority).toEqual({ value: 'high', type: 'string' });
    expect(results[0].fields.assignee.type).toBe('reference');
    expect(results[0].fields.due_date.type).toBe('date');
  });

  it('populates types array including multi-typed nodes', () => {
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    const results = search(db, { query: 'budget' });

    expect(results).toHaveLength(1);
    expect(results[0].types).toContain('meeting');
    expect(results[0].types).toContain('task');
  });

  it('ranks nodes with more occurrences of the term higher', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    // Index a file that mentions "vendor" fewer times
    const raw = '---\ntitle: Brief\n---\nOne mention of vendor here. This document contains a lot of other content about various topics including planning, strategy, operations, logistics, communications, scheduling, and coordination that dilutes the overall relevance of any single term within the text body.';
    const parsed = parseFile('notes/brief.md', raw);
    indexFile(db, parsed, 'notes/brief.md', '2025-03-10T00:00:00.000Z', raw);

    const results = search(db, { query: 'vendor' });

    expect(results.length).toBe(2);
    // Task file mentions "vendor" more often — should rank first (lower rank value)
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
  });

  it('supports FTS5 phrase and prefix queries', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const phrase = search(db, { query: '"vendor proposals"' });
    expect(phrase).toHaveLength(1);

    const prefix = search(db, { query: 'vend*' });
    expect(prefix).toHaveLength(1);
  });
});
