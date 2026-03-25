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

  // Pre-existing person
  db.transaction(() => {
    seedNode('people/alice.md', '---\ntitle: Alice\ntypes: [person]\nrole: Engineer\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('create-meeting-notes tool', () => {
  it('creates meeting with resolved and created attendees', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'Sprint Planning',
      date: '2026-03-25',
      attendees: ['Alice', 'Bob'],
    });

    expect(data.resolved_attendees).toContain('Alice');
    expect(data.created_attendees).toContain('Bob');
    expect(data.node).toBeDefined();
    expect(data.node.fields.date).toBe('2026-03-25');

    // Bob stub exists with minimal fields
    const bob = db.prepare('SELECT * FROM nodes WHERE title = ?').get('Bob') as any;
    expect(bob).toBeDefined();
    const bobTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(bob.id) as any[];
    expect(bobTypes.map((t: any) => t.schema_type)).toEqual(['person']);
    // No extra fields on stub
    const bobFields = db.prepare('SELECT key FROM fields WHERE node_id = ?')
      .all(bob.id) as any[];
    expect(bobFields.length).toBe(0);
  });

  it('does not create stub for already-existing person', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'One-on-One',
      date: '2026-03-25',
      attendees: ['Alice'],
    });

    expect(data.resolved_attendees).toContain('Alice');
    expect(data.created_attendees.length).toBe(0);

    // Only one Alice
    const alices = db.prepare("SELECT id FROM nodes WHERE LOWER(title) = 'alice'").all();
    expect(alices.length).toBe(1);
  });

  it('includes agenda in body', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'Kickoff',
      date: '2026-03-25',
      attendees: ['Alice'],
      agenda: '## Topics\n\n- Budget review\n- Timeline',
    });

    // Read the file and check body
    const filePath = join(vaultPath, data.node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Budget review');
  });

  it('links project when provided', async () => {
    db.transaction(() => {
      seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\n---\n');
      resolveReferences(db);
    })();

    const { data } = await callTool('create-meeting-notes', {
      title: 'Alpha Sync',
      date: '2026-03-25',
      attendees: ['Alice'],
      project: 'Alpha',
    });

    // Meeting should have project field
    const filePath = join(vaultPath, data.node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('[[Alpha]]');
  });
});
