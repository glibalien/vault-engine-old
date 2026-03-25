import type Database from 'better-sqlite3';

export interface TraverseOptions {
  node_id: string;
  direction: 'outgoing' | 'incoming' | 'both';
  rel_types?: string[];
  target_types?: string[];
  max_depth: number;
}

export interface TraverseEdge {
  source_id: string;
  target_id: string;
  resolved_target_id: string;
  rel_type: string;
  context: string | null;
}

export interface TraverseResult {
  root_id: string;
  node_ids: Array<{ id: string; depth: number }>;
  edges: TraverseEdge[];
}

interface RelRow {
  id: number;
  source_id: string;
  target_id: string;
  rel_type: string;
  context: string | null;
  resolved_target_id: string | null;
}

const MAX_DEPTH_LIMIT = 10;
const IN_CLAUSE_CHUNK_SIZE = 500;

interface TaggedRelRow extends RelRow {
  _direction: 'outgoing' | 'incoming';
}

function queryRelationships(
  db: Database.Database,
  nodeIds: string[],
  direction: 'outgoing' | 'incoming' | 'both',
): TaggedRelRow[] {
  const results: TaggedRelRow[] = [];

  for (let i = 0; i < nodeIds.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = nodeIds.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');

    if (direction === 'outgoing' || direction === 'both') {
      const rows = db.prepare(
        `SELECT id, source_id, target_id, rel_type, context, resolved_target_id
         FROM relationships
         WHERE source_id IN (${placeholders}) AND resolved_target_id IS NOT NULL`
      ).all(...chunk) as RelRow[];
      for (const row of rows) {
        results.push({ ...row, _direction: 'outgoing' });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const rows = db.prepare(
        `SELECT id, source_id, target_id, rel_type, context, resolved_target_id
         FROM relationships
         WHERE resolved_target_id IN (${placeholders})`
      ).all(...chunk) as RelRow[];
      for (const row of rows) {
        results.push({ ...row, _direction: 'incoming' });
      }
    }
  }

  if (direction === 'both') {
    const seen = new Set<number>();
    return results.filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  return results;
}

export function traverseGraph(db: Database.Database, options: TraverseOptions): TraverseResult {
  const { node_id, direction, rel_types, target_types } = options;
  const maxDepth = Math.max(1, Math.min(MAX_DEPTH_LIMIT, options.max_depth));

  const rootRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id) as { id: string } | undefined;
  if (!rootRow) {
    throw new Error(`Node not found: ${node_id}`);
  }

  const relTypesSet = rel_types ? new Set(rel_types) : null;
  const visited = new Set<string>([node_id]);
  const depthMap = new Map<string, number>([[node_id, 0]]);
  const edges: TraverseEdge[] = [];
  const seenEdgeIds = new Set<number>();
  let currentLevel = [node_id];
  let currentDepth = 0;

  while (currentLevel.length > 0 && currentDepth < maxDepth) {
    const rows = queryRelationships(db, currentLevel, direction);
    const nextLevel: string[] = [];

    for (const row of rows) {
      const neighborId: string | null = row._direction === 'outgoing'
        ? row.resolved_target_id
        : row.source_id;

      if (!neighborId) continue;
      if (relTypesSet && !relTypesSet.has(row.rel_type)) continue;
      if (seenEdgeIds.has(row.id)) continue;
      seenEdgeIds.add(row.id);

      edges.push({
        source_id: row.source_id,
        target_id: row.target_id,
        resolved_target_id: row.resolved_target_id as string,
        rel_type: row.rel_type,
        context: row.context,
      });

      if (visited.has(neighborId)) continue;

      visited.add(neighborId);
      depthMap.set(neighborId, currentDepth + 1);
      nextLevel.push(neighborId);
    }

    currentLevel = nextLevel;
    currentDepth++;
  }

  let nodeIds = Array.from(depthMap.entries())
    .filter(([id]) => id !== node_id)
    .map(([id, depth]) => ({ id, depth }));

  if (target_types && target_types.length > 0) {
    const idsToCheck = nodeIds.map(n => n.id);
    if (idsToCheck.length > 0) {
      const matchingIds = new Set<string>();
      for (let i = 0; i < idsToCheck.length; i += IN_CLAUSE_CHUNK_SIZE) {
        const chunk = idsToCheck.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const typePlaceholders = target_types.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT DISTINCT node_id FROM node_types
           WHERE node_id IN (${placeholders})
             AND schema_type IN (${typePlaceholders})`
        ).all(...chunk, ...target_types) as Array<{ node_id: string }>;
        for (const row of rows) {
          matchingIds.add(row.node_id);
        }
      }
      nodeIds = nodeIds.filter(n => matchingIds.has(n.id));
    }
  }

  return { root_id: node_id, node_ids: nodeIds, edges };
}
