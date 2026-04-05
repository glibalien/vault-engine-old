import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadSchemas } from '../../src/schema/loader.js';

function parseResult(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe('write-path coercion integration', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-coerce-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Copy schema fixtures
    const fixtureSchemas = join(import.meta.dirname, '../fixtures/.schemas');
    const schemasDir = join(vaultPath, '.schemas');
    mkdirSync(schemasDir, { recursive: true });

    for (const file of ['task.yaml', 'person.yaml', 'meeting.yaml', 'work-task.yaml']) {
      writeFileSync(
        join(schemasDir, file),
        readFileSync(join(fixtureSchemas, file), 'utf-8'),
      );
    }

    loadSchemas(db, vaultPath);

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

  describe('create-node coercion', () => {
    it('coerces bare string to reference', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Fix login bug',
          types: ['task'],
          fields: { status: 'todo', assignee: 'Alice' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      // Assignee should be coerced to [[Alice]]
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      expect(file).toContain('assignee: "[[Alice]]"');
      expect(data.warnings).toEqual([]);
    });

    it('coerces enum casing', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Another task',
          types: ['task'],
          fields: { status: 'TODO', priority: 'High' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      expect(file).toContain('status: todo');
      expect(file).toContain('priority: high');
      expect(data.coercion).toBeDefined();
      expect(data.coercion.length).toBeGreaterThan(0);
    });

    it('coerces list<reference> bare string to wrapped array', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Team standup',
          types: ['meeting'],
          fields: { date: '2026-04-05', attendees: 'Alice' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      // Should be coerced to list with wiki-link wrapping
      expect(file).toContain('attendees:');
      expect(file).toContain('[[Alice]]');
    });

    it('coerces boolean string for work-task', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Billable task',
          types: ['work-task'],
          fields: { status: 'todo', billable: 'true' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      expect(file).toContain('billable: true');
    });

    it('coerces camelCase field names', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'CamelCase task',
          types: ['task'],
          fields: { status: 'todo', dueDate: '2026-04-05' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      expect(file).toContain('due_date:');
      expect(file).not.toContain('dueDate:');
    });

    it('returns coercion log in response', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Log test',
          types: ['task'],
          fields: { status: 'TODO', assignee: 'Bob' },
        },
      });

      const data = parseResult(result);
      expect(data.coercion).toBeDefined();
      expect(data.coercion.some((c: any) => c.rule === 'enum_case')).toBe(true);
      expect(data.coercion.some((c: any) => c.rule === 'reference_wrap')).toBe(true);
    });

    it('does not include coercion key when nothing was coerced', async () => {
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Clean task',
          types: ['task'],
          fields: { status: 'todo', assignee: '[[Alice]]' },
        },
      });

      const data = parseResult(result);
      expect(data.coercion).toBeUndefined();
    });
  });

  describe('update-node coercion', () => {
    it('coerces field updates on existing node', async () => {
      // Create a task first
      const createResult = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Update test',
          types: ['task'],
          fields: { status: 'todo' },
        },
      });
      const nodeId = parseResult(createResult).node.id;

      // Update with sloppy values
      const result = await client.callTool({
        name: 'update-node',
        arguments: {
          node_id: nodeId,
          fields: { assignee: 'Bob', priority: 'HIGH' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, nodeId), 'utf-8');
      expect(file).toContain('assignee: "[[Bob]]"');
      expect(file).toContain('priority: high');
      expect(data.coercion).toBeDefined();
    });

    it('preserves null deletions through coercion', async () => {
      const createResult = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Delete field test',
          types: ['task'],
          fields: { status: 'todo', priority: 'high' },
        },
      });
      const nodeId = parseResult(createResult).node.id;

      const result = await client.callTool({
        name: 'update-node',
        arguments: {
          node_id: nodeId,
          fields: { priority: null },
        },
      });

      expect(result.isError).toBeFalsy();
      const file = readFileSync(join(vaultPath, nodeId), 'utf-8');
      expect(file).not.toContain('priority');
    });
  });

  describe('global field fallback', () => {
    it('coerces via _global.yaml when field not in per-type schema', async () => {
      // Write a _global.yaml
      writeFileSync(
        join(vaultPath, '.schemas', '_global.yaml'),
        `global_fields:
  project:
    type: list<reference>
  company:
    type: list<reference>
`,
      );

      // Need to recreate server to pick up global fields
      await cleanup();
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createSchema(db);
      loadSchemas(db, vaultPath);

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

      // Create a person node (person schema has no 'project' field)
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Alice Smith',
          types: ['person'],
          fields: { role: 'engineer', project: '[[CenterPoint]]' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      const file = readFileSync(join(vaultPath, data.node.id), 'utf-8');
      // project should be coerced to list via global definition
      expect(file).toContain('project:');
      expect(file).toContain('[[CenterPoint]]');
    });
  });
});
