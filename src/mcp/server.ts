// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });

  // Shared helper: hydrate node rows with types and fields
  function hydrateNodes(
    nodeRows: Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>,
    opts?: { includeContentMd?: boolean },
  ) {
    if (nodeRows.length === 0) return [];

    const nodeIds = nodeRows.map(r => r.id);
    const placeholders = nodeIds.map(() => '?').join(',');

    const typeRows = db.prepare(
      `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

    const fieldRows = db.prepare(
      `SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

    const typesMap = new Map<string, string[]>();
    for (const row of typeRows) {
      const arr = typesMap.get(row.node_id) ?? [];
      arr.push(row.schema_type);
      typesMap.set(row.node_id, arr);
    }

    const fieldsMap = new Map<string, Record<string, string>>();
    for (const row of fieldRows) {
      const rec = fieldsMap.get(row.node_id) ?? {};
      rec[row.key] = row.value_text;
      fieldsMap.set(row.node_id, rec);
    }

    return nodeRows.map(row => {
      const node: Record<string, unknown> = {
        id: row.id,
        file_path: row.file_path,
        node_type: row.node_type,
        types: typesMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? {},
        content_text: row.content_text,
        updated_at: row.updated_at,
      };
      if (opts?.includeContentMd) {
        node.content_md = row.content_md;
      }
      return node;
    });
  }

  server.tool(
    'list-types',
    'List all node types found in the vault with their counts',
    {},
    async () => {
      const rows = db.prepare(`
        SELECT schema_type AS name, COUNT(*) AS count
        FROM node_types
        GROUP BY schema_type
        ORDER BY schema_type
      `).all() as Array<{ name: string; count: number }>;

      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );

  server.tool(
    'get-node',
    'Get full details of a specific node by its ID (vault-relative file path)',
    {
      node_id: z.string().describe('Vault-relative file path, e.g. "tasks/review.md"'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
    },
    async ({ node_id, include_relationships }) => {
      const row = db.prepare(`
        SELECT id, file_path, node_type, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(node_id) as { id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return {
          content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
          isError: true,
        };
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(node_id, node_id) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );

  return server;
}
