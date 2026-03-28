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

function seedWithReferences(db: Database.Database, vaultPath: string) {
  const files = [
    {
      file: 'tasks/task-a.md',
      raw: '---\ntitle: Task A\ntypes: [task]\nassignee: "[[Alice]]"\nstatus: todo\n---\n',
    },
    {
      file: 'tasks/task-b.md',
      raw: '---\ntitle: Task B\ntypes: [task]\nassignee: "[[Bob]]"\nstatus: done\n---\n',
    },
    {
      file: 'meetings/standup.md',
      raw: '---\ntitle: Standup\ntypes: [meeting]\nattendees:\n  - "[[Alice]]"\n  - "[[Bob]]"\n---\n',
    },
  ];
  for (const f of files) {
    const dir = join(vaultPath, f.file, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vaultPath, f.file), f.raw);
    const parsed = parseFile(f.file, f.raw);
    indexFile(db, parsed, f.file, '2026-03-25T00:00:00.000Z', f.raw);
  }
}

describe('query-nodes reference field filtering', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-ref-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    seedWithReferences(db, vaultPath);

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

  it('eq: matches reference field without brackets', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'eq', value: 'Alice' }],
    });
    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  it('eq: still matches non-reference fields normally', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });
    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  it('neq: excludes matching reference field', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'neq', value: 'Alice' }],
    });
    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-b.md');
  });

  it('contains: finds reference inside list field', async () => {
    const result = await callQuery({
      filters: [{ field: 'attendees', operator: 'contains', value: 'Alice' }],
    });
    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('meetings/standup.md');
  });

  it('in: matches reference field values', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'in', value: ['Alice', 'Charlie'] }],
    });
    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  describe('references filter', () => {
    it('outgoing: finds nodes that link to a target', async () => {
      const result = await callQuery({
        references: { target: 'Alice' },
      });

      const data = parseResult(result);
      const ids = data.map((n: { id: string }) => n.id).sort();
      expect(ids).toContain('tasks/task-a.md');
      expect(ids).toContain('meetings/standup.md');
    });

    it('outgoing with rel_type: narrows by relationship type', async () => {
      const result = await callQuery({
        references: { target: 'Alice', rel_type: 'assignee' },
      });

      const data = parseResult(result);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/task-a.md');
    });

    it('incoming: finds nodes that a source links to', async () => {
      const result = await callQuery({
        references: { target: 'tasks/task-a.md', direction: 'incoming' },
      });

      // task-a links to Alice (unresolved, not a node), so nothing returned
      const data = parseResult(result);
      expect(data).toHaveLength(0);
    });

    it('composable with schema_type', async () => {
      const result = await callQuery({
        schema_type: 'task',
        references: { target: 'Alice' },
      });

      const data = parseResult(result);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/task-a.md');
    });
  });
});
