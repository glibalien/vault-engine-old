import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema } from '../../src/schema/loader.js';
import { updateSchema } from '../../src/mcp/update-schema.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';

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

  it('errors when set_metadata value is missing', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'display_name' },
      ]),
    ).toThrow("set_metadata requires 'value'");
  });

  it('errors on unsupported metadata key', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'bogus', value: 'whatever' },
      ]),
    ).toThrow("Unsupported metadata key 'bogus'");
  });

  it('creates a new schema from scratch', () => {
    const result = updateSchema(db, tmpDir, 'project', [
      { action: 'set_metadata', key: 'display_name', value: 'Project' },
      { action: 'set_metadata', key: 'icon', value: 'folder' },
      { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['active', 'completed', 'archived'] } },
      { action: 'add_field', field: 'lead', definition: { type: 'reference', target_schema: 'person' } },
    ]);

    expect(result.operations_applied).toBe(4);
    expect(result.file_path).toBe('.schemas/project.yaml');

    const schema = getSchema(db, 'project');
    expect(schema).not.toBeNull();
    expect(schema!.display_name).toBe('Project');
    expect(schema!.icon).toBe('folder');
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.lead.type).toBe('reference');
  });

  it('validates extends target exists on disk', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'subtask', [
        { action: 'set_metadata', key: 'extends', value: 'nonexistent' },
        { action: 'add_field', field: 'parent', definition: { type: 'reference' } },
      ]),
    ).toThrow(
      "Cannot set extends to 'nonexistent': no schema file found at .schemas/nonexistent.yaml. " +
      'Create the parent schema first, then extend from it.',
    );

    // Schema file should NOT have been created
    expect(getSchema(db, 'subtask')).toBeNull();
  });

  it('validates field types', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' as any } },
      ]),
    ).toThrow("Invalid field type 'invalid' for field 'bad'");
  });

  it('validates enum fields have values', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'category', definition: { type: 'enum' } },
      ]),
    ).toThrow("Enum field 'category' requires a non-empty 'values' array");
  });

  it('rolls back on reload failure', () => {
    // Create a child schema that extends task
    writeFileSync(
      join(tmpDir, '.schemas', 'work-task.yaml'),
      [
        'name: work-task',
        'extends: task',
        'fields:',
        '  department:',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    loadSchemas(db, tmpDir);

    // Read original task.yaml content for comparison
    const originalContent = readFileSync(join(tmpDir, '.schemas', 'task.yaml'), 'utf-8');

    // Set extends to create a cycle: task extends work-task, but work-task extends task
    // This will pass per-file validation (work-task.yaml exists) but fail on loadSchemas
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'extends', value: 'work-task' },
      ]),
    ).toThrow(/Schema reload failed/);

    // File should be rolled back
    const afterContent = readFileSync(join(tmpDir, '.schemas', 'task.yaml'), 'utf-8');
    expect(afterContent).toBe(originalContent);

    // DB should still have the original schemas
    const schema = getSchema(db, 'task');
    expect(schema).not.toBeNull();
    expect(schema!.extends).toBeUndefined();
  });

  it('warns when updating a field inherited from a parent schema', () => {
    // Create work-task that extends task
    writeFileSync(
      join(tmpDir, '.schemas', 'work-task.yaml'),
      [
        'name: work-task',
        'extends: task',
        'fields:',
        '  department:',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    loadSchemas(db, tmpDir);

    // Adding a field that also exists in the parent (override)
    const result = updateSchema(db, tmpDir, 'work-task', [
      { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['open', 'closed'] } },
    ]);

    expect(result.warnings).toContain(
      "Field 'status' is inherited from parent schema 'task'; this add_field creates a local override in 'work-task'.",
    );
    // The field should be added locally
    const schema = getSchema(db, 'work-task');
    expect(schema!.fields.status.values).toEqual(['open', 'closed']);
  });

  it('applies multiple operations atomically', () => {
    // Second operation should fail, so first should not be applied either
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' as any } },
      ]),
    ).toThrow("Invalid field type 'invalid'");

    // due_date should NOT have been added (atomicity)
    const schema = getSchema(db, 'task');
    expect(schema!.fields.due_date).toBeUndefined();
  });
});

describe('update-schema MCP tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-update-schema-mcp-'));

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

    const server = createServer(db, tmpDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function callTool(toolName: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name: toolName, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('adds a field via MCP tool', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
      ],
    });

    expect(result.operations_applied).toBe(1);
    expect(result.file_path).toBe('.schemas/task.yaml');
    expect(result.schema.fields.due_date).toEqual({ type: 'date' });
  });

  it('creates a new schema via MCP tool', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'project',
      operations: [
        { action: 'set_metadata', key: 'display_name', value: 'Project' },
        { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['active', 'done'] } },
      ],
    });

    expect(result.schema.name).toBe('project');
    expect(result.schema.fields.status.type).toBe('enum');
  });

  it('returns error for invalid operations', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' } },
      ],
    });

    expect(result.error).toBeDefined();
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('subsequent describe-schema reflects changes', async () => {
    await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'priority', definition: { type: 'enum', values: ['high', 'medium', 'low'] } },
      ],
    });

    const schema = await callTool('describe-schema', { schema_name: 'task' });
    expect(schema.fields.priority).toBeDefined();
    expect(schema.fields.priority.type).toBe('enum');
  });
});
