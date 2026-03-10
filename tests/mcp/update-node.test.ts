import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('update-node', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

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

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'create-node',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when no updates provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: { node_id: 'Target.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('No updates provided');
  });

  it('returns error when both body and append_body provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Target.md',
        body: 'new body',
        append_body: 'more content',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('body');
    expect(text).toContain('append_body');
    expect(text).toContain('mutually exclusive');
  });

  it('returns error when node does not exist', async () => {
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'nonexistent.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
    expect(text).toContain('nonexistent.md');
  });

  it('returns error when file is missing on disk but exists in DB', async () => {
    await createTestNode({ title: 'Ghost' });
    // Delete the file but leave the DB entry
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Ghost.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File not found on disk');
    expect(text).toContain('out of sync');
  });
});
