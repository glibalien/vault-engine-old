import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

describe('update-node query mode (bulk update)', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultPath);
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
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function seedTasks() {
    const tasks = [
      { file: 'tasks/task-a.md', title: 'Task A', status: 'todo', priority: 'low' },
      { file: 'tasks/task-b.md', title: 'Task B', status: 'todo', priority: 'high' },
      { file: 'tasks/task-c.md', title: 'Task C', status: 'done', priority: 'low' },
    ];
    mkdirSync(join(vaultPath, 'tasks'), { recursive: true });
    db.transaction(() => {
      for (const t of tasks) {
        const raw = `---\ntitle: ${t.title}\ntypes: [task]\nstatus: ${t.status}\npriority: ${t.priority}\n---\n`;
        writeFileSync(join(vaultPath, t.file), raw);
        const parsed = parseFile(t.file, raw);
        indexFile(db, parsed, t.file, '2026-03-25T00:00:00.000Z', raw);
      }
    })();
  }

  it('updates all matching nodes', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {
          schema_type: 'task',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
        fields: { status: 'in-progress' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(2);
    expect(data.node_ids).toHaveLength(2);

    // Verify files on disk
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    const contentB = readFileSync(join(vaultPath, 'tasks/task-b.md'), 'utf-8');
    expect(contentA).toContain('status: in-progress');
    expect(contentB).toContain('status: in-progress');

    // Task C should be unchanged
    const contentC = readFileSync(join(vaultPath, 'tasks/task-c.md'), 'utf-8');
    expect(contentC).toContain('status: done');
  });

  it('dry_run returns matches without writing', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {
          schema_type: 'task',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
        fields: { status: 'in-progress' },
        dry_run: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.matched).toBe(2);
    expect(data.node_ids).toHaveLength(2);

    // Files should NOT be changed
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    const contentB = readFileSync(join(vaultPath, 'tasks/task-b.md'), 'utf-8');
    expect(contentA).toContain('status: todo');
    expect(contentB).toContain('status: todo');
  });

  it('errors when both node_id and query provided', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/task-a.md',
        query: {
          schema_type: 'task',
        },
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('mutually exclusive');
  });

  it('errors when body provided with query', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: { status: 'done' },
        body: 'new body',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('body');
  });

  it('errors when append_body provided with query', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: { status: 'done' },
        append_body: 'appended text',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('append_body');
  });

  it('errors when title provided with query', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: { status: 'done' },
        title: 'New Title',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('title');
  });

  it('updates types on all matching nodes', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {
          schema_type: 'task',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
        types: ['task', 'daily-note'],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(2);

    // Verify files on disk
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentA).toContain('daily-note');

    // Task C (status: done) should be unchanged
    const contentC = readFileSync(join(vaultPath, 'tasks/task-c.md'), 'utf-8');
    expect(contentC).not.toContain('daily-note');
  });

  it('updates types without fields', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        types: ['daily-note'],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(3);

    // Verify all files on disk
    for (const file of ['tasks/task-a.md', 'tasks/task-b.md', 'tasks/task-c.md']) {
      const content = readFileSync(join(vaultPath, file), 'utf-8');
      expect(content).toContain('daily-note');
    }
  });

  it('uses path_prefix to scope query', async () => {
    seedTasks();
    // Add a non-task file outside the tasks/ folder
    const raw = '---\ntitle: Note\ntypes: [task]\nstatus: todo\n---\n';
    writeFileSync(join(vaultPath, 'note.md'), raw);
    db.transaction(() => {
      const parsed = parseFile('note.md', raw);
      indexFile(db, parsed, 'note.md', '2026-03-25T00:00:00.000Z', raw);
    })();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {
          schema_type: 'task',
          path_prefix: 'tasks/',
        },
        fields: { status: 'archived' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(3);
    expect(data.node_ids).toHaveLength(3);

    // Root-level note should be unchanged
    const noteContent = readFileSync(join(vaultPath, 'note.md'), 'utf-8');
    expect(noteContent).toContain('status: todo');
  });

  it('uses path_prefix as sole query filter', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { path_prefix: 'tasks/' },
        fields: { reviewed: 'true' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(3);
    expect(data.node_ids).toHaveLength(3);
  });

  it('dry_run works with types', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { path_prefix: 'tasks/' },
        types: ['daily-note'],
        dry_run: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.matched).toBe(3);
    expect(data.node_ids).toHaveLength(3);

    // Files should NOT be changed
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentA).not.toContain('daily-note');
  });

  it('respects limit on query object', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task', limit: 2 },
        fields: { reviewed: 'true' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(2);
    expect(data.node_ids).toHaveLength(2);
  });

  it('updates all matches when no limit specified', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: { reviewed: 'true' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(3);
    expect(data.node_ids).toHaveLength(3);
  });

  it('errors when query has no schema_type, filters, or path_prefix', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {},
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('schema_type');
    expect(text).toContain('filters');
    expect(text).toContain('path_prefix');
  });

  it('errors when dry_run used with node_id', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/task-a.md',
        fields: { status: 'done' },
        dry_run: true,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('dry_run');
  });

  it('errors when fields is empty object in query mode', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: {},
      },
    });

    expect(result.isError).toBe(true);
  });

  it('rolls back all files on error', async () => {
    seedTasks();

    // Save original file contents
    const originalA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    const originalB = readFileSync(join(vaultPath, 'tasks/task-b.md'), 'utf-8');

    // Delete one of the matching files to cause an error mid-batch
    unlinkSync(join(vaultPath, 'tasks/task-b.md'));

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: {
          schema_type: 'task',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
        fields: { status: 'in-progress' },
      },
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // Task A should be restored to its original state (if it was modified before the error)
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentA).toBe(originalA);
  });
});
