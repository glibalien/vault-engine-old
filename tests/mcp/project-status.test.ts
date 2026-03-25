import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
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
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\nowner: "[[Alice]]"\n---\n');
    seedNode('people/alice.md', '---\ntitle: Alice\ntypes: [person]\n---\n');
    seedNode('tasks/t1.md', '---\ntitle: Review docs\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nassignee: "[[Alice]]"\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t2.md', '---\ntitle: Fix tests\ntypes: [task]\nstatus: done\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t3.md', '---\ntitle: Deploy\ntypes: [task]\nstatus: in-progress\ndue_date: 2026-04-01\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('project-status tool', () => {
  it('returns project info and task stats', async () => {
    const data = await callTool('project-status', { project_id: 'projects/alpha.md' });
    expect(data.project.id).toBe('projects/alpha.md');
    expect(data.project.title).toBe('Alpha');
    expect(data.total_tasks).toBe(3);
    expect(data.completed_tasks).toBe(1);
    expect(data.completion_pct).toBeCloseTo(33.33);
    expect(data.tasks_by_status.todo.length).toBe(1);
    expect(data.tasks_by_status.done.length).toBe(1);
    expect(data.tasks_by_status['in-progress'].length).toBe(1);
  });

  it('returns error for nonexistent project', async () => {
    const result = await client.callTool({
      name: 'project-status',
      arguments: { project_id: 'nope.md' },
    });
    expect(result.isError).toBe(true);
  });
});
