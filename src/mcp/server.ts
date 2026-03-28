// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getAllSchemas, getSchema, loadSchemas } from '../schema/loader.js';
import { mergeSchemaFields } from '../schema/merger.js';
import { validateNode } from '../schema/validator.js';
import { evaluateComputed } from '../schema/computed.js';
import type { ComputedDefinition, ValidationWarning } from '../schema/types.js';
import type { FieldEntry, FieldValueType } from '../parser/types.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseFile } from '../parser/index.js';
import { serializeNode, computeFieldOrder, generateFilePath, writeNodeFile, deleteNodeFile, sanitizeSegment } from '../serializer/index.js';
import { indexFile, deleteFile, incrementalIndex } from '../sync/indexer.js';
import { releaseWriteLock, acquireGlobalWriteLock, releaseGlobalWriteLock } from '../sync/watcher.js';
import { updateBodyReferences, updateFrontmatterReferences, removeBodyWikiLink } from './rename-helpers.js';
import { resolveReferences, resolveTarget, buildLookupMaps, resolveTargetWithMaps } from '../sync/resolver.js';
import { traverseGraph } from '../graph/index.js';
import { analyzeVault } from '../inference/analyzer.js';
import { generateSchemas, writeSchemaFiles } from '../inference/generator.js';
import type { InferenceMode } from '../inference/types.js';
import { projectStatusHandler, dailySummaryHandler, createMeetingNotesHandler, extractTasksHandler } from './workflow-tools.js';
import { resolveEmbeds } from '../attachments/resolver.js';
import { readImage, readAudio, readDocument } from '../attachments/readers.js';
import type { ImageContent, TextContent } from '../attachments/types.js';
import { normalizeFields } from './normalize-fields.js';
import { findDuplicates } from './duplicates.js';
import { buildQuerySql } from './query-builder.js';
import { createProvider } from '../embeddings/provider-factory.js';
import { semanticSearch, getPendingEmbeddingCount } from '../embeddings/search.js';
import type { EmbeddingConfig, EmbeddingProvider } from '../embeddings/types.js';

type ErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'INTERNAL_ERROR';

function toolError(message: string, code: ErrorCode) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
    isError: true as const,
  };
}

function hasPathTraversal(p: string): boolean {
  return p.split('/').some(seg => seg === '..' || seg === '.');
}

export { toolError };

