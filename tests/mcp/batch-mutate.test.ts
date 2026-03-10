import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('batch-mutate', () => {
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
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  async function callBatch(operations: Array<{ op: string; params: Record<string, unknown> }>) {
    return client.callTool({ name: 'batch-mutate', arguments: { operations } });
  }

  function parseResult(result: Awaited<ReturnType<typeof callBatch>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  // Basic operations

  it('returns error when no operations provided', async () => {
    const result = await callBatch([]);
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('No operations');
  });

  it('executes a single create operation', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Batch Created', fields: { status: 'todo' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].op).toBe('create');
    expect(data.results[0].node.id).toBe('Batch Created.md');
    expect(existsSync(join(vaultPath, 'Batch Created.md'))).toBe(true);
  });

  it('executes a single update operation', async () => {
    await createTestNode({ title: 'Existing', fields: { status: 'todo' } });

    const result = await callBatch([
      { op: 'update', params: { node_id: 'Existing.md', fields: { status: 'done' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results[0].node.fields.status).toBe('done');
  });

  it('executes a single delete operation', async () => {
    await createTestNode({ title: 'Doomed' });

    const result = await callBatch([
      { op: 'delete', params: { node_id: 'Doomed.md' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results[0].op).toBe('delete');
    expect(data.results[0].node_id).toBe('Doomed.md');
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(false);

    // DB should be cleaned up
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Doomed.md');
    expect(node).toBeUndefined();
  });

  it('executes a single link operation', async () => {
    await createTestNode({ title: 'Source', body: 'Some text.' });

    const result = await callBatch([
      { op: 'link', params: { source_id: 'Source.md', target: 'Alice', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Source.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
  });

  it('executes a single unlink operation', async () => {
    await createTestNode({ title: 'Linked', body: 'See [[Alice]] here.' });

    const result = await callBatch([
      { op: 'unlink', params: { source_id: 'Linked.md', target: 'Alice', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Linked.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  // Sequential execution — later ops see earlier ops' results

  it('create then link: link references freshly created node', async () => {
    await createTestNode({ title: 'Existing Node', body: 'Content here.' });

    const result = await callBatch([
      { op: 'create', params: { title: 'New Target' } },
      { op: 'link', params: { source_id: 'Existing Node.md', target: 'New Target', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].op).toBe('create');
    expect(data.results[1].op).toBe('link');

    const content = readFileSync(join(vaultPath, 'Existing Node.md'), 'utf-8');
    expect(content).toContain('[[New Target]]');
  });

  it('create then update the created node', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Fresh Node', fields: { status: 'todo' } } },
      { op: 'update', params: { node_id: 'Fresh Node.md', fields: { status: 'done' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(data.results[1].node.fields.status).toBe('done');
  });

  // Multiple creates

  it('creates multiple nodes in one batch', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Node A' } },
      { op: 'create', params: { title: 'Node B' } },
      { op: 'create', params: { title: 'Node C' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(3);
    expect(existsSync(join(vaultPath, 'Node A.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Node B.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Node C.md'))).toBe(true);
  });

  // Create then delete in same batch

  it('creates then deletes a node in the same batch', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Ephemeral' } },
      { op: 'delete', params: { node_id: 'Ephemeral.md' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(existsSync(join(vaultPath, 'Ephemeral.md'))).toBe(false);

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Ephemeral.md');
    expect(node).toBeUndefined();
  });

  // Rollback on failure

  it('rolls back all changes when a middle operation fails', async () => {
    await createTestNode({ title: 'Before Batch', fields: { status: 'original' } });
    const contentBefore = readFileSync(join(vaultPath, 'Before Batch.md'), 'utf-8');

    const result = await callBatch([
      { op: 'create', params: { title: 'Will Be Rolled Back' } },
      { op: 'update', params: { node_id: 'Before Batch.md', fields: { status: 'changed' } } },
      { op: 'update', params: { node_id: 'nonexistent.md', fields: { status: 'boom' } } }, // fails
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 2');
    expect(data.error).toContain('update');
    expect(data.rolled_back).toBe(true);

    // Created file should be deleted
    expect(existsSync(join(vaultPath, 'Will Be Rolled Back.md'))).toBe(false);

    // Modified file should be restored
    const contentAfter = readFileSync(join(vaultPath, 'Before Batch.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    // DB should be rolled back — no node created
    const created = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Will Be Rolled Back.md');
    expect(created).toBeUndefined();

    // DB should be rolled back — original fields preserved
    const field = db.prepare('SELECT value_text FROM fields WHERE node_id = ? AND key = ?').get('Before Batch.md', 'status') as { value_text: string };
    expect(field.value_text).toBe('original');
  });

  it('rolls back deleted file on failure', async () => {
    await createTestNode({ title: 'Survivor' });
    const contentBefore = readFileSync(join(vaultPath, 'Survivor.md'), 'utf-8');

    const result = await callBatch([
      { op: 'delete', params: { node_id: 'Survivor.md' } },
      { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } }, // fails
    ]);

    expect(result.isError).toBe(true);

    // File should be restored
    expect(existsSync(join(vaultPath, 'Survivor.md'))).toBe(true);
    const contentAfter = readFileSync(join(vaultPath, 'Survivor.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    // DB should be rolled back — node still exists
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Survivor.md');
    expect(node).toBeDefined();
  });

  // Reference resolution

  it('resolves references once at end of batch', async () => {
    // Create target and source in same batch, references should resolve
    const result = await callBatch([
      { op: 'create', params: { title: 'Target Node' } },
      { op: 'create', params: { title: 'Source Node', body: '[[Target Node]]' } },
    ]);

    expect(result.isError).toBeFalsy();

    const rels = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('Source Node.md') as Array<{ resolved_target_id: string | null }>;

    expect(rels).toHaveLength(1);
    expect(rels[0].resolved_target_id).toBe('Target Node.md');
  });

  it('returns error when first operation fails with nothing to roll back', async () => {
    const result = await callBatch([
      { op: 'delete', params: { node_id: 'nonexistent.md' } },
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 0');
    expect(data.rolled_back).toBe(true);
  });

  // Error format

  it('identifies failed operation by index and type', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'OK' } },
      { op: 'delete', params: { node_id: 'ghost.md' } },
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 1');
    expect(data.error).toContain('delete');
  });

  // Warnings collection

  it('collects warnings from individual operations', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await callBatch([
      { op: 'create', params: { title: 'Bad Task', types: ['task'], fields: { priority: 'extreme' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.warnings.length).toBeGreaterThan(0);
  });
});
