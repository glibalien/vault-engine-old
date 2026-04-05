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

function setupVault(vaultPath: string, enforcementYaml?: string) {
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

  if (enforcementYaml) {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), enforcementYaml);
  }
}

describe('enforcement integration', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  async function startServer() {
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
  }

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-enforce-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  describe('no enforcement config (defaults)', () => {
    it('accepts unknown fields with default warn policy', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'todo', extra_field: 'some value' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.extra_field).toBe('some value');
    });

    it('silently passes invalid enum values', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('invalid_status');
    });
  });

  describe('reject unknown fields', () => {
    it('rejects create-node with unknown fields when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'todo', unknown_field: 'bad' },
        },
      });

      expect(result.isError).toBeTruthy();
      const data = parseResult(result);
      expect(data.error).toContain('Enforcement policy rejected');
      expect(data.error).toContain('unknown_field');
    });

    it('allows unknown fields on types with warn policy', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
`);
      await startServer();

      // person type is not set to reject, so unknown fields should be accepted
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Alice',
          types: ['person'],
          fields: { role: 'engineer', extra: 'ok' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.extra).toBe('ok');
    });

    it('rejects update-node with unknown fields when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    per_type:
      task: reject
`);
      await startServer();

      // First create a valid task
      const createResult = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Valid Task',
          types: ['task'],
          fields: { status: 'todo' },
        },
      });
      expect(createResult.isError).toBeFalsy();
      const created = parseResult(createResult);

      // Now try to update with unknown field
      const updateResult = await client.callTool({
        name: 'update-node',
        arguments: {
          node_id: created.node.id,
          fields: { unknown_field: 'bad' },
        },
      });

      expect(updateResult.isError).toBeTruthy();
      const data = parseResult(updateResult);
      expect(data.error).toContain('unknown_field');
    });
  });

  describe('reject enum validation', () => {
    it('rejects invalid enum values when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeTruthy();
      const data = parseResult(result);
      expect(data.error).toContain('Enforcement policy rejected');
      expect(data.error).toContain('status');
    });

    it('still coerces valid case-insensitive enum even with reject policy', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'TODO' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('todo');
    });

    it('warns on invalid enum with warn policy', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: warn
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('invalid_status');
      expect(data.enforcement_issues).toBeDefined();
      expect(data.enforcement_issues.length).toBeGreaterThan(0);
      expect(data.enforcement_issues[0].policy).toBe('enum_validation');
    });
  });

  describe('describe-schema includes enforcement', () => {
    it('includes enforcement policies in schema description', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    per_type:
      task: reject
  enum_validation:
    per_type:
      task: reject
  normalize_on_index:
    per_type:
      task: fix
`);
      await startServer();

      const result = await client.callTool({
        name: 'describe-schema',
        arguments: { schema_name: 'task' },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.enforcement).toBeDefined();
      expect(data.enforcement.unknownFields).toBe('reject');
      expect(data.enforcement.enumValidation).toBe('reject');
      expect(data.enforcement.normalizeOnIndex).toBe('fix');
    });

    it('shows defaults when no per-type override', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'describe-schema',
        arguments: { schema_name: 'task' },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.enforcement).toBeDefined();
      expect(data.enforcement.unknownFields).toBe('warn');
      expect(data.enforcement.enumValidation).toBe('coerce');
      expect(data.enforcement.normalizeOnIndex).toBe('warn');
    });
  });
});
