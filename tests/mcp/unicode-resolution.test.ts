// tests/mcp/unicode-resolution.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function parseResult(result: Awaited<ReturnType<typeof callTool>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe('Unicode resolution integration', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = mkdtempSync(join(tmpdir(), 'unicode-test-'));

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it('get-node resolves curly apostrophe ID with straight apostrophe', async () => {
    const raw = '---\ntitle: "It\u2019s a Test"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('It\u2019s a Test.md', raw);
    indexFile(db, parsed, 'It\u2019s a Test.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: "It's a Test.md" });
    const data = parseResult(result);
    expect(data.id).toBe('It\u2019s a Test.md');
    expect(data.title).toBe('It\u2019s a Test');
  });

  it('get-node resolves curly apostrophe title with straight apostrophe query', async () => {
    const raw = '---\ntitle: "It\u2019s Complex"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/complex.md', raw);
    indexFile(db, parsed, 'notes/complex.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { title: "It's Complex" });
    const data = parseResult(result);
    expect(data.id).toBe('notes/complex.md');
  });

  it('get-node resolves smart double quotes in ID', async () => {
    const raw = '---\ntitle: "\u201CQuoted\u201D"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('\u201CQuoted\u201D.md', raw);
    indexFile(db, parsed, '\u201CQuoted\u201D.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: '"Quoted".md' });
    const data = parseResult(result);
    expect(data.id).toBe('\u201CQuoted\u201D.md');
  });

  it('get-node resolves em-dash in title', async () => {
    const raw = '---\ntitle: "A\u2014B"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/ab.md', raw);
    indexFile(db, parsed, 'notes/ab.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { title: 'A-B' });
    const data = parseResult(result);
    expect(data.id).toBe('notes/ab.md');
  });

  it('update-node works with typographically-normalized ID', async () => {
    const raw = '---\ntitle: "It\u2019s Editable"\ntypes: [note]\nstatus: draft\n---\nContent';
    const parsed = parseFile('It\u2019s Editable.md', raw);
    indexFile(db, parsed, 'It\u2019s Editable.md', '2025-03-10T00:00:00.000Z', raw);

    // Write the file to disk so update-node can read it
    writeFileSync(join(vaultPath, 'It\u2019s Editable.md'), raw);

    const result = await callTool(client, 'update-node', {
      node_id: "It's Editable.md",
      fields: { status: 'published' },
    });
    expect(result.isError).toBeFalsy();
  });

  it('delete-node works with typographically-normalized ID', async () => {
    const raw = '---\ntitle: "It\u2019s Deletable"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('It\u2019s Deletable.md', raw);
    indexFile(db, parsed, 'It\u2019s Deletable.md', '2025-03-10T00:00:00.000Z', raw);

    writeFileSync(join(vaultPath, 'It\u2019s Deletable.md'), raw);

    const result = await callTool(client, 'delete-node', {
      node_id: "It's Deletable.md",
    });
    expect(result.isError).toBeFalsy();
  });

  it('NFC decomposed ID resolves to NFC composed stored ID', async () => {
    const raw = '---\ntitle: "Caf\u00E9"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('Caf\u00E9.md', raw);
    indexFile(db, parsed, 'Caf\u00E9.md', '2025-03-10T00:00:00.000Z', raw);

    // Decomposed form
    const result = await callTool(client, 'get-node', { node_id: 'Caf\u0065\u0301.md' });
    const data = parseResult(result);
    expect(data.id).toBe('Caf\u00E9.md');
  });

  it('exact match still works without normalization overhead', async () => {
    const raw = '---\ntitle: "Simple"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('simple.md', raw);
    indexFile(db, parsed, 'simple.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: 'simple.md' });
    const data = parseResult(result);
    expect(data.id).toBe('simple.md');
  });
});

describe('since and modified_since filters', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = mkdtempSync(join(tmpdir(), 'since-test-'));

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it('since filters on indexed_at (engine index time)', async () => {
    const raw = '---\ntitle: "Recent"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('recent.md', raw);
    indexFile(db, parsed, 'recent.md', '2020-01-01T00:00:00.000Z', raw);

    // Read actual indexed_at from DB to avoid sub-second timing issues
    // (SQLite datetime('now') has only second-level precision)
    const row = db.prepare('SELECT indexed_at FROM nodes WHERE id = ?').get('recent.md') as { indexed_at: string };
    const indexedAt = new Date(row.indexed_at + 'Z');

    // since = 1 second before indexing → should find it
    const beforeIndex = new Date(indexedAt.getTime() - 1000).toISOString();
    const result1 = await callTool(client, 'query-nodes', {
      since: beforeIndex,
      schema_type: 'note',
    });
    const data1 = parseResult(result1);
    expect(data1.length).toBe(1);
    expect(data1[0].id).toBe('recent.md');

    // since = 1 second after indexing → should NOT find it
    const afterIndex = new Date(indexedAt.getTime() + 1000).toISOString();
    const result2 = await callTool(client, 'query-nodes', {
      since: afterIndex,
      schema_type: 'note',
    });
    const data2 = parseResult(result2);
    expect(data2.length).toBe(0);
  });

  it('modified_since filters on file_mtime (file modification time)', async () => {
    const raw = '---\ntitle: "Old File"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('old.md', raw);
    // File mtime is in the past
    indexFile(db, parsed, 'old.md', '2020-01-01T00:00:00.000Z', raw);

    // modified_since after file mtime → should NOT find it
    const result = await callTool(client, 'query-nodes', {
      modified_since: '2021-01-01T00:00:00.000Z',
      schema_type: 'note',
    });
    const data = parseResult(result);
    expect(data.length).toBe(0);

    // modified_since before file mtime → should find it
    const result2 = await callTool(client, 'query-nodes', {
      modified_since: '2019-01-01T00:00:00.000Z',
      schema_type: 'note',
    });
    const data2 = parseResult(result2);
    expect(data2.length).toBe(1);
  });
});