export function createServer(
  db: Database.Database,
  vaultPath: string,
  opts?: { embeddingConfig?: EmbeddingConfig },
): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });

  const embeddingProvider: EmbeddingProvider | null = opts?.embeddingConfig
    ? createProvider(opts.embeddingConfig)
    : null;

  // Shared helper: hydrate node rows with types and fields
  function hydrateNodes(
    nodeRows: Array<{ id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string }>,
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
        title: row.title,
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

  function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined;
    if (!node) return null;

    const typeRows = db.prepare(
      'SELECT schema_type FROM node_types WHERE node_id = ?'
    ).all(nodeId) as Array<{ schema_type: string }>;
    const types = typeRows.map(r => r.schema_type);

    const fieldRows = db.prepare(
      'SELECT key, value_text, value_type, value_number, value_date FROM fields WHERE node_id = ?'
    ).all(nodeId) as Array<{ key: string; value_text: string; value_type: string; value_number: number | null; value_date: string | null }>;

    const fields: FieldEntry[] = fieldRows.map(r => {
      let value: unknown = r.value_text;
      const valueType = r.value_type as FieldValueType;
      if (valueType === 'number' && r.value_number !== null) value = r.value_number;
      else if (valueType === 'date' && r.value_date) value = new Date(r.value_date);
      else if (valueType === 'boolean') value = r.value_text === 'true';
      else if (valueType === 'list' && r.value_text) {
        try { value = JSON.parse(r.value_text); } catch { /* keep as string */ }
      }
      return { key: r.key, value, valueType };
    });

    return { types, fields };
  }

  function inferFieldType(value: unknown): FieldValueType {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'date';
    if (Array.isArray(value)) return 'list';
    if (typeof value === 'string' && /^\[\[.+\]\]$/.test(value)) return 'reference';
    return 'string';
  }

  function createNodeInner(params: {
    title: string;
    types: string[];
    fields: Record<string, unknown>;
    body?: string;
    parent_path?: string;
    relationships: Array<{ target: string; rel_type: string }>;
  }, deferredLocks?: Set<string>) {
    const { title, types, body: inputBody, parent_path, relationships } = params;
    const fields = { ...params.fields };
    let body = inputBody ?? '';

    // Step 1: Validate against schemas (if any types have schemas)
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let mergeResult = hasSchemas ? mergeSchemaFields(db, types) : null;
    let warnings: ValidationWarning[] = [];

    if (mergeResult) {
      const parsed = {
        filePath: 'pending',
        frontmatter: {},
        types,
        fields: Object.entries(fields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(parsed, mergeResult);
      warnings = validation.warnings;
    }

    // Step 2: Process relationships
    for (const rel of relationships) {
      const target = rel.target.startsWith('[[') ? rel.target : `[[${rel.target}]]`;

      // Check if rel_type is a schema field
      const mergedField = mergeResult?.fields[rel.rel_type];
      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = fields[rel.rel_type];
          if (Array.isArray(existing)) {
            existing.push(target);
          } else {
            fields[rel.rel_type] = [target];
          }
        } else {
          fields[rel.rel_type] = target;
        }
      } else if (!hasSchemas && Array.isArray(fields[rel.rel_type])) {
        // Schema-less fallback: check if existing value is an array
        (fields[rel.rel_type] as unknown[]).push(target);
      } else if (!hasSchemas && rel.rel_type in fields) {
        // Schema-less scalar field
        fields[rel.rel_type] = target;
      } else {
        // No matching field — append to body
        body = body ? `${body}\n\n${target}` : target;
      }
    }

    // Step 3: Compute field order
    const fieldOrder = computeFieldOrder(types, db);

    // Step 4: Serialize
    const content = serializeNode({ title, types, fields, body: body || undefined, fieldOrder });

    // Step 5: Generate path
    let relativePath: string;
    if (parent_path) {
      const sanitized = sanitizeSegment(title);
      const prefix = parent_path.endsWith('/') ? parent_path : `${parent_path}/`;
      relativePath = `${prefix}${sanitized}.md`;
    } else {
      relativePath = generateFilePath(title, types, fields, db);
    }

    // Step 6: Check existence
    if (existsSync(join(vaultPath, relativePath))) {
      return toolError(
        `File already exists at ${relativePath}. Use update-node to modify existing nodes or choose a different title.`,
        'CONFLICT',
      );
    }

    // Step 7: Write
    writeNodeFile(vaultPath, relativePath, content, deferredLocks);

    // Step 8: Stat for mtime
    const stat = statSync(join(vaultPath, relativePath));
    const mtime = stat.mtime.toISOString();

    // Step 9: Parse + index
    const parsed = parseFile(relativePath, content);
    indexFile(db, parsed, relativePath, mtime, content);

    // Step 10: Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(relativePath) as {
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings }) }],
    };
  }

  function createNode(params: Parameters<typeof createNodeInner>[0]) {
    return db.transaction(() => {
      const result = createNodeInner(params);
      if (!('isError' in result)) resolveReferences(db);
      return result;
    })();
  }

  function updateNodeInner(params: {
    node_id: string;
    fields?: Record<string, unknown>;
    body?: string;
    append_body?: string;
    types?: string[];
    title?: string;
  }, deferredLocks?: Set<string>) {
    const { node_id, fields: fieldUpdates, body: newBody, append_body, types: newTypes, title: newTitle } = params;

    // Param validation
    if (!fieldUpdates && newBody === undefined && append_body === undefined && newTypes === undefined && newTitle === undefined) {
      return toolError('No updates provided: at least one of fields, body, append_body, types, or title is required', 'VALIDATION_ERROR');
    }
    if (newBody !== undefined && append_body !== undefined) {
      return toolError('Cannot provide both body and append_body — they are mutually exclusive', 'VALIDATION_ERROR');
    }

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return toolError(`File not found on disk: ${node_id}. Database and filesystem are out of sync.`, 'NOT_FOUND');
    }

    // Read existing file
    const raw = readFileSync(absPath, 'utf-8');

    // Parse existing file
    const parsed = parseFile(node_id, raw);

    // Title: use provided value, else existing frontmatter, else filename stem
    const title = newTitle !== undefined
      ? newTitle
      : typeof parsed.frontmatter.title === 'string'
        ? parsed.frontmatter.title
        : node_id.replace(/\.md$/, '').split('/').pop()!;

    // Types: use provided value, else existing
    const types = newTypes !== undefined ? newTypes : parsed.types;

    // Merge fields: existing (excluding meta-keys) + updates
    const mergedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      mergedFields[key] = value;
    }
    if (fieldUpdates) {
      for (const [key, value] of Object.entries(fieldUpdates)) {
        if (key === 'title' || key === 'types') continue;
        if (value === null) {
          delete mergedFields[key];
        } else {
          mergedFields[key] = value;
        }
      }
    }

    // Resolve body
    let body: string;
    if (newBody !== undefined) {
      body = newBody;
    } else if (append_body !== undefined) {
      body = parsed.contentMd ? `${parsed.contentMd}\n\n${append_body}` : append_body;
    } else {
      body = parsed.contentMd;
    }

    // Validate against schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let warnings: ValidationWarning[] = [];

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const forValidation = {
        filePath: node_id,
        frontmatter: {},
        types,
        fields: Object.entries(mergedFields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(forValidation, mergeResult);
      warnings = validation.warnings;
    }

    // Compute field order + serialize
    const fieldOrder = computeFieldOrder(types, db);
    const content = serializeNode({
      title,
      types,
      fields: mergedFields,
      body: body || undefined,
      fieldOrder,
    });

    // Write file (same path — update in place)
    writeNodeFile(vaultPath, node_id, content, deferredLocks);

    // Stat for mtime
    const stat = statSync(absPath);
    const mtime = stat.mtime.toISOString();

    // Parse + index
    const reParsed = parseFile(node_id, content);
    indexFile(db, reParsed, node_id, mtime, content);

    // Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(node_id) as {
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings }) }],
    };
  }

  function updateNode(params: Parameters<typeof updateNodeInner>[0]) {
    return db.transaction(() => {
      const result = updateNodeInner(params);
      if (!('isError' in result)) resolveReferences(db);
      return result;
    })();
  }

  function returnCurrentNode(nodeId: string) {
    const row = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(nodeId) as {
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    } | undefined;
    if (!row) {
      return toolError(`Node not found: ${nodeId}`, 'NOT_FOUND');
    }
    const [node] = hydrateNodes([row]);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings: [] }) }],
    };
  }

  function addRelationshipInner(params: {
    source_id: string;
    target: string;
    rel_type: string;
  }, deferredLocks?: Set<string>) {
    const { source_id, target: rawTarget, rel_type } = params;
    const target = rawTarget.startsWith('[[') ? rawTarget : `[[${rawTarget}]]`;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }

    const absPath = join(vaultPath, source_id);
    if (!existsSync(absPath)) {
      return toolError(`File not found on disk: ${source_id}. Database and filesystem are out of sync.`, 'NOT_FOUND');
    }

    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(source_id, raw);
    const types = parsed.types;

    // Extract inner target for comparison (strips [[ ]] and alias)
    const innerTarget = target.match(/^\[\[([^\]|]+)/)?.[1] ?? '';

    // Force body if rel_type is 'wiki-link'
    if (rel_type === 'wiki-link') {
      const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
      if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
        return returnCurrentNode(source_id);
      }
      return updateNodeInner({ node_id: source_id, append_body: target }, deferredLocks);
    }

    // Check schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const mergedField = mergeResult.fields[rel_type];

      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = parsed.frontmatter[rel_type];
          const currentArray: unknown[] = Array.isArray(existing) ? existing : (existing != null ? [existing] : []);
          const alreadyExists = currentArray.some((item: unknown) => {
            if (typeof item !== 'string') return false;
            const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
            return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
          });
          if (alreadyExists) {
            return returnCurrentNode(source_id);
          }
          return updateNodeInner({
            node_id: source_id,
            fields: { [rel_type]: [...currentArray, target] },
          }, deferredLocks);
        } else {
          // Scalar field
          return updateNodeInner({
            node_id: source_id,
            fields: { [rel_type]: target },
          }, deferredLocks);
        }
      }
    }

    // Schema-less fallback: check existing frontmatter
    if (!hasSchemas && rel_type !== 'title' && rel_type !== 'types') {
      const existing = parsed.frontmatter[rel_type];
      if (Array.isArray(existing)) {
        const alreadyExists = existing.some((item: unknown) => {
          if (typeof item !== 'string') return false;
          const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
          return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
        });
        if (alreadyExists) {
          return returnCurrentNode(source_id);
        }
        return updateNodeInner({
          node_id: source_id,
          fields: { [rel_type]: [...existing, target] },
        }, deferredLocks);
      } else if (rel_type in parsed.frontmatter) {
        return updateNodeInner({
          node_id: source_id,
          fields: { [rel_type]: target },
        }, deferredLocks);
      }
    }

    // Body fallback
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
      return returnCurrentNode(source_id);
    }
    return updateNodeInner({ node_id: source_id, append_body: target }, deferredLocks);
  }

  function addRelationship(params: Parameters<typeof addRelationshipInner>[0]) {
    return db.transaction(() => {
      const result = addRelationshipInner(params);
      if (!('isError' in result)) resolveReferences(db);
      return result;
    })();
  }

  server.tool(
    'add-relationship',
    'Add a relationship from one node to another. Routes to frontmatter field or body wiki-link based on schema.',
    {
      source_id: z.string().min(1).describe('Vault-relative file path of the source node, e.g. "tasks/review.md"'),
      target: z.string().min(1).describe('Wiki-link target, e.g. "Alice" or "[[Alice]]"'),
      rel_type: z.string().min(1).describe('Relationship type — schema field name for frontmatter, or "wiki-link" for body'),
    },
    async (params) => {
      try {
        return addRelationship(params);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  function removeRelationshipInner(params: {
    source_id: string;
    target: string;
    rel_type: string;
  }, deferredLocks?: Set<string>) {
    const { source_id, target: rawTarget, rel_type } = params;

    // Normalize: extract inner target from [[target]] or [[target|alias]]
    const innerTarget = rawTarget.startsWith('[[')
      ? (rawTarget.match(/^\[\[([^\]|]+)/)?.[1] ?? rawTarget)
      : rawTarget;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }

    const absPath = join(vaultPath, source_id);
    if (!existsSync(absPath)) {
      return toolError(`File not found on disk: ${source_id}. Database and filesystem are out of sync.`, 'NOT_FOUND');
    }

    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(source_id, raw);
    const types = parsed.types;

    // Force body if rel_type is 'wiki-link'
    if (rel_type === 'wiki-link') {
      const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
      if (!bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
        return returnCurrentNode(source_id);
      }
      const newBody = removeBodyWikiLink(parsed.contentMd, innerTarget);
      return updateNodeInner({ node_id: source_id, body: newBody }, deferredLocks);
    }

    // Check schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const mergedField = mergeResult.fields[rel_type];

      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = parsed.frontmatter[rel_type];
          if (!Array.isArray(existing)) return returnCurrentNode(source_id);
          const filtered = existing.filter((item: unknown) => {
            if (typeof item !== 'string') return true;
            const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
            return inner == null || inner.toLowerCase() !== innerTarget.toLowerCase();
          });
          if (filtered.length === existing.length) return returnCurrentNode(source_id);
          return updateNodeInner({
            node_id: source_id,
            fields: { [rel_type]: filtered },
          }, deferredLocks);
        } else {
          // Scalar: remove if matches
          const existing = parsed.frontmatter[rel_type];
          if (typeof existing !== 'string') return returnCurrentNode(source_id);
          const inner = existing.match(/^\[\[([^\]|]+)/)?.[1];
          if (inner == null || inner.toLowerCase() !== innerTarget.toLowerCase()) {
            return returnCurrentNode(source_id);
          }
          return updateNodeInner({ node_id: source_id, fields: { [rel_type]: null } }, deferredLocks);
        }
      }
    }

    // Schema-less fallback: check existing frontmatter
    if (!hasSchemas && rel_type !== 'title' && rel_type !== 'types') {
      const existing = parsed.frontmatter[rel_type];
      if (Array.isArray(existing)) {
        const filtered = existing.filter((item: unknown) => {
          if (typeof item !== 'string') return true;
          const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
          return inner == null || inner.toLowerCase() !== innerTarget.toLowerCase();
        });
        if (filtered.length === existing.length) return returnCurrentNode(source_id);
        return updateNodeInner({
          node_id: source_id,
          fields: { [rel_type]: filtered },
        }, deferredLocks);
      } else if (typeof existing === 'string' && rel_type in parsed.frontmatter) {
        const inner = existing.match(/^\[\[([^\]|]+)/)?.[1];
        if (inner == null || inner.toLowerCase() !== innerTarget.toLowerCase()) {
          return returnCurrentNode(source_id);
        }
        return updateNodeInner({ node_id: source_id, fields: { [rel_type]: null } }, deferredLocks);
      }
    }

    // Body fallback: remove from body
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    if (!bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
      return returnCurrentNode(source_id);
    }
    const newBody = removeBodyWikiLink(parsed.contentMd, innerTarget);
    return updateNodeInner({ node_id: source_id, body: newBody }, deferredLocks);
  }

  function removeRelationship(params: Parameters<typeof removeRelationshipInner>[0]) {
    return db.transaction(() => {
      const result = removeRelationshipInner(params);
      if (!('isError' in result)) resolveReferences(db);
      return result;
    })();
  }

  server.tool(
    'remove-relationship',
    'Remove a relationship from one node to another. Inverse of add-relationship. Routes to frontmatter field or body based on schema.',
    {
      source_id: z.string().min(1).describe('Vault-relative file path of the source node, e.g. "tasks/review.md"'),
      target: z.string().min(1).describe('Wiki-link target to remove, e.g. "Alice" or "[[Alice]]"'),
      rel_type: z.string().min(1).describe('Relationship type — schema field name for frontmatter, or "wiki-link" for body'),
    },
    async (params) => {
      try {
        return removeRelationship(params);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  function deleteNodeInner(params: { node_id: string }, deferredLocks?: Set<string>) {
    const { node_id } = params;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }

    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return toolError(`File not found on disk: ${node_id}. Database and filesystem are out of sync.`, 'NOT_FOUND');
    }

    deleteNodeFile(vaultPath, node_id, deferredLocks);
    deleteFile(db, node_id);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node_id, deleted: true }) }],
    };
  }

  type MutationResult = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  };

  function batchMutate(params: {
    operations: Array<{
      op: 'create' | 'update' | 'delete' | 'link' | 'unlink';
      params: Record<string, unknown>;
    }>;
  }) {
    const { operations } = params;

    if (!operations || operations.length === 0) {
      return toolError('No operations provided', 'VALIDATION_ERROR');
    }

    // Batch-scoped deferred locks: acquired per-file during batch, released all at once in finally
    const deferredLocks = new Set<string>();

    // File snapshot tracking for rollback
    const fileSnapshots = new Map<string, string | null>(); // path → original content (null = didn't exist)

    function snapshotFile(relativePath: string) {
      if (fileSnapshots.has(relativePath)) return;
      const absPath = join(vaultPath, relativePath);
      if (existsSync(absPath)) {
        fileSnapshots.set(relativePath, readFileSync(absPath, 'utf-8'));
      } else {
        fileSnapshots.set(relativePath, null);
      }
    }

    function rollbackFiles() {
      // Rollback calls do NOT use deferred locks — they need immediate release since they're cleanup
      for (const [relativePath, originalContent] of fileSnapshots) {
        const absPath = join(vaultPath, relativePath);
        if (originalContent === null) {
          // File was created during batch — delete it
          if (existsSync(absPath)) {
            try { deleteNodeFile(vaultPath, relativePath); } catch { /* best effort */ }
          }
        } else {
          // File was modified or deleted — restore original content
          try { writeNodeFile(vaultPath, relativePath, originalContent); } catch { /* best effort */ }
        }
      }
    }

    interface OpResult {
      op: string;
      [key: string]: unknown;
    }

    try {
      const batchResult = db.transaction(() => {
        const results: OpResult[] = [];
        const allWarnings: Array<{ op_index: number; warnings: unknown[] }> = [];

        for (let i = 0; i < operations.length; i++) {
          const { op, params: opParams } = operations[i];
          let result: MutationResult;

          switch (op) {
            case 'create': {
              const createParams = {
                title: opParams.title as string,
                types: (opParams.types as string[]) ?? [],
                fields: (opParams.fields as Record<string, unknown>) ?? {},
                body: opParams.body as string | undefined,
                parent_path: opParams.parent_path as string | undefined,
                relationships: (opParams.relationships as Array<{ target: string; rel_type: string }>) ?? [],
              };
              result = createNodeInner(createParams, deferredLocks);
              // Track created file for rollback AFTER createNodeInner writes it.
              if (!result.isError) {
                const data = JSON.parse(result.content[0].text);
                if (!fileSnapshots.has(data.node.id)) {
                  fileSnapshots.set(data.node.id, null); // null = file didn't exist before batch
                }
              }
              break;
            }
            case 'update': {
              snapshotFile((opParams as { node_id: string }).node_id);
              result = updateNodeInner(opParams as Parameters<typeof updateNodeInner>[0], deferredLocks);
              break;
            }
            case 'delete': {
              snapshotFile((opParams as { node_id: string }).node_id);
              result = deleteNodeInner(opParams as Parameters<typeof deleteNodeInner>[0], deferredLocks);
              break;
            }
            case 'link': {
              snapshotFile((opParams as { source_id: string }).source_id);
              result = addRelationshipInner(opParams as Parameters<typeof addRelationshipInner>[0], deferredLocks);
              break;
            }
            case 'unlink': {
              snapshotFile((opParams as { source_id: string }).source_id);
              result = removeRelationshipInner(opParams as Parameters<typeof removeRelationshipInner>[0], deferredLocks);
              break;
            }
            default:
              throw new Error(`Unknown operation: ${op}`);
          }

          if (result.isError) {
            const errorText = result.content[0].text;
            throw new Error(`Operation ${i} (${op}) failed: ${errorText}`);
          }

          // Parse result and collect
          const parsed = JSON.parse(result.content[0].text);
          results.push({ op, ...parsed });

          // Collect warnings
          if (parsed.warnings && parsed.warnings.length > 0) {
            allWarnings.push({ op_index: i, warnings: parsed.warnings });
          }
        }

        // Resolve all references once at the end
        resolveReferences(db);

        return { results, warnings: allWarnings.flatMap(w => w.warnings) };
      })();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(batchResult) }],
      };
    } catch (err) {
      rollbackFiles();
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: message, code: 'INTERNAL_ERROR', rolled_back: true }),
        }],
        isError: true,
      };
    } finally {
      for (const lockedPath of deferredLocks) {
        releaseWriteLock(lockedPath);
      }
    }
  }

  function renameNode(params: {
    node_id: string;
    new_title: string;
    new_path?: string;
  }) {
    const { node_id, new_title, new_path: explicitNewPath } = params;

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node_id) as
      | { id: string; title: string }
      | undefined;
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return toolError(`File not found on disk: ${node_id}. Database and filesystem are out of sync.`, 'NOT_FOUND');
    }

    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(node_id, raw);
    const oldTitle = typeof parsed.frontmatter.title === 'string'
      ? parsed.frontmatter.title
      : node_id.replace(/\.md$/, '').split('/').pop()!;
    const types = parsed.types;

    // No-op: same title, no explicit new path
    if (new_title === oldTitle && !explicitNewPath) {
      return returnCurrentNode(node_id);
    }

    // Extract existing fields (exclude meta-keys)
    const existingFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      existingFields[key] = value;
    }

    // Derive new path — preserve original directory when no explicit path given
    let newPath: string;
    if (explicitNewPath) {
      newPath = explicitNewPath;
    } else {
      const generated = generateFilePath(new_title, types, existingFields, db);
      const originalDir = node_id.includes('/') ? node_id.slice(0, node_id.lastIndexOf('/')) : '';
      newPath = originalDir ? `${originalDir}/${generated}` : generated;
    }

    // Check new path doesn't collide (unless same path)
    if (newPath !== node_id && existsSync(join(vaultPath, newPath))) {
      return toolError(
        `File already exists at ${newPath}. Use a different title or provide an explicit new_path.`,
        'CONFLICT',
      );
    }

    // Find referencing files (excluding self)
    const referencingRows = db.prepare(`
      SELECT DISTINCT source_id FROM relationships
      WHERE (resolved_target_id = ? OR LOWER(target_id) = LOWER(?))
        AND source_id != ?
    `).all(node_id, oldTitle, node_id) as Array<{ source_id: string }>;

    // Update source file: self-references first (while content has old title), then serialize with new title
    const updatedSourceFields = updateFrontmatterReferences(existingFields, oldTitle, new_title);
    const sourceBody = updateBodyReferences(parsed.contentMd, oldTitle, new_title);

    const fieldOrder = computeFieldOrder(types, db);
    const sourceContent = serializeNode({
      title: new_title,
      types,
      fields: updatedSourceFields,
      body: sourceBody || undefined,
      fieldOrder,
    });

    // Write new file, delete old
    writeNodeFile(vaultPath, newPath, sourceContent);
    if (newPath !== node_id) {
      deleteNodeFile(vaultPath, node_id);
    }

    // Update referencing files
    const updatedRefs: Array<{ path: string; content: string }> = [];
    for (const { source_id } of referencingRows) {
      const refAbsPath = join(vaultPath, source_id);
      if (!existsSync(refAbsPath)) continue;

      const refRaw = readFileSync(refAbsPath, 'utf-8');
      const refParsed = parseFile(source_id, refRaw);

      // Update body references
      const refBody = updateBodyReferences(refParsed.contentMd, oldTitle, new_title);

      // Update frontmatter references (exclude meta-keys)
      const refFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(refParsed.frontmatter)) {
        if (key === 'title' || key === 'types') continue;
        refFields[key] = value;
      }
      const refUpdatedFields = updateFrontmatterReferences(refFields, oldTitle, new_title);

      const refTitle = typeof refParsed.frontmatter.title === 'string'
        ? refParsed.frontmatter.title
        : source_id.replace(/\.md$/, '').split('/').pop()!;

      const refFieldOrder = computeFieldOrder(refParsed.types, db);
      const refContent = serializeNode({
        title: refTitle,
        types: refParsed.types,
        fields: refUpdatedFields,
        body: refBody || undefined,
        fieldOrder: refFieldOrder,
      });

      writeNodeFile(vaultPath, source_id, refContent);
      updatedRefs.push({ path: source_id, content: refContent });
    }

    // Re-index everything in one transaction
    db.transaction(() => {
      if (newPath !== node_id) {
        deleteFile(db, node_id);
      }

      const newStat = statSync(join(vaultPath, newPath));
      const sourceParsed = parseFile(newPath, sourceContent);
      indexFile(db, sourceParsed, newPath, newStat.mtime.toISOString(), sourceContent);

      for (const { path, content } of updatedRefs) {
        const refStat = statSync(join(vaultPath, path));
        const refParsed = parseFile(path, content);
        indexFile(db, refParsed, path, refStat.mtime.toISOString(), content);
      }

      resolveReferences(db);
    })();

    // Return hydrated node
    const row = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(newPath) as {
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          node,
          old_path: node_id,
          new_path: newPath,
          references_updated: updatedRefs.length,
        }),
      }],
    };
  }

  server.tool(
    'rename-node',
    'Rename a node and update all wiki-link references to it across the vault.',
    {
      node_id: z.string().min(1).describe('Vault-relative file path of the node to rename, e.g. "people/alice.md"'),
      new_title: z.string().min(1).describe('New title for the node'),
      new_path: z.string().min(1).optional()
        .describe('Explicit new file path. If omitted, derived from new_title via schema filename_template.'),
    },
    async (params) => {
      if (hasPathTraversal(params.node_id)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      if (params.new_path && hasPathTraversal(params.new_path)) {
        return toolError('Invalid new_path: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      try {
        return renameNode(params);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

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
    'Get full details of a specific node by its ID (vault-relative file path) or title',
    {
      node_id: z.string().min(1).optional()
        .describe('Vault-relative file path, e.g. "tasks/review.md"'),
      title: z.string().min(1).optional()
        .describe('Node title for lookup, e.g. "Review PR". Resolved via wiki-link resolution logic. Use when you know the name but not the directory.'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
      include_computed: z.boolean().optional().default(false)
        .describe('Include computed field values from schema definitions'),
    },
    async ({ node_id, title, include_relationships, include_computed }) => {
      // Resolve node_id from title if needed
      let resolvedId = node_id;
      if (!resolvedId) {
        if (!title) {
          return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
        }
        const { titleMap, pathMap } = buildLookupMaps(db);
        const resolved = resolveTargetWithMaps(title, titleMap, pathMap);
        if (!resolved) {
          // Distinguish not found vs ambiguous
          const candidates = titleMap.get(title.toLowerCase());
          if (candidates && candidates.length > 1) {
            return toolError(
              `Multiple nodes match title '${title}': ${candidates.join(', ')}`,
              'VALIDATION_ERROR',
            );
          }
          return toolError(`No node found with title '${title}'`, 'NOT_FOUND');
        }
        resolvedId = resolved;
      }

      if (hasPathTraversal(resolvedId)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      const row = db.prepare(`
        SELECT id, file_path, node_type, title, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(resolvedId) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return toolError(`Node not found: ${resolvedId}`, 'NOT_FOUND');
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(resolvedId, resolvedId) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      if (include_computed) {
        const nodeTypes = (node as Record<string, unknown>).types as string[];
        const allComputedDefs: Record<string, ComputedDefinition> = {};
        for (const typeName of nodeTypes) {
          const schema = getSchema(db, typeName);
          if (schema?.computed) {
            Object.assign(allComputedDefs, schema.computed);
          }
        }
        const computed = Object.keys(allComputedDefs).length > 0
          ? evaluateComputed(db, resolvedId, allComputedDefs)
          : {};
        (node as Record<string, unknown>).computed = computed;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );

  server.tool(
    'query-nodes',
    'Search for nodes by type, field values, and/or full text. At least one of schema_type, full_text, filters, references, since, or path_prefix is required.',
    {
      schema_type: z.string().min(1).optional()
        .describe('Schema type to filter by, e.g. "task", "project", "meeting"'),
      full_text: z.string().min(1).optional()
        .describe('Full-text search query (FTS5 syntax: supports "quoted phrases", prefix*, AND/OR)'),
      filters: z.array(z.object({
        field: z.string().min(1).describe('Field name, e.g. "status", "assignee"'),
        operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'])
          .default('eq')
          .describe('Comparison operator'),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
          .describe('Value to compare against (use array for "in" operator)'),
      })).optional()
        .describe('Field filters with comparison operators'),
      limit: z.number().int().min(1).optional().default(20)
        .describe('Maximum number of results (default 20)'),
      order_by: z.string().min(1).optional()
        .describe('Sort field + direction, e.g. "updated_at DESC", "due_date ASC". Default: updated_at DESC (or FTS rank when full_text is used)'),
      references: z.object({
        target: z.string().min(1).describe('Node title or ID to find relationships for'),
        rel_type: z.string().min(1).optional().describe('Filter by relationship type (field name or "wiki-link")'),
        direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('outgoing')
          .describe('outgoing = nodes linking TO target; incoming = nodes target links TO; both = either'),
      }).optional()
        .describe('Filter by relationship — find nodes connected to a target node'),
      since: z.string().min(1).optional()
        .describe('ISO date — only return nodes updated after this time, e.g. "2026-03-27T00:00:00Z"'),
      path_prefix: z.string().min(1).optional()
        .describe('Filter by folder path prefix, e.g. "Meetings/" or "projects/acme/"'),
    },
    async ({ schema_type, full_text, filters, limit, order_by, references, since, path_prefix }) => {
      if (!schema_type && !full_text && (!filters || filters.length === 0) && !references && !since && !path_prefix) {
        return toolError('At least one of schema_type, full_text, filters, references, since, or path_prefix is required', 'VALIDATION_ERROR');
      }

      try {
        // Resolve references target
        let resolvedTargetId: string | null = null;
        if (references) {
          const exactMatch = db.prepare('SELECT id FROM nodes WHERE id = ?').get(references.target) as { id: string } | undefined;
          if (exactMatch) {
            resolvedTargetId = exactMatch.id;
          } else {
            resolvedTargetId = resolveTarget(db, references.target);
          }
        }

        const { sql, params } = buildQuerySql({
          schema_type,
          full_text,
          filters,
          order_by,
          limit,
          since,
          path_prefix,
          references,
          resolvedTargetId,
        });

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string; file_path: string; node_type: string; title: string | null;
          content_text: string; content_md: string | null; updated_at: string;
        }>;

        const nodes = hydrateNodes(rows);
        return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'list-schemas',
    'List all schema definitions loaded from YAML. Shows what structure is defined, as opposed to list-types which shows what types nodes actually have.',
    {},
    async () => {
      const schemas = getAllSchemas(db);
      const summaries = schemas.map(s => ({
        name: s.name,
        display_name: s.display_name ?? null,
        icon: s.icon ?? null,
        extends: s.extends ?? null,
        ancestors: s.ancestors,
        field_count: Object.keys(s.fields).length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summaries) }] };
    },
  );

  server.tool(
    'describe-schema',
    'Get the full definition of a schema including inherited fields, field types, and constraints',
    {
      schema_name: z.string().min(1).describe('Schema name, e.g. "task", "work-task"'),
    },
    async ({ schema_name }) => {
      const schema = getSchema(db, schema_name);
      if (!schema) {
        return toolError(`Schema not found: ${schema_name}`, 'NOT_FOUND');
      }
      return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
    },
  );

  server.tool(
    'validate-node',
    'Validate a node against its schemas. Provide node_id for an existing node, or types + fields for hypothetical validation.',
    {
      node_id: z.string().min(1).optional()
        .describe('Validate an existing node by its ID (vault-relative path)'),
      types: z.array(z.string().min(1)).optional()
        .describe('Schema types for hypothetical validation, e.g. ["task", "meeting"]'),
      fields: z.record(z.string(), z.unknown()).optional()
        .describe('Field values for hypothetical validation, e.g. { "status": "todo" }'),
    },
    async ({ node_id, types, fields: hypotheticalFields }) => {
      if (!node_id && !types) {
        return toolError('Provide node_id or types (with optional fields)', 'VALIDATION_ERROR');
      }

      let nodeTypes: string[];
      let fieldEntries: FieldEntry[];

      if (node_id) {
        const loaded = loadNodeForValidation(node_id);
        if (!loaded) {
          return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
        }
        nodeTypes = loaded.types;
        fieldEntries = loaded.fields;
      } else {
        nodeTypes = types!;
        fieldEntries = Object.entries(hypotheticalFields ?? {}).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        }));
      }

      // If no types have schemas, nothing to validate
      const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
      const hasKnownSchema = nodeTypes.some(t => schemaCheck.get(t) !== undefined);
      if (!hasKnownSchema) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ valid: true, warnings: [] }) }],
        };
      }

      const merge = mergeSchemaFields(db, nodeTypes);
      const parsed = {
        filePath: node_id ?? 'hypothetical',
        frontmatter: {},
        types: nodeTypes,
        fields: fieldEntries,
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const result = validateNode(parsed, merge);

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'create-node',
    'Create a new node as a markdown file with frontmatter. Validates against schemas, writes to disk, and indexes.',
    {
      title: z.string().min(1).describe('Node title (required)'),
      types: z.array(z.string()).optional().default([])
        .describe('Schema types, e.g. ["task"] or ["task", "meeting"]'),
      fields: z.record(z.string(), z.unknown()).optional().default({})
        .describe('Field values, e.g. { "status": "todo", "assignee": "[[Bob]]" }'),
      body: z.string().optional()
        .describe('Markdown body content'),
      parent_path: z.string().min(1).optional()
        .describe('Override path: file created at <parent_path>/<title>.md instead of schema template'),
      relationships: z.array(z.object({
        target: z.string().min(1).describe('Wiki-link target, e.g. "Bob" or "[[Bob]]"'),
        rel_type: z.string().min(1).describe('Relationship type — schema field name for frontmatter, or appended to body'),
      })).optional().default([])
        .describe('Relationships to create with the node'),
    },
    async (params) => {
      if (params.parent_path && hasPathTraversal(params.parent_path)) {
        return toolError('Invalid parent_path: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      try {
        return createNode(params);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'update-node',
    'Update an existing node\'s fields, body, types, and/or title. Single-node mode: pass node_id. Query mode: pass query to bulk-update all matching nodes (fields and/or types). Fields are merged (not replaced); set a field to null to remove it.',
    {
      node_id: z.string().min(1).optional()
        .describe('Vault-relative file path of the node to update, e.g. "tasks/review.md". Mutually exclusive with query.'),
      query: z.object({
        schema_type: z.string().min(1).optional()
          .describe('Schema type to filter by, e.g. "task"'),
        filters: z.array(z.object({
          field: z.string().min(1),
          operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in']).default('eq'),
          value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        })).optional()
          .describe('Field filters with comparison operators'),
        path_prefix: z.string().min(1).optional()
          .describe('Filter by node ID path prefix, e.g. "Daily Notes/"'),
      }).optional()
        .describe('Query to select nodes for bulk update. Mutually exclusive with node_id.'),
      fields: z.record(z.string(), z.unknown()).optional()
        .describe('Fields to update (merged with existing). Set a value to null to remove a field.'),
      body: z.string().optional()
        .describe('Replace the entire body content (single-node mode only)'),
      append_body: z.string().optional()
        .describe('Append to existing body content (single-node mode only)'),
      types: z.array(z.string()).optional()
        .describe('Replace the node\'s types array'),
      title: z.string().optional()
        .describe('Update the node\'s title in frontmatter (single-node mode only)'),
      dry_run: z.boolean().optional().default(false)
        .describe('When true with query mode, returns matched nodes without writing'),
    },
    async (params) => {
      const { node_id, query, fields: fieldUpdates, body, append_body, types, title, dry_run } = params;

      // Mutual exclusion: node_id vs query
      if (node_id && query) {
        return toolError('node_id and query are mutually exclusive — use one or the other', 'VALIDATION_ERROR');
      }

      // Single-node mode
      if (node_id) {
        if (hasPathTraversal(node_id)) {
          return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
        }
        if (dry_run) {
          return toolError('dry_run is only valid in query mode (with query param)', 'VALIDATION_ERROR');
        }
        try {
          return updateNode({ node_id, fields: fieldUpdates, body, append_body, types, title });
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
        }
      }

      // Query mode
      if (query) {
        // Validate: forbidden params in query mode
        if (body !== undefined) {
          return toolError('body is not allowed in query mode — only fields can be bulk-updated', 'VALIDATION_ERROR');
        }
        if (append_body !== undefined) {
          return toolError('append_body is not allowed in query mode — only fields can be bulk-updated', 'VALIDATION_ERROR');
        }
        if (title !== undefined) {
          return toolError('title is not allowed in query mode — only fields and types can be bulk-updated', 'VALIDATION_ERROR');
        }

        // Validate: fields or types required in query mode
        const hasFields = fieldUpdates && Object.keys(fieldUpdates).length > 0;
        if (!hasFields && types === undefined) {
          return toolError('fields or types is required in query mode', 'VALIDATION_ERROR');
        }

        // Validate: query must have at least schema_type, filters, or path_prefix
        if (!query.schema_type && (!query.filters || query.filters.length === 0) && !query.path_prefix) {
          return toolError('query must include at least one of schema_type, filters, or path_prefix', 'VALIDATION_ERROR');
        }

        try {
          // Find matching nodes using buildQuerySql
          const { sql, params: queryParams } = buildQuerySql({
            schema_type: query.schema_type,
            filters: query.filters,
            path_prefix: query.path_prefix,
            limit: 1000,
            select: 'id-only',
          });

          const matchedRows = db.prepare(sql).all(...queryParams) as Array<{ id: string }>;

          if (matchedRows.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(
                dry_run
                  ? { matched: 0, nodes: [] }
                  : { updated: 0, nodes: [], warnings: [] }
              ) }],
            };
          }

          // Dry-run: return matched nodes without writing
          if (dry_run) {
            const fullRows = db.prepare(
              `SELECT id, file_path, node_type, title, content_text, content_md, updated_at
               FROM nodes WHERE id IN (${matchedRows.map(() => '?').join(',')})`
            ).all(...matchedRows.map(r => r.id)) as Array<{
              id: string; file_path: string; node_type: string; title: string | null;
              content_text: string; content_md: string | null; updated_at: string;
            }>;
            const nodes = hydrateNodes(fullRows);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ matched: nodes.length, nodes }) }],
            };
          }

          // Execute bulk update: global write lock, write all files, then single incremental index
          const deferredLocks = new Set<string>();
          const fileSnapshots = new Map<string, string>();
          const allWarnings: unknown[] = [];

          function rollbackFiles() {
            for (const [relativePath, originalContent] of fileSnapshots) {
              try { writeNodeFile(vaultPath, relativePath, originalContent); } catch { /* best effort */ }
            }
          }

          acquireGlobalWriteLock();
          try {
            for (const row of matchedRows) {
              const nodeId = row.id;
              const absPath = join(vaultPath, nodeId);
              if (!existsSync(absPath)) {
                throw new Error(`File not found on disk: ${nodeId}. Database and filesystem are out of sync.`);
              }

              // Snapshot before writing
              if (!fileSnapshots.has(nodeId)) {
                fileSnapshots.set(nodeId, readFileSync(absPath, 'utf-8'));
              }

              const raw = readFileSync(absPath, 'utf-8');
              const parsed = parseFile(nodeId, raw);

              // Title: existing frontmatter or filename stem
              const nodeTitle = typeof parsed.frontmatter.title === 'string'
                ? parsed.frontmatter.title
                : nodeId.replace(/\.md$/, '').split('/').pop()!;

              // Types: provided or existing
              const nodeTypes = types !== undefined ? types : parsed.types;

              // Merge fields: existing (excluding meta-keys) + updates
              const mergedFields: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(parsed.frontmatter)) {
                if (key === 'title' || key === 'types') continue;
                mergedFields[key] = value;
              }
              if (fieldUpdates) {
                for (const [key, value] of Object.entries(fieldUpdates)) {
                  if (key === 'title' || key === 'types') continue;
                  if (value === null) {
                    delete mergedFields[key];
                  } else {
                    mergedFields[key] = value;
                  }
                }
              }

              // Validate against schemas
              const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
              const hasSchemas = nodeTypes.some(t => schemaCheck.get(t) !== undefined);
              if (hasSchemas) {
                const mergeResult = mergeSchemaFields(db, nodeTypes);
                const forValidation = {
                  filePath: nodeId,
                  frontmatter: {},
                  types: nodeTypes,
                  fields: Object.entries(mergedFields).map(([key, value]) => ({
                    key,
                    value,
                    valueType: inferFieldType(value),
                  })),
                  wikiLinks: [],
                  mdast: { type: 'root' as const, children: [] },
                  contentText: '',
                  contentMd: '',
                };
                const validation = validateNode(forValidation, mergeResult);
                allWarnings.push(...validation.warnings);
              }

              // Serialize + write (no per-file index — deferred to incremental pass)
              const fieldOrder = computeFieldOrder(nodeTypes, db);
              const content = serializeNode({
                title: nodeTitle,
                types: nodeTypes,
                fields: mergedFields,
                body: parsed.contentMd || undefined,
                fieldOrder,
              });

              writeNodeFile(vaultPath, nodeId, content, deferredLocks);
            }
          } catch (err) {
            rollbackFiles();
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: message, code: 'INTERNAL_ERROR', rolled_back: true }),
              }],
              isError: true,
            };
          } finally {
            releaseGlobalWriteLock();
            for (const lockedPath of deferredLocks) {
              releaseWriteLock(lockedPath);
            }
          }

          // Single incremental index pass after all writes complete
          incrementalIndex(db, vaultPath);
          resolveReferences(db);

          // Hydrate updated nodes for response
          const updatedRows = db.prepare(
            `SELECT id, file_path, node_type, title, content_text, content_md, updated_at
             FROM nodes WHERE id IN (${matchedRows.map(() => '?').join(',')})`
          ).all(...matchedRows.map(r => r.id)) as Array<{
            id: string; file_path: string; node_type: string; title: string | null;
            content_text: string; content_md: string | null; updated_at: string;
          }>;
          const nodes = hydrateNodes(updatedRows);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ updated: nodes.length, nodes, warnings: allWarnings }) }],
          };
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
        }
      }

      // Neither node_id nor query provided
      return toolError('Either node_id or query is required', 'VALIDATION_ERROR');
    },
  );

  server.tool(
    'batch-mutate',
    'Execute multiple mutations atomically. All operations succeed or all are rolled back. Supports create, update, delete, link, and unlink.',
    {
      operations: z.array(z.object({
        op: z.enum(['create', 'update', 'delete', 'link', 'unlink'])
          .describe('Operation type'),
        params: z.record(z.string(), z.unknown())
          .describe('Operation parameters (same as standalone tool)'),
      })).describe('Array of operations to execute in order'),
    },
    async (params) => {
      try {
        return batchMutate(params);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'delete-node',
    'Delete a node and its file from the vault. Incoming references in other files become broken links.',
    {
      node_id: z.string().min(1).describe('Vault-relative file path of the node to delete, e.g. "tasks/review.md"'),
    },
    async ({ node_id }) => {
      if (hasPathTraversal(node_id)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      try {
        return db.transaction(() => {
          const result = deleteNodeInner({ node_id });
          if (!('isError' in result)) resolveReferences(db);
          return result;
        })();
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'semantic-search',
    'Search by semantic similarity with optional type and field filters',
    {
      query: z.string().min(1).describe('Natural language search query'),
      schema_type: z.string().min(1).optional().describe('Filter results by schema type'),
      filters: z.array(z.object({
        field: z.string().min(1),
        operator: z.literal('eq'),
        value: z.string(),
      })).optional().describe('Field equality filters'),
      limit: z.number().int().min(1).optional().describe('Max results (default 10)'),
      include_chunks: z.boolean().optional().describe('Include matching chunk text'),
    },
    async ({ query, schema_type, filters, limit, include_chunks }) => {
      if (!embeddingProvider) {
        return {
          content: [{ type: 'text' as const, text: 'Semantic search is not configured. Provide an embedding config when starting the engine.' }],
        };
      }
      try {
        const [queryVector] = await embeddingProvider.embed([query]);
        const queryBuffer = Buffer.from(new Float32Array(queryVector).buffer);
        const results = semanticSearch(db, queryBuffer, {
          schema_type, filters, limit, include_chunks,
        });
        const pendingEmbeddings = getPendingEmbeddingCount(db);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              results,
              ...(pendingEmbeddings > 0 ? { pending_embeddings: pendingEmbeddings } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return toolError(`Semantic search failed: ${err instanceof Error ? err.message : String(err)}`, 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'traverse-graph',
    'Traverse the relationship graph from a starting node. Returns connected nodes within N hops, with edges showing how they are connected. Use direction to control whether to follow outgoing links, incoming links, or both.',
    {
      node_id: z.string().min(1)
        .describe("ID of the starting node (vault-relative path, e.g. 'projects/acme.md')"),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
        .describe("'outgoing': follow links FROM this node. 'incoming': follow links TO this node. 'both': follow both."),
      rel_types: z.array(z.string().min(1)).optional()
        .describe("Only traverse these relationship types, e.g. ['assignee', 'source']. Omit for all types."),
      target_types: z.array(z.string().min(1)).optional()
        .describe("Filter result nodes to those with at least one of these schema types. Does NOT affect traversal — all nodes are explored, but only matching types appear in the response."),
      max_depth: z.number().int().min(1).max(10).default(2)
        .describe("Maximum hops from the starting node (1-10). Default 2."),
    },
    async ({ node_id, direction, rel_types, target_types, max_depth }) => {
      if (hasPathTraversal(node_id)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      try {
        const result = traverseGraph(db, {
          node_id,
          direction,
          rel_types,
          target_types,
          max_depth,
        });

        // Hydrate root
        const rootRow = db.prepare(
          'SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id = ?'
        ).get(result.root_id) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string };
        const [hydratedRoot] = hydrateNodes([rootRow]);

        // Hydrate discovered nodes
        let hydratedNodes: Array<Record<string, unknown>> = [];
        if (result.node_ids.length > 0) {
          const ids = result.node_ids.map(n => n.id);
          const nodeRows: Array<{ id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string }> = [];
          for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = db.prepare(
              `SELECT id, file_path, node_type, title, content_text, content_md, updated_at
               FROM nodes WHERE id IN (${placeholders})`
            ).all(...chunk) as typeof nodeRows;
            nodeRows.push(...rows);
          }

          const hydrated = hydrateNodes(nodeRows);

          // Attach depth to each hydrated node
          const depthMap = new Map(result.node_ids.map(n => [n.id, n.depth]));
          hydratedNodes = hydrated.map(n => ({
            ...n,
            depth: depthMap.get(n.id as string) ?? 0,
          }));
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              root: hydratedRoot,
              nodes: hydratedNodes,
              edges: result.edges,
            }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // traverse-graph throws "Node not found:" for missing nodes
        if (msg.startsWith('Node not found:')) {
          return toolError(msg, 'NOT_FOUND');
        }
        return toolError(msg, 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'project-status',
    'Get detailed status of a project: task counts, completion percentage, tasks grouped by status, overdue tasks, recent activity.',
    {
      project_id: z.string().min(1).describe('Project node ID (vault-relative path)'),
    },
    async ({ project_id }) => {
      return projectStatusHandler(db, hydrateNodes, { project_id });
    },
  );

  server.tool(
    'daily-summary',
    'Get a summary for a given date: overdue tasks, due today, due this week, recently modified nodes, active projects with task stats.',
    {
      date: z.string().optional()
        .describe('ISO date (YYYY-MM-DD), defaults to today'),
    },
    async ({ date }) => {
      return dailySummaryHandler(db, { date });
    },
  );

  server.tool(
    'create-meeting-notes',
    'Create a meeting note with linked attendees and optional project. Auto-creates minimal person stubs for unknown attendees. Returns the meeting node plus lists of resolved vs. created attendees.',
    {
      title: z.string().min(1).describe('Meeting title'),
      date: z.string().describe('Meeting date (ISO format YYYY-MM-DD)'),
      attendees: z.array(z.string().min(1)).describe('Attendee names (resolved to person nodes; stubs created for unknowns)'),
      project: z.string().optional().describe('Project name or wiki-link to associate'),
      agenda: z.string().optional().describe('Agenda text for the meeting body'),
      body: z.string().optional().describe('Additional body content'),
    },
    async (params) => {
      return createMeetingNotesHandler(db, batchMutate, params);
    },
  );

  server.tool(
    'extract-tasks',
    'Create task nodes from pre-extracted action items and link them back to the source node. The agent identifies action items; this tool orchestrates creation via batch-mutate.',
    {
      source_node_id: z.string().min(1).describe('Node ID the tasks were extracted from'),
      tasks: z.array(z.object({
        title: z.string().min(1).describe('Task title'),
        assignee: z.string().optional().describe('Person name or wiki-link'),
        due_date: z.string().optional().describe('ISO date'),
        priority: z.string().optional().describe('e.g. high, medium, low'),
        status: z.string().optional().describe('Defaults to "todo"'),
        fields: z.record(z.string(), z.unknown()).optional().describe('Additional fields'),
      })).min(1).describe('Pre-extracted task definitions'),
    },
    async (params) => {
      return extractTasksHandler(db, batchMutate, params);
    },
  );

  // ── infer-schemas ──────────────────────────────────────────────
  server.tool(
    'infer-schemas',
    'Analyze indexed vault data and infer schema definitions. Detects field types, enum candidates, discrepancies against existing schemas, and shared fields across types. Modes: report (default, analysis only), merge (expand existing schemas), overwrite (replace entirely).',
    {
      mode: z.enum(['report', 'merge', 'overwrite']).default('report')
        .describe('report = analysis only; merge = expand existing schemas; overwrite = replace entirely'),
      types: z.array(z.string().min(1)).optional()
        .describe('Limit analysis to specific types. Omit to analyze all.'),
    },
    async ({ mode, types }) => {
      const analysis = analyzeVault(db, types);

      if (analysis.types.length === 0) {
        if (types && types.length > 0) {
          return toolError(
            `Type '${types[0]}' not found in indexed data.`,
            'NOT_FOUND',
          );
        }
        return toolError('No indexed nodes found. Run incremental index first.', 'VALIDATION_ERROR');
      }

      // Check that all requested types were found
      if (types) {
        const foundNames = new Set(analysis.types.map(t => t.name));
        const missing = types.find(t => !foundNames.has(t));
        if (missing) {
          return toolError(`Type '${missing}' not found in indexed data.`, 'NOT_FOUND');
        }
      }

      const response: Record<string, unknown> = { types: analysis.types };

      if (mode !== 'report') {
        const existingSchemas = new Map(
          getAllSchemas(db).map(s => [s.name, s]),
        );
        const schemas = generateSchemas(analysis, mode as InferenceMode, existingSchemas);
        const filesWritten = writeSchemaFiles(schemas, vaultPath);

        // Reload schemas into DB so changes take effect immediately
        loadSchemas(db, vaultPath);

        response.files_written = filesWritten;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      };
    },
  );

  // --- summarize-node tool ---
  server.tool(
    'summarize-node',
    'Read a node and all its embedded content (audio transcriptions, PDFs, images, documents), returning everything assembled as text. Use this when asked to summarize, review, or analyze a note — especially meeting notes with audio recordings. The tool handles all content extraction; the calling model does the summarization. Also accepts a title instead of a full file path.',
    {
      node_id: z.string().min(1).optional()
        .describe("Vault-relative file path, e.g. 'Meetings/Q1 Planning.md'"),
      title: z.string().min(1).optional()
        .describe("Node title for lookup, e.g. 'Q1 Planning'. Resolved via wiki-link resolution logic. Use when you know the name but not the directory."),
    },
    async ({ node_id, title }) => {
      // 1. Resolve node ID
      let resolvedId = node_id;
      if (!resolvedId) {
        if (!title) {
          return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
        }
        const { titleMap, pathMap } = buildLookupMaps(db);
        const resolved = resolveTargetWithMaps(title, titleMap, pathMap);
        if (!resolved) {
          const candidates = titleMap.get(title.toLowerCase());
          if (candidates && candidates.length > 1) {
            return toolError(
              `Multiple nodes match title '${title}': ${candidates.join(', ')}`,
              'VALIDATION_ERROR',
            );
          }
          return toolError(`No node found with title '${title}'`, 'NOT_FOUND');
        }
        resolvedId = resolved;
      }

      if (hasPathTraversal(resolvedId)) {
        return toolError('Invalid node_id: path traversal not allowed', 'VALIDATION_ERROR');
      }

      // 2. Load node from DB
      const row = db.prepare(`
        SELECT id, file_path, node_type, title, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(resolvedId) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return toolError(`Node not found: ${resolvedId}`, 'NOT_FOUND');
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });
      const nodeTitle = (node.title as string) ?? resolvedId;
      const types = (node.types as string[]).join(', ') || 'none';
      const fields = node.fields as Record<string, string>;

      // Read raw markdown from disk for embed detection
      const absPath = join(vaultPath, row.file_path);
      const raw = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : null;

      // 3. Extract body (from content_md or raw markdown)
      const body = (row.content_md as string) ?? '';

      // 4. Resolve embeds
      const contentBlocks: Array<ImageContent | TextContent> = [];
      const embedInventory: string[] = [];

      if (raw) {
        const sourceDir = dirname(absPath);
        const embeds = resolveEmbeds(raw, vaultPath, sourceDir);

        for (const embed of embeds) {
          if (!embed.absolutePath) {
            embedInventory.push(`${embed.filename} (not found on disk)`);
            contentBlocks.push({
              type: 'text' as const,
              text: `## ${embed.attachmentType === 'unknown' ? 'File' : embed.attachmentType.charAt(0).toUpperCase() + embed.attachmentType.slice(1)}: ${embed.filename}\n\n⚠️ File not found on disk`,
            });
            continue;
          }

          let result;
          switch (embed.attachmentType) {
            case 'image':
              result = readImage(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (image${result.ok ? '' : ', failed'})`);
              if (result.ok) {
                // Add image blocks then a label
                contentBlocks.push(...result.content);
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Image: ${embed.filename}\n(image returned above)`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Image: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to read image'}`,
                });
              }
              break;
            case 'audio':
              result = await readAudio(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (audio${result.ok ? ', transcribed' : ', failed'})`);
              if (result.ok) {
                const transcriptText = result.content
                  .filter((c): c is TextContent => c.type === 'text')
                  .map(c => c.text)
                  .join('\n\n');
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Audio: ${embed.filename}\n\n${transcriptText}`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Audio: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to transcribe audio'}`,
                });
              }
              break;
            case 'document':
              result = await readDocument(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (document${result.ok ? '' : ', failed'})`);
              if (result.ok) {
                const docText = result.content
                  .filter((c): c is TextContent => c.type === 'text')
                  .map(c => c.text)
                  .join('\n\n');
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Document: ${embed.filename}\n\n${docText}`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Document: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to read document'}`,
                });
              }
              break;
            default:
              embedInventory.push(`${embed.filename} (unknown type, skipped)`);
              break;
          }
        }
      }

      // 5. Build header
      const fieldLines = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const embedSummary = embedInventory.length > 0
        ? `**Embedded content found:** ${embedInventory.join('; ')}`
        : '**No embedded content found**';

      const header = `## Node: ${nodeTitle}\n**Types:** ${types}\n**Fields:** ${fieldLines || 'none'}\n\n${embedSummary}\n---`;

      // 6. Assemble response
      return {
        content: [
          { type: 'text' as const, text: header },
          { type: 'text' as const, text: `## Node Content\n\n${body}` },
          ...contentBlocks,
        ],
      };
    },
  );

  // --- read-embedded tool ---
  server.tool(
    'read-embedded',
    'Read and return embedded attachments (![[file]]) from a vault note. Images returned as base64, audio transcribed via Whisper, documents as extracted text.',
    {
      node_id: z.string().min(1).describe('Vault-relative file path of the node to read embeds from, e.g. "notes/meeting.md"'),
      filter_type: z.enum(['all', 'audio', 'image', 'document']).optional().default('all')
        .describe('Filter to specific attachment types'),
    },
    async ({ node_id, filter_type }) => {
      if (hasPathTraversal(node_id)) {
        return toolError('Invalid node_id: path traversal not allowed', 'VALIDATION_ERROR');
      }

      // Check node exists in DB
      const nodeRow = db.prepare('SELECT id, file_path FROM nodes WHERE id = ?').get(node_id) as
        | { id: string; file_path: string }
        | undefined;
      if (!nodeRow) {
        return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
      }

      // Read raw markdown from disk
      const absPath = join(vaultPath, nodeRow.file_path);
      if (!existsSync(absPath)) {
        return toolError(`File not found on disk: ${nodeRow.file_path}`, 'NOT_FOUND');
      }
      const raw = readFileSync(absPath, 'utf-8');

      // Resolve embeds
      const sourceDir = dirname(absPath);
      const embeds = resolveEmbeds(raw, vaultPath, sourceDir, filter_type === 'all' ? undefined : filter_type);

      if (embeds.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No embedded attachments found in ${node_id}.` }],
        };
      }

      // Read each resolved embed
      const contentBlocks: Array<ImageContent | TextContent> = [];
      const counts = { image: 0, audio: 0, document: 0, unresolved: 0, errors: 0 };

      for (const embed of embeds) {
        if (!embed.absolutePath) {
          counts.unresolved++;
          continue;
        }

        let result;
        switch (embed.attachmentType) {
          case 'image':
            result = readImage(embed.absolutePath, embed.filename);
            if (result.ok) counts.image++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          case 'audio':
            result = await readAudio(embed.absolutePath, embed.filename);
            if (result.ok) counts.audio++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          case 'document':
            result = await readDocument(embed.absolutePath, embed.filename);
            if (result.ok) counts.document++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          default:
            counts.unresolved++;
            break;
        }
      }

      // Build summary
      const parts: string[] = [];
      if (counts.image > 0) parts.push(`${counts.image} image${counts.image > 1 ? 's' : ''}`);
      if (counts.audio > 0) parts.push(`${counts.audio} audio file${counts.audio > 1 ? 's' : ''} (transcribed)`);
      if (counts.document > 0) parts.push(`${counts.document} document${counts.document > 1 ? 's' : ''}`);
      if (counts.errors > 0) parts.push(`${counts.errors} failed`);
      if (counts.unresolved > 0) parts.push(`${counts.unresolved} could not be resolved`);
      const summary = `Found ${parts.join(', ')}.`;

      return {
        content: [
          { type: 'text' as const, text: summary },
          ...contentBlocks,
        ],
      };
    },
  );

  server.tool(
    'normalize-fields',
    'Normalize frontmatter field names and value shapes across the vault to match schema definitions. Run with mode=audit first to review changes, then mode=apply to execute.',
    {
      mode: z.enum(['audit', 'apply']).default('audit')
        .describe('audit: report what would change. apply: execute normalization.'),
      schema_type: z.string().min(1).optional()
        .describe('Limit to nodes of a specific type. Omit to normalize all typed nodes.'),
      rules: z.array(z.object({
        action: z.enum(['rename_key', 'coerce_value']),
        from_key: z.string().min(1),
        to_key: z.string().min(1).optional(),
        target_type: z.string().min(1).optional(),
      })).optional()
        .describe('Explicit normalization rules. Omit to auto-infer from schema definitions.'),
    },
    ({ mode, schema_type, rules }) => {
      try {
        const result = normalizeFields(db, vaultPath, { mode, schema_type, rules });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, 'INTERNAL_ERROR');
      }
    },
  );

  server.tool(
    'find-duplicates',
    'Find nodes with similar or identical titles. Useful for vault hygiene and deduplication.',
    {
      schema_type: z.string().min(1).optional()
        .describe('Scope detection to a specific type, e.g. "meeting", "task"'),
      include_fields: z.boolean().optional().default(false)
        .describe('Layer in field overlap scoring for more accurate results'),
      threshold: z.number().min(0).max(1).optional().default(0.8)
        .describe('Minimum similarity score (0.0–1.0) to report as duplicate'),
      limit: z.number().int().min(1).optional().default(50)
        .describe('Maximum number of duplicate groups to return'),
    },
    async ({ schema_type, include_fields, threshold, limit }) => {
      try {
        const result = findDuplicates(db, { schema_type, include_fields, threshold, limit });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
      }
    },
  );

  return server;
}
