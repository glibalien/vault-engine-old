import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('delete-node', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-del-'));
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

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('deletes a node and its file', async () => {
    await createTestNode({ title: 'Doomed', types: ['task'], fields: { status: 'todo' } });
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(true);

    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'Doomed.md' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node_id).toBe('Doomed.md');
    expect(data.deleted).toBe(true);
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(false);
    const dbRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Doomed.md');
    expect(dbRow).toBeUndefined();
  });

  it('clears stale resolved_target_id after delete', async () => {
    await createTestNode({ title: 'Target', types: ['person'] });
    await createTestNode({
      title: 'Source',
      types: ['task'],
      fields: { assignee: '[[Target]]' },
    });

    const relBefore = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('Source.md') as { resolved_target_id: string | null } | undefined;
    expect(relBefore?.resolved_target_id).toBe('Target.md');

    await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'Target.md' },
    });

    const relAfter = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('Source.md') as { resolved_target_id: string | null } | undefined;
    expect(relAfter?.resolved_target_id).toBeNull();
  });

  it('returns error for nonexistent node', async () => {
    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'ghost.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
  });

  it('rejects path traversal', async () => {
    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: '../escape.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('path traversal');
  });
});
