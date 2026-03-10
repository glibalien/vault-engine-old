import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('remove-relationship', () => {
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

  it('returns error when source node does not exist', async () => {
    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'nonexistent.md', target: 'Alice', rel_type: 'wiki-link' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('Node not found');
  });

  it('returns error when file is missing on disk', async () => {
    await createTestNode({ title: 'Ghost' });
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Ghost.md', target: 'Alice', rel_type: 'wiki-link' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('File not found on disk');
  });

  it('removes body wiki-link when rel_type is wiki-link', async () => {
    await createTestNode({
      title: 'Note',
      body: 'See [[Alice]] for details.',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Note.md', target: 'Alice', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Note.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  it('returns current node when body link does not exist (no-op)', async () => {
    await createTestNode({
      title: 'No Link',
      body: 'No wiki-links here.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'No Link.md'), 'utf-8');

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'No Link.md', target: 'Alice', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'No Link.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('removes scalar reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Assigned Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Assigned Task.md', target: 'Alice', rel_type: 'assignee' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Assigned Task.md'), 'utf-8');
    expect(content).not.toContain('assignee');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('status: todo');
  });

  it('no-op when scalar field does not match target', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Other Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'tasks/Other Task.md'), 'utf-8');

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Other Task.md', target: 'Bob', rel_type: 'assignee' },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'tasks/Other Task.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('removes item from list reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Team Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [
        { target: 'Alice', rel_type: 'attendees' },
        { target: 'Bob', rel_type: 'attendees' },
      ],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Team Meeting.md', target: 'Alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Team Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  it('removes last item from list leaving empty array', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Solo Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Solo Meeting.md', target: 'Alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Solo Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('attendees: []');
  });

  it('matches case-insensitively when removing from list', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Case Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Case Meeting.md', target: 'alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  it('removes from array field without schema', async () => {
    await createTestNode({
      title: 'Tagless Node',
      fields: { refs: ['[[Alice]]', '[[Bob]]'] },
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Tagless Node.md', target: 'Alice', rel_type: 'refs' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Tagless Node.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  it('removes scalar field without schema', async () => {
    await createTestNode({
      title: 'Scalar Node',
      fields: { owner: '[[Alice]]' },
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Scalar Node.md', target: 'Alice', rel_type: 'owner' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Scalar Node.md'), 'utf-8');
    expect(content).not.toContain('owner');
    expect(content).not.toContain('[[Alice]]');
  });

  it('removes from body when rel_type has no matching schema or frontmatter field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Body Fallback',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Related to [[SomeProject]].',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Body Fallback.md', target: 'SomeProject', rel_type: 'unknown_field' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Body Fallback.md'), 'utf-8');
    expect(content).not.toContain('[[SomeProject]]');
  });

  it('handles already-bracketed target input', async () => {
    await createTestNode({
      title: 'Bracket Test',
      body: 'See [[Alice]] here.',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Bracket Test.md', target: '[[Alice]]', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Bracket Test.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });
});
