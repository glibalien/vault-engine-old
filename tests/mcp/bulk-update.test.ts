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
    expect(data.nodes).toHaveLength(2);

    // Verify each node has the updated status
    for (const node of data.nodes) {
      expect(node.fields.status).toBe('in-progress');
    }

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
    expect(data.nodes).toHaveLength(2);

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

  it('errors when types provided with query', async () => {
    seedTasks();

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        query: { schema_type: 'task' },
        fields: { status: 'done' },
        types: ['project'],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('types');
  });

  it('errors when query has no schema_type or filters', async () => {
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
