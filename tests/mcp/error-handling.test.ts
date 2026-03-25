import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { text, isError: result.isError };
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

describe('error handling consistency', () => {
  it('get-node: returns structured error with code for missing node', async () => {
    const { text, isError } = await callTool('get-node', { node_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeTruthy();
    expect(parsed.code).toBe('NOT_FOUND');
    expect(text).not.toMatch(/at\s+\w+\s+\(/); // No stack traces
  });

  it('update-node: returns structured error for nonexistent node', async () => {
    const { text, isError } = await callTool('update-node', { node_id: 'missing.md', fields: {} });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('project-status: returns structured error for missing project', async () => {
    const { text, isError } = await callTool('project-status', { project_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('extract-tasks: returns structured error for missing source', async () => {
    const { text, isError } = await callTool('extract-tasks', {
      source_node_id: 'missing.md',
      tasks: [{ title: 'Test' }],
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('query-nodes: returns error when no search criteria provided', async () => {
    const { text, isError } = await callTool('query-nodes', {});
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('validate-node: returns error when neither node_id nor types provided', async () => {
    const { text, isError } = await callTool('validate-node', {});
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('validate-node: returns structured error for missing node_id', async () => {
    const { text, isError } = await callTool('validate-node', { node_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('describe-schema: returns structured error for missing schema', async () => {
    const { text, isError } = await callTool('describe-schema', { schema_name: 'nonexistent' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('add-relationship: returns structured error for missing node', async () => {
    const { text, isError } = await callTool('add-relationship', {
      source_id: 'missing.md',
      target: 'Alice',
      rel_type: 'wiki-link',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('remove-relationship: returns structured error for missing node', async () => {
    const { text, isError } = await callTool('remove-relationship', {
      source_id: 'missing.md',
      target: 'Alice',
      rel_type: 'wiki-link',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('rename-node: returns structured error for missing node', async () => {
    const { text, isError } = await callTool('rename-node', {
      node_id: 'missing.md',
      new_title: 'New Title',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('traverse-graph: returns structured error for missing node', async () => {
    const { text, isError } = await callTool('traverse-graph', { node_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('create-node: returns structured error for path conflict', async () => {
    // Create the first node
    await callTool('create-node', { title: 'Duplicate', types: [] });
    // Try to create with the same title
    const { text, isError } = await callTool('create-node', { title: 'Duplicate', types: [] });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('CONFLICT');
  });

  it('rename-node: returns structured error for path conflict', async () => {
    // Create two nodes
    await callTool('create-node', { title: 'NodeA', types: [] });
    await callTool('create-node', { title: 'NodeB', types: [] });
    // Try to rename B to A's path
    const { text, isError } = await callTool('rename-node', {
      node_id: 'NodeB.md',
      new_title: 'NodeA',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('CONFLICT');
  });

  it('update-node: returns structured error when no updates provided', async () => {
    await callTool('create-node', { title: 'Test Node', types: [] });
    const { text, isError } = await callTool('update-node', { node_id: 'test-node.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('update-node: returns structured error for mutually exclusive body params', async () => {
    await callTool('create-node', { title: 'Test Node', types: [] });
    const { text, isError } = await callTool('update-node', {
      node_id: 'test-node.md',
      body: 'new body',
      append_body: 'more body',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('batch-mutate: returns structured error when no operations provided', async () => {
    const { text, isError } = await callTool('batch-mutate', { operations: [] });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('catch blocks produce INTERNAL_ERROR code', async () => {
    // Force an internal error by providing invalid FTS5 syntax
    const { text, isError } = await callTool('query-nodes', { full_text: '***' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('INTERNAL_ERROR');
    expect(text).not.toMatch(/at\s+\w+\s+\(/); // No stack traces
  });

  it('error responses never leak stack traces', async () => {
    // Try several error-producing calls and ensure no stack trace
    const calls = [
      callTool('get-node', { node_id: 'x.md' }),
      callTool('update-node', { node_id: 'x.md', fields: {} }),
      callTool('describe-schema', { schema_name: 'x' }),
    ];
    const results = await Promise.all(calls);
    for (const { text } of results) {
      expect(text).not.toMatch(/at\s+\w+\s+\(/);
    }
  });
});

describe('input validation', () => {
  it('get-node: rejects path traversal in node_id', async () => {
    const { text, isError } = await callTool('get-node', { node_id: '../../../etc/passwd' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('path traversal');
  });

  it('update-node: rejects path traversal in node_id', async () => {
    const { text, isError } = await callTool('update-node', {
      node_id: '../secret.md',
      fields: { status: 'done' },
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('rename-node: rejects path traversal in node_id', async () => {
    const { text, isError } = await callTool('rename-node', {
      node_id: '../escape.md',
      new_title: 'safe',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('rename-node: rejects path traversal in new_path', async () => {
    await callTool('create-node', { title: 'Safe Node', types: [] });
    const { text, isError } = await callTool('rename-node', {
      node_id: 'safe-node.md',
      new_title: 'Still Safe',
      new_path: '../escape.md',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('traverse-graph: rejects path traversal in node_id', async () => {
    const { text, isError } = await callTool('traverse-graph', { node_id: '../../etc/passwd' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('create-node: rejects path traversal in parent_path', async () => {
    const { text, isError } = await callTool('create-node', {
      title: 'Bad Node',
      types: [],
      parent_path: '../escape',
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('get-recent: rejects non-positive limit', async () => {
    const { text, isError } = await callTool('get-recent', { limit: 0 });
    expect(isError).toBe(true);
    // Zod validation errors are caught by the MCP SDK at the schema level
    expect(text).toContain('too_small');
  });

  it('get-recent: rejects negative limit', async () => {
    const { text, isError } = await callTool('get-recent', { limit: -5 });
    expect(isError).toBe(true);
    expect(text).toContain('too_small');
  });

  it('query-nodes: rejects non-positive limit', async () => {
    const { text, isError } = await callTool('query-nodes', {
      schema_type: 'task',
      limit: 0,
    });
    expect(isError).toBe(true);
    expect(text).toContain('too_small');
  });
});
