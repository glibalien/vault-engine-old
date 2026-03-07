// tests/schema/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema, getAllSchemas } from '../../src/schema/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('loadSchemas', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('parses a single schema YAML file', () => {
    loadSchemas(db, fixturesDir);

    const person = getSchema(db, 'person');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('person');
    expect(person!.display_name).toBe('Person');
    expect(person!.icon).toBe('user');
    expect(person!.extends).toBeUndefined();
    expect(person!.ancestors).toEqual([]);
    expect(person!.fields.role).toEqual({ type: 'string' });
    expect(person!.fields.email).toEqual({ type: 'string' });
    expect(person!.fields.tags).toEqual({ type: 'list<string>' });
    expect(person!.serialization?.filename_template).toBe('people/{{title}}.md');
  });
});

describe('inheritance resolution', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-schema-'));
    mkdirSync(join(tmpDir, '.schemas'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves single-level inheritance', () => {
    loadSchemas(db, fixturesDir);

    const workTask = getSchema(db, 'work-task');
    expect(workTask).not.toBeNull();
    expect(workTask!.extends).toBe('task');
    expect(workTask!.ancestors).toEqual(['task']);

    // Inherited fields from task
    expect(workTask!.fields.status).toEqual({
      type: 'enum',
      values: ['todo', 'in-progress', 'blocked', 'done', 'cancelled'],
      default: 'todo',
      required: true,
    });
    expect(workTask!.fields.assignee).toEqual({
      type: 'reference',
      target_schema: 'person',
    });

    // Own fields
    expect(workTask!.fields.project).toEqual({
      type: 'reference',
      target_schema: 'project',
    });
    expect(workTask!.fields.billable).toEqual({
      type: 'boolean',
      default: false,
    });
  });

  it('resolves deep inheritance (A extends B extends C)', () => {
    writeFileSync(join(tmpDir, '.schemas', 'base.yaml'), `
name: base
fields:
  created_by:
    type: string
  tags:
    type: list<string>
`);
    writeFileSync(join(tmpDir, '.schemas', 'task.yaml'), `
name: task
extends: base
fields:
  status:
    type: enum
    values: [todo, done]
  assignee:
    type: reference
`);
    writeFileSync(join(tmpDir, '.schemas', 'work-task.yaml'), `
name: work-task
extends: task
fields:
  project:
    type: reference
  billable:
    type: boolean
`);

    loadSchemas(db, tmpDir);
    const wt = getSchema(db, 'work-task');

    expect(wt!.ancestors).toEqual(['base', 'task']);
    // Has fields from all three levels
    expect(wt!.fields.created_by).toEqual({ type: 'string' });
    expect(wt!.fields.tags).toEqual({ type: 'list<string>' });
    expect(wt!.fields.status).toEqual({ type: 'enum', values: ['todo', 'done'] });
    expect(wt!.fields.assignee).toEqual({ type: 'reference' });
    expect(wt!.fields.project).toEqual({ type: 'reference' });
    expect(wt!.fields.billable).toEqual({ type: 'boolean' });
  });

  it('child field overrides parent field of same name', () => {
    writeFileSync(join(tmpDir, '.schemas', 'parent.yaml'), `
name: parent
fields:
  status:
    type: enum
    values: [open, closed]
    default: open
`);
    writeFileSync(join(tmpDir, '.schemas', 'child.yaml'), `
name: child
extends: parent
fields:
  status:
    type: enum
    values: [draft, review, published]
    default: draft
`);

    loadSchemas(db, tmpDir);
    const child = getSchema(db, 'child');

    expect(child!.fields.status).toEqual({
      type: 'enum',
      values: ['draft', 'review', 'published'],
      default: 'draft',
    });
  });
});
