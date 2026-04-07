import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema } from '../../src/schema/loader.js';
import { updateSchema } from '../../src/mcp/update-schema.js';

describe('updateSchema', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-update-schema-'));

    // Create a base task schema
    const schemasDir = join(tmpDir, '.schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'task.yaml'),
      [
        'name: task',
        'display_name: Task',
        'icon: check',
        'fields:',
        '  status:',
        '    type: enum',
        '    values: [todo, in-progress, done]',
        '    required: true',
        '  assignee:',
        '    type: reference',
        '    target_schema: person',
        '',
      ].join('\n'),
      'utf-8',
    );

    loadSchemas(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a new field to an existing schema', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
    ]);

    expect(result.operations_applied).toBe(1);
    expect(result.file_path).toBe('.schemas/task.yaml');
    expect(result.warnings).toEqual([]);

    // Verify schema was reloaded into DB
    const schema = getSchema(db, 'task');
    expect(schema).not.toBeNull();
    expect(schema!.fields.due_date).toEqual({ type: 'date' });
    // Existing fields preserved
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.assignee.type).toBe('reference');
  });

  it('errors when adding a field that already exists', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'status', definition: { type: 'string' } },
      ]),
    ).toThrow("Field 'status' already exists in schema 'task'");
  });

  it('removes a field from a schema', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'remove_field', field: 'assignee' },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    expect(schema!.fields.assignee).toBeUndefined();
    expect(schema!.fields.status).toBeDefined();
  });

  it('errors when removing a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'remove_field', field: 'nonexistent' },
      ]),
    ).toThrow("Field 'nonexistent' does not exist in schema 'task'");
  });

  it('renames a field preserving its definition', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'rename_field', field: 'assignee', new_name: 'owner' },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    expect(schema!.fields.assignee).toBeUndefined();
    expect(schema!.fields.owner).toEqual({ type: 'reference', target_schema: 'person' });
  });

  it('errors when renaming to a name that already exists', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'rename_field', field: 'assignee', new_name: 'status' },
      ]),
    ).toThrow("Cannot rename 'assignee' to 'status': field 'status' already exists in schema 'task'");
  });

  it('errors when renaming a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'rename_field', field: 'nope', new_name: 'whatever' },
      ]),
    ).toThrow("Field 'nope' does not exist in schema 'task'");
  });

  it('updates an existing field definition (merge semantics)', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'update_field', field: 'status', definition: { values: ['todo', 'in-progress', 'done', 'archived'] } },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    // Updated keys merged
    expect(schema!.fields.status.values).toEqual(['todo', 'in-progress', 'done', 'archived']);
    // Existing keys preserved
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.status.required).toBe(true);
  });

  it('errors when updating a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'update_field', field: 'nope', definition: { type: 'string' } },
      ]),
    ).toThrow("Field 'nope' does not exist in schema 'task'");
  });

  it('sets schema metadata', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'set_metadata', key: 'display_name', value: 'Work Task' },
      { action: 'set_metadata', key: 'icon', value: 'briefcase' },
    ]);

    expect(result.operations_applied).toBe(2);
    const schema = getSchema(db, 'task');
    expect(schema!.display_name).toBe('Work Task');
    expect(schema!.icon).toBe('briefcase');
  });

  it('sets serialization metadata', () => {
    updateSchema(db, tmpDir, 'task', [
      { action: 'set_metadata', key: 'serialization', value: { filename_template: 'tasks/work/{{title}}.md' } },
    ]);

    const schema = getSchema(db, 'task');
    expect(schema!.serialization).toEqual({ filename_template: 'tasks/work/{{title}}.md' });
  });

  it('errors on unsupported metadata key', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'bogus', value: 'whatever' },
      ]),
    ).toThrow("Unsupported metadata key 'bogus'");
  });
});
