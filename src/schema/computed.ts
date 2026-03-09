import type Database from 'better-sqlite3';
import type { ComputedDefinition, ComputedFilter } from './types.js';

export type ComputedResult =
  | { value: number }
  | { value: number; numerator: number; denominator: number };

// Known structural keys in ComputedFilter — everything else is a field condition.
const STRUCTURAL_KEYS = new Set(['types_includes', 'references_this']);

function buildCountQuery(
  filter: ComputedFilter,
  nodeId: string,
): { sql: string; params: unknown[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.types_includes) {
    joins.push('JOIN node_types nt ON nt.node_id = n.id');
    conditions.push('nt.schema_type = ?');
    params.push(filter.types_includes);
  }

  if (filter.references_this) {
    joins.push('JOIN relationships r ON r.source_id = n.id');
    conditions.push('r.rel_type = ?');
    conditions.push('r.resolved_target_id = ?');
    params.push(filter.references_this, nodeId);
  }

  // Field conditions: any key not in STRUCTURAL_KEYS
  let fieldIdx = 0;
  for (const [key, value] of Object.entries(filter)) {
    if (STRUCTURAL_KEYS.has(key) || value === undefined) continue;
    const alias = `ff${fieldIdx++}`;
    joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);
    conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
    params.push(key, value);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(DISTINCT n.id) AS cnt FROM nodes n\n${joins.join('\n')}\n${where}`;

  return { sql, params };
}

export function evaluateComputed(
  db: Database.Database,
  nodeId: string,
  computedDefs: Record<string, ComputedDefinition>,
): Record<string, ComputedResult> {
  const results: Record<string, ComputedResult> = {};

  for (const [name, def] of Object.entries(computedDefs)) {
    if (def.aggregate === 'count') {
      const { sql, params } = buildCountQuery(def.filter, nodeId);
      const row = db.prepare(sql).get(...params) as { cnt: number };
      results[name] = { value: row.cnt };
    } else if (def.aggregate === 'percentage') {
      // Denominator: count matching filter only
      const denomQ = buildCountQuery(def.filter, nodeId);
      const denomRow = db.prepare(denomQ.sql).get(...denomQ.params) as { cnt: number };
      const denominator = denomRow.cnt;

      // Numerator: count matching filter + numerator field conditions
      const numeratorFilter: ComputedFilter = { ...def.filter };
      for (const [key, value] of Object.entries(def.numerator)) {
        numeratorFilter[key] = value;
      }
      const numQ = buildCountQuery(numeratorFilter, nodeId);
      const numRow = db.prepare(numQ.sql).get(...numQ.params) as { cnt: number };
      const numerator = numRow.cnt;

      const value = denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 100;
      results[name] = { value, numerator, denominator };
    }
  }

  return results;
}
