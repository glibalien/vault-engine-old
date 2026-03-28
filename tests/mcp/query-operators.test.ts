import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

/**
 * Seed 4 task nodes with varying status, priority (number), and due_date.
 *
 * | file                  | status      | priority | due_date    |
 * |-----------------------|-------------|----------|-------------|
 * | tasks/task-a.md       | todo        | 1        | 2026-03-20  |
 * | tasks/task-b.md       | in-progress | 2        | 2026-03-23  |
 * | tasks/task-c.md       | done        | 3        | 2026-03-25  |
 * | tasks/task-d.md       | todo        | 5        | 2026-03-28  |
 */
function seedTasks(db: Database.Database, vaultPath: string) {
  const tasks = [
    { file: 'tasks/task-a.md', title: 'Task A', status: 'todo', priority: 1, due_date: '2026-03-20' },
    { file: 'tasks/task-b.md', title: 'Task B', status: 'in-progress', priority: 2, due_date: '2026-03-23' },
    { file: 'tasks/task-c.md', title: 'Task C', status: 'done', priority: 3, due_date: '2026-03-25' },
    { file: 'tasks/task-d.md', title: 'Task D', status: 'todo', priority: 5, due_date: '2026-03-28' },
  ];

  for (const t of tasks) {
    const raw = [
      '---',
      `title: ${t.title}`,
      'types: [task]',
      `status: ${t.status}`,
      `priority: ${t.priority}`,
      `due_date: ${t.due_date}`,
      '---',
      '',
      `Body of ${t.title}.`,
    ].join('\n');

    // Write file to disk (needed for vault path consistency)
    const dir = join(vaultPath, 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vaultPath, t.file), raw);

    const parsed = parseFile(t.file, raw);
    indexFile(db, parsed, t.file, '2026-03-25T00:00:00.000Z', raw);
  }
}

describe('query-nodes comparison operators', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-ops-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    seedTasks(db, vaultPath);

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

  function callQuery(args: Record<string, unknown>) {
    return client.callTool({ name: 'query-nodes', arguments: args });
  }

  function parseResult(result: Awaited<ReturnType<typeof callQuery>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('neq: excludes matching values', async () => {
    // status != done → task-a (todo), task-b (in-progress), task-d (todo) = 3
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'neq', value: 'done' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(3);
    const statuses = nodes.map((n: { fields: { status: string } }) => n.fields.status);
    expect(statuses).not.toContain('done');
  });

  it('lt: date before threshold', async () => {
    // due_date < 2026-03-25 → task-a (03-20), task-b (03-23) = 2
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'due_date', operator: 'lt', value: '2026-03-25' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
  });

  it('gte: date on or after threshold', async () => {
    // due_date >= 2026-03-25 → task-c (03-25), task-d (03-28) = 2
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'due_date', operator: 'gte', value: '2026-03-25' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
  });

  it('gt: number greater than', async () => {
    // priority > 3 → task-d (5) = 1
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'priority', operator: 'gt', value: 3 }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fields.priority).toBe('5');
  });

  it('lte: number less than or equal', async () => {
    // priority <= 2 → task-a (1), task-b (2) = 2
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'priority', operator: 'lte', value: 2 }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
  });

  it('contains: substring match', async () => {
    // status contains 'progress' → task-b (in-progress) = 1
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: 'progress' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fields.status).toBe('in-progress');
  });

  it('contains: escapes LIKE wildcards', async () => {
    // status contains '%' → 0 results (no status has a literal %)
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: '%' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(0);
  });

  it('in: matches any of provided values', async () => {
    // status in [todo, done] → task-a (todo), task-c (done), task-d (todo) = 3
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'in', value: ['todo', 'done'] }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(3);
    const statuses = nodes.map((n: { fields: { status: string } }) => n.fields.status);
    expect(statuses).toContain('todo');
    expect(statuses).toContain('done');
  });

  it('combines multiple operators: overdue tasks', async () => {
    // due_date < 2026-03-25 AND status != done → task-a (todo, 03-20), task-b (in-progress, 03-23) = 2
    const result = await callQuery({
      schema_type: 'task',
      filters: [
        { field: 'due_date', operator: 'lt', value: '2026-03-25' },
        { field: 'status', operator: 'neq', value: 'done' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
  });

  it('backwards compatible: eq still works', async () => {
    // status eq todo → task-a, task-d = 2
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.fields.status).toBe('todo');
    }
  });

  it('backwards compatible: omitting operator defaults to eq', async () => {
    // No operator key → should default to eq
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', value: 'todo' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.fields.status).toBe('todo');
    }
  });

  it('in: empty array matches nothing', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'in', value: [] }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(0);
  });

  it('contains: escapes underscore wildcard', async () => {
    // _ is a SQL LIKE wildcard matching any single char — must be escaped
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: '_' }],
    });

    expect(result.isError).toBeFalsy();
    const nodes = parseResult(result);
    expect(nodes).toHaveLength(0);
  });

  it('path_prefix: filters nodes by folder', async () => {
    const result = await callQuery({ path_prefix: 'tasks/' });
    const data = parseResult(result);
    expect(data).toHaveLength(4);
  });

  it('path_prefix: appends trailing slash if missing', async () => {
    const result = await callQuery({ path_prefix: 'tasks' });
    const data = parseResult(result);
    expect(data).toHaveLength(4);
  });

  it('path_prefix: no matches for nonexistent folder', async () => {
    const result = await callQuery({ path_prefix: 'meetings/' });
    const data = parseResult(result);
    expect(data).toHaveLength(0);
  });

  it('since: filters by updated_at', async () => {
    const result = await callQuery({
      schema_type: 'task',
      since: '2020-01-01T00:00:00.000Z',
    });
    const data = parseResult(result);
    expect(data).toHaveLength(4);

    const result2 = await callQuery({
      schema_type: 'task',
      since: '2099-01-01T00:00:00.000Z',
    });
    const data2 = parseResult(result2);
    expect(data2).toHaveLength(0);
  });

  it('since: is sufficient as a standalone filter', async () => {
    const result = await callQuery({
      since: '2020-01-01T00:00:00.000Z',
    });
    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data).toHaveLength(4);
  });
});
