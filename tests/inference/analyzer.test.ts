import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { inferFieldType, analyzeVault } from '../../src/inference/analyzer.js';

describe('inferFieldType', () => {
  it('infers reference from value_type reference', () => {
    const rows = [
      { value_type: 'reference', value_text: '[[Alice]]', count: 3 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('reference');
    expect(result.enum_candidate).toBe(false);
  });

  it('infers date from value_type date', () => {
    const rows = [
      { value_type: 'date', value_text: '2025-03-10T00:00:00.000Z', count: 4 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('date');
  });

  it('infers number from value_type number', () => {
    const rows = [
      { value_type: 'number', value_text: '42', count: 2 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('number');
  });

  it('infers boolean from value_type boolean', () => {
    const rows = [
      { value_type: 'boolean', value_text: 'true', count: 1 },
      { value_type: 'boolean', value_text: 'false', count: 2 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('boolean');
  });

  it('infers list<reference> when all list elements contain [[', () => {
    const rows = [
      { value_type: 'list', value_text: '["[[Alice]]","[[Bob]]"]', count: 3 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('list<reference>');
  });

  it('infers list<string> when list elements do not all contain [[', () => {
    const rows = [
      { value_type: 'list', value_text: '["engineering","leadership"]', count: 2 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('list<string>');
  });

  it('infers reference from string value containing [[', () => {
    const rows = [
      { value_type: 'string', value_text: '[[Alice]]', count: 2 },
      { value_type: 'string', value_text: '[[Bob]]', count: 3 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('reference');
    // Must NOT be classified as enum even though distinct=2, ratio=2/5=0.4 < 0.5
    expect(result.enum_candidate).toBe(false);
  });

  it('infers enum when <=20 distinct values and ratio < 0.5', () => {
    const rows = [
      { value_type: 'string', value_text: 'todo', count: 10 },
      { value_type: 'string', value_text: 'done', count: 8 },
      { value_type: 'string', value_text: 'in-progress', count: 5 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('enum');
    expect(result.enum_candidate).toBe(true);
    expect(result.enum_values).toEqual(['todo', 'done', 'in-progress']);
  });

  it('infers string when distinct values exceed 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      value_type: 'string' as const,
      value_text: `value-${i}`,
      count: 2,
    }));
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('string');
    expect(result.enum_candidate).toBe(false);
  });

  it('infers string when ratio >= 0.5 (values rarely repeat)', () => {
    const rows = [
      { value_type: 'string', value_text: 'foo', count: 1 },
      { value_type: 'string', value_text: 'bar', count: 1 },
      { value_type: 'string', value_text: 'baz', count: 1 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('string');
    expect(result.enum_candidate).toBe(false);
  });

  it('uses most frequent value_type when mixed', () => {
    const rows = [
      { value_type: 'string', value_text: 'hello', count: 10 },
      { value_type: 'number', value_text: '42', count: 2 },
    ];
    const result = inferFieldType(rows);
    expect(result.inferred_type).toBe('string');
  });

  it('reports sample_values up to 10', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      value_type: 'string' as const,
      value_text: `val-${i}`,
      count: 1,
    }));
    const result = inferFieldType(rows);
    expect(result.sample_values.length).toBe(10);
  });
});

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('analyzeVault', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndIndex(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('returns type analysis for all indexed types', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db);
    expect(result.types.length).toBeGreaterThanOrEqual(2);

    const task = result.types.find(t => t.name === 'task');
    const person = result.types.find(t => t.name === 'person');
    expect(task).toBeDefined();
    expect(person).toBeDefined();
    expect(task!.node_count).toBe(1);
    expect(person!.node_count).toBe(1);
    expect(task!.has_existing_schema).toBe(false);
    expect(person!.has_existing_schema).toBe(false);
  });

  it('filters by types param', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db, ['task']);
    expect(result.types.length).toBe(1);
    expect(result.types[0].name).toBe('task');
  });

  it('infers correct field types from indexed data', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    expect(task).toBeDefined();

    const assignee = task.inferred_fields.find(f => f.key === 'assignee');
    expect(assignee).toBeDefined();
    expect(assignee!.inferred_type).toBe('reference');

    const dueDate = task.inferred_fields.find(f => f.key === 'due_date');
    expect(dueDate).toBeDefined();
    expect(dueDate!.inferred_type).toBe('date');
  });

  it('computes frequency as fraction of nodes with the field', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-meeting.md', 'meetings/q1-planning.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    expect(task).toBeDefined();
    // sample-meeting.md has types: [meeting, task], so task has node_count=2
    expect(task.node_count).toBe(2);

    // 'source' field only exists on sample-task.md (review.md), not on sample-meeting.md
    const source = task.inferred_fields.find(f => f.key === 'source');
    expect(source).toBeDefined();
    expect(source!.frequency).toBe(0.5);
  });

  it('detects list<reference> for attendees field', () => {
    loadAndIndex('sample-meeting.md', 'meetings/q1-planning.md');

    const result = analyzeVault(db);
    const meeting = result.types.find(t => t.name === 'meeting')!;
    expect(meeting).toBeDefined();

    const attendees = meeting.inferred_fields.find(f => f.key === 'attendees');
    expect(attendees).toBeDefined();
    expect(attendees!.inferred_type).toBe('list<reference>');
  });

  it('detects list<string> for tags field', () => {
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db);
    const person = result.types.find(t => t.name === 'person')!;
    expect(person).toBeDefined();

    const tags = person.inferred_fields.find(f => f.key === 'tags');
    expect(tags).toBeDefined();
    expect(tags!.inferred_type).toBe('list<string>');
  });

  it('detects discrepancies against existing schemas', () => {
    loadSchemas(db, fixturesDir);
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    expect(task).toBeDefined();
    expect(task.has_existing_schema).toBe(true);

    // 'source' field is in the data but not in the schema
    const sourceDiscrepancy = task.discrepancies.find(d => d.field === 'source');
    expect(sourceDiscrepancy).toBeDefined();
    expect(sourceDiscrepancy!.issue).toContain('not in schema');
  });

  it('detects shared fields across types', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-meeting.md', 'meetings/q1-planning.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    const meeting = result.types.find(t => t.name === 'meeting')!;
    expect(task).toBeDefined();
    expect(meeting).toBeDefined();

    // 'status' exists in both task and meeting types
    expect(task.shared_fields).toContain('status');
    expect(meeting.shared_fields).toContain('status');
  });
});
