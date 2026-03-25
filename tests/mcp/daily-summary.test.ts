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

  // Date context: "today" will be 2026-03-25 (Wednesday in ISO week)
  db.transaction(() => {
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\n---\n');
    seedNode('tasks/overdue.md', '---\ntitle: Overdue task\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/today.md', '---\ntitle: Due today\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-25\n---\n');
    seedNode('tasks/this-week.md', '---\ntitle: Due Thursday\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-26\n---\n');
    seedNode('tasks/next-week.md', '---\ntitle: Due next week\ntypes: [task]\nstatus: todo\ndue_date: 2026-04-02\n---\n');
    seedNode('tasks/done.md', '---\ntitle: Done task\ntypes: [task]\nstatus: done\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('daily-summary tool', () => {
  it('returns overdue tasks (past due, not done/cancelled)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.overdue.length).toBe(1);
    expect(data.overdue[0].title).toBe('Overdue task');
  });

  it('returns tasks due today', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.due_today.length).toBe(1);
    expect(data.due_today[0].title).toBe('Due today');
  });

  it('returns tasks due rest of week (not today)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    // 2026-03-25 is Wednesday. ISO week ends Sunday 2026-03-29.
    // Due Thursday (3/26) is in range. Next week (4/2) is not.
    expect(data.due_this_week.length).toBe(1);
    expect(data.due_this_week[0].title).toBe('Due Thursday');
  });

  it('returns recently modified nodes (typed only)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.recently_modified.length).toBeGreaterThan(0);
    // All should have types
    for (const node of data.recently_modified) {
      expect(node.types.length).toBeGreaterThan(0);
    }
  });

  it('returns active projects with task stats', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.active_projects.length).toBe(1);
    expect(data.active_projects[0].title).toBe('Alpha');
    expect(data.active_projects[0].total_tasks).toBe(2); // overdue + done are linked
    expect(data.active_projects[0].completed_tasks).toBe(1);
  });

  it('defaults date to today if not provided', async () => {
    const data = await callTool('daily-summary', {});
    expect(data.date).toBeTruthy();
  });
});
