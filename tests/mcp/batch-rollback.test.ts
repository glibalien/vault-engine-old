import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { isWriteLocked } from '../../src/sync/watcher.js';

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

describe('batch-mutate rollback safety', () => {
  it('rolls back created files when later operation fails', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'Will Be Rolled Back' } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // File should not exist after rollback
    expect(existsSync(join(vaultPath, 'Will Be Rolled Back.md'))).toBe(false);
    // DB should be clean — transaction rolled back
    expect(db.prepare('SELECT COUNT(*) as c FROM nodes').get()).toEqual({ c: 0 });
    // Locks should be released
    expect(isWriteLocked('Will Be Rolled Back.md')).toBe(false);
  });

  it('restores modified files on rollback', async () => {
    const originalContent = '---\ntitle: Existing\ntypes:\n  - task\nstatus: todo\n---\nOriginal body\n';
    db.transaction(() => {
      seedNode('existing.md', originalContent);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'update', params: { node_id: 'existing.md', fields: { status: 'done' } } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // File should be restored to original content
    const content = readFileSync(join(vaultPath, 'existing.md'), 'utf-8');
    expect(content).toBe(originalContent);

    // DB should reflect original state (transaction rolled back)
    const statusField = db.prepare(
      "SELECT value_text FROM fields WHERE node_id = 'existing.md' AND key = 'status'"
    ).get() as { value_text: string };
    expect(statusField.value_text).toBe('todo');

    // Locks released
    expect(isWriteLocked('existing.md')).toBe(false);
  });

  it('rolls back multiple creates on failure', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'Alpha' } },
          { op: 'create', params: { title: 'Beta' } },
          { op: 'update', params: { node_id: 'does-not-exist.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // Both created files should be rolled back
    expect(existsSync(join(vaultPath, 'Alpha.md'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Beta.md'))).toBe(false);

    // DB clean
    expect(db.prepare('SELECT COUNT(*) as c FROM nodes').get()).toEqual({ c: 0 });

    // Locks released
    expect(isWriteLocked('Alpha.md')).toBe(false);
    expect(isWriteLocked('Beta.md')).toBe(false);
  });

  it('restores deleted files on rollback', async () => {
    const originalContent = '---\ntitle: Will Survive\ntypes:\n  - note\n---\nKeep me\n';
    db.transaction(() => {
      seedNode('survivor.md', originalContent);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'delete', params: { node_id: 'survivor.md' } },
          { op: 'update', params: { node_id: 'ghost.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // File should be restored
    expect(existsSync(join(vaultPath, 'survivor.md'))).toBe(true);
    const content = readFileSync(join(vaultPath, 'survivor.md'), 'utf-8');
    expect(content).toBe(originalContent);

    // DB should still have the node (transaction rolled back)
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('survivor.md');
    expect(node).toBeDefined();

    // Locks released
    expect(isWriteLocked('survivor.md')).toBe(false);
  });

  it('successful batch does not trigger rollback', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'Success A' } },
          { op: 'create', params: { title: 'Success B' } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBeUndefined();
    expect(data.results).toHaveLength(2);

    // Files should exist
    expect(existsSync(join(vaultPath, 'Success A.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Success B.md'))).toBe(true);

    // DB should have both nodes
    const count = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(count.c).toBe(2);

    // Locks released
    expect(isWriteLocked('Success A.md')).toBe(false);
    expect(isWriteLocked('Success B.md')).toBe(false);
  });
});
