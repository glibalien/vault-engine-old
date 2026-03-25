import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    data: JSON.parse((result.content as Array<{ text: string }>)[0].text),
    isError: result.isError,
  };
}

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

  db.transaction(() => {
    seedNode('meetings/standup.md', '---\ntitle: Daily Standup\ntypes: [meeting]\ndate: 2026-03-25\n---\n## Action Items\n\n- Review the PR\n- Fix the login bug\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('extract-tasks tool', () => {
  it('creates task nodes linked back to source', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [
        { title: 'Review the PR', assignee: '[[Alice]]', status: 'todo' },
        { title: 'Fix the login bug', priority: 'high' },
      ],
    });

    expect(data.tasks.length).toBe(2);
    expect(data.tasks[0].node.title).toBe('Review the PR');
    expect(data.tasks[1].node.title).toBe('Fix the login bug');

    // Each task should have source field pointing back
    for (const task of data.tasks) {
      const filePath = join(vaultPath, task.node.id);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('[[Daily Standup]]');
    }
  });

  it('returns error for nonexistent source node', async () => {
    const { data, isError } = await callTool('extract-tasks', {
      source_node_id: 'nope.md',
      tasks: [{ title: 'Something' }],
    });
    expect(isError).toBe(true);
  });

  it('applies default status of todo', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [{ title: 'Some task' }],
    });

    const filePath = join(vaultPath, data.tasks[0].node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: todo');
  });

  it('passes through custom fields', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [{ title: 'Tagged task', fields: { department: 'engineering' } }],
    });

    const filePath = join(vaultPath, data.tasks[0].node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('department: engineering');
  });
});
