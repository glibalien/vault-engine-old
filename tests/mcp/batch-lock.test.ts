import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWriteLocked } from '../../src/sync/watcher.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
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

describe('batch-scoped write locks', () => {
  it('all locks released after batch completes', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'A' } },
          { op: 'create', params: { title: 'B' } },
          { op: 'create', params: { title: 'C' } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.results).toHaveLength(3);
    // All locks should be released after batch
    for (const r of data.results) {
      expect(isWriteLocked(r.node.id)).toBe(false);
    }
  });

  it('locks released even on batch failure', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'OK Node' } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);
    // No locks should remain after failed batch
    expect(isWriteLocked('OK Node.md')).toBe(false);
    expect(isWriteLocked('nonexistent.md')).toBe(false);
  });

  it('locks released after batch with update operations', async () => {
    const raw = '---\ntitle: Existing\ntypes: [note]\nstatus: draft\n---\nBody text\n';
    db.transaction(() => {
      seedNode('existing.md', raw);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'New Node' } },
          { op: 'update', params: { node_id: 'existing.md', fields: { status: 'published' } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.results).toHaveLength(2);
    // All locks released
    expect(isWriteLocked('New Node.md')).toBe(false);
    expect(isWriteLocked('existing.md')).toBe(false);
  });

  it('locks released after batch with delete operations', async () => {
    const raw = '---\ntitle: To Delete\ntypes: [note]\n---\nBody\n';
    db.transaction(() => {
      seedNode('to-delete.md', raw);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'delete', params: { node_id: 'to-delete.md' } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.results).toHaveLength(1);
    expect(isWriteLocked('to-delete.md')).toBe(false);
  });

  it('locks released after batch with link and unlink operations', async () => {
    const rawA = '---\ntitle: Node A\ntypes: [note]\n---\nBody A\n';
    const rawB = '---\ntitle: Node B\ntypes: [note]\n---\nBody B\n';
    db.transaction(() => {
      seedNode('a.md', rawA);
      seedNode('b.md', rawB);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'link', params: { source_id: 'a.md', target: 'Node B', rel_type: 'wiki-link' } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.results).toHaveLength(1);
    expect(isWriteLocked('a.md')).toBe(false);

    // Now unlink
    const result2 = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'unlink', params: { source_id: 'a.md', target: 'Node B', rel_type: 'wiki-link' } },
        ],
      },
    });
    const data2 = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
    expect(data2.results).toHaveLength(1);
    expect(isWriteLocked('a.md')).toBe(false);
  });

  it('non-batch operations still use immediate lock release', async () => {
    // Single create should acquire and release lock immediately
    const result = await client.callTool({
      name: 'create-node',
      arguments: { title: 'Single Node' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(isWriteLocked(data.node.id)).toBe(false);
  });
});
