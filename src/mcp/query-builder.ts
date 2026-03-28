/**
 * Extracted query builder for structured node queries.
 * Produces parameterized SQL for the query-nodes tool and future bulk-update query mode.
 */

export interface QueryFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';
  value: string | number | boolean | string[];
}

export interface QueryOptions {
  schema_type?: string;
  full_text?: string;
  filters?: QueryFilter[];
  order_by?: string;
  limit: number;
  /** Future: filter by updated_at >= since */
  since?: string;
  /** Future: filter by node id path prefix */
  path_prefix?: string;
  /** Future: filter by relationship references */
  references?: {
    target: string;
    rel_type?: string;
    direction?: 'outgoing' | 'incoming' | 'both';
  };
  /** Future: pre-resolved target id for references filter */
  resolvedTargetId?: string | null;
  /** Select mode: 'full' returns all columns, 'id-only' returns just n.id */
  select?: 'full' | 'id-only';
}

export interface QueryResult {
  sql: string;
  params: unknown[];
}

export function buildQuerySql(opts: QueryOptions): QueryResult {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const conditions: string[] = [];
  const conditionParams: unknown[] = [];

  // FTS path
  let selectFrom: string;
  let defaultOrder: string;
  const selectMode = opts.select ?? 'full';

  if (opts.full_text) {
    if (selectMode === 'id-only') {
      selectFrom = `
            SELECT n.id
            FROM nodes_fts fts
            JOIN nodes n ON n.rowid = fts.rowid`;
    } else {
      selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.updated_at, fts.rank
            FROM nodes_fts fts
            JOIN nodes n ON n.rowid = fts.rowid`;
    }
    conditions.push('nodes_fts MATCH ?');
    conditionParams.push(opts.full_text);
    defaultOrder = 'fts.rank';
  } else {
    if (selectMode === 'id-only') {
      selectFrom = `
            SELECT n.id
            FROM nodes n`;
    } else {
      selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.updated_at
            FROM nodes n`;
    }
    defaultOrder = 'n.updated_at DESC';
  }

  // Type filter
  if (opts.schema_type) {
    joins.push('JOIN node_types nt ON nt.node_id = n.id');
    conditions.push('nt.schema_type = ?');
    conditionParams.push(opts.schema_type);
  }

  // Field filters with comparison operators
  if (opts.filters) {
    for (let i = 0; i < opts.filters.length; i++) {
      const { field, operator, value } = opts.filters[i];
      const alias = `f${i}`;
      joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);

      switch (operator) {
        case 'eq':
          conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
          conditionParams.push(field, String(value));
          break;
        case 'neq':
          conditions.push(`${alias}.key = ? AND ${alias}.value_text != ?`);
          conditionParams.push(field, String(value));
          break;
        case 'gt':
        case 'lt':
        case 'gte':
        case 'lte': {
          const sqlOp = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[operator];
          conditions.push(
            `${alias}.key = ? AND CASE ${alias}.value_type ` +
            `WHEN 'number' THEN ${alias}.value_number ${sqlOp} ? ` +
            `WHEN 'date' THEN ${alias}.value_date ${sqlOp} ? ` +
            `ELSE ${alias}.value_text ${sqlOp} ? END`,
          );
          conditionParams.push(field, value, value, value);
          break;
        }
        case 'contains': {
          const escaped = String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          conditions.push(`${alias}.key = ? AND ${alias}.value_text LIKE '%' || ? || '%' ESCAPE '\\'`);
          conditionParams.push(field, escaped);
          break;
        }
        case 'in': {
          const vals = Array.isArray(value) ? value : [value];
          if (vals.length === 0) {
            conditions.push('0'); // Always false — empty IN set matches nothing
            break;
          }
          const placeholders = vals.map(() => '?').join(', ');
          conditions.push(`${alias}.key = ? AND ${alias}.value_text IN (${placeholders})`);
          conditionParams.push(field, ...vals.map(String));
          break;
        }
      }
    }
  }

  // Order by
  let orderClause: string;
  if (opts.order_by && !opts.full_text) {
    // Parse "field_name ASC" or "field_name DESC" or just "field_name"
    const parts = opts.order_by.trim().split(/\s+/);
    const fieldName = parts[0];
    const direction = parts[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    if (fieldName === 'updated_at') {
      orderClause = `n.updated_at ${direction}`;
    } else {
      // Order by a field value — join fields table
      joins.push('LEFT JOIN fields f_order ON f_order.node_id = n.id AND f_order.key = ?');
      joinParams.push(fieldName);
      orderClause = `f_order.value_text ${direction}`;
    }
  } else {
    orderClause = defaultOrder;
  }

  // Assemble params in SQL placeholder order: join params, then condition params, then limit
  const params: unknown[] = [...joinParams, ...conditionParams, opts.limit];

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `${selectFrom}\n${joins.join('\n')}\n${where}\nORDER BY ${orderClause}\nLIMIT ?`;

  return { sql, params };
}
