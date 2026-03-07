// src/search/search.ts
import type Database from 'better-sqlite3';
import type { SearchOptions, SearchResult } from './types.js';

interface NodeRow {
  id: string;
  file_path: string;
  node_type: string;
  content_text: string;
  rank: number;
}

interface TypeRow {
  node_id: string;
  schema_type: string;
}

interface FieldRow {
  node_id: string;
  key: string;
  value_text: string;
  value_type: string;
}

export function search(db: Database.Database, options: SearchOptions): SearchResult[] {
  const limit = options.limit ?? 20;

  // Phase 1: FTS5 match + optional type filter
  let sql: string;
  const params: unknown[] = [];

  if (options.schemaType) {
    sql = `
      SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      JOIN node_types nt ON nt.node_id = n.id
      WHERE nodes_fts MATCH ?
        AND nt.schema_type = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params.push(options.query, options.schemaType, limit);
  } else {
    sql = `
      SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params.push(options.query, limit);
  }

  const rows = db.prepare(sql).all(...params) as NodeRow[];

  if (rows.length === 0) return [];

  // Phase 2: Batch-load types and fields
  const nodeIds = rows.map(r => r.id);
  const placeholders = nodeIds.map(() => '?').join(',');

  const typeRows = db.prepare(
    `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as TypeRow[];

  const fieldRows = db.prepare(
    `SELECT node_id, key, value_text, value_type FROM fields WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as FieldRow[];

  // Phase 3: Group and assemble
  const typesMap = new Map<string, string[]>();
  for (const row of typeRows) {
    const arr = typesMap.get(row.node_id) ?? [];
    arr.push(row.schema_type);
    typesMap.set(row.node_id, arr);
  }

  const fieldsMap = new Map<string, Record<string, { value: string; type: string }>>();
  for (const row of fieldRows) {
    const rec = fieldsMap.get(row.node_id) ?? {};
    rec[row.key] = { value: row.value_text, type: row.value_type };
    fieldsMap.set(row.node_id, rec);
  }

  return rows.map(row => ({
    id: row.id,
    filePath: row.file_path,
    nodeType: row.node_type,
    types: typesMap.get(row.id) ?? [],
    fields: fieldsMap.get(row.id) ?? {},
    contentText: row.content_text,
    rank: row.rank,
  }));
}
