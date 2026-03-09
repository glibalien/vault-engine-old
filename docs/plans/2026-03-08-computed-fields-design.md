# Computed Fields Design

Phase 2 Task 6. Computed fields are read-only derived values defined in schema YAML, evaluated on demand against the DB.

## Schema YAML Format

The `computed:` block uses structured objects rather than a DSL string:

```yaml
computed:
  task_count:
    aggregate: count
    filter:
      types_includes: task
      references_this: source
  completion_pct:
    aggregate: percentage
    numerator:
      status: done
    filter:
      types_includes: task
      references_this: source
```

### Aggregates

- **`count`** — counts nodes matching `filter`. Returns `{ value: number }`.
- **`percentage`** — counts nodes matching `filter` AND `numerator` conditions (numerator), divided by nodes matching `filter` only (denominator). Returns `{ value: number, numerator: number, denominator: number }`. Value is 0–100. If denominator is 0, value is 0.

### Filter Conditions

`filter` supports three kinds of conditions, all ANDed:

- `types_includes: string` — node must have this type in `node_types`.
- `references_this: string` — node must have a relationship with this `rel_type` whose `resolved_target_id` equals the current node's ID.
- Any other key — field equality, matched against `fields.value_text`.

Example with a field condition in filter:

```yaml
filter:
  types_includes: task
  references_this: source
  status: open
```

### Numerator Conditions (percentage only)

`numerator` is a record of field conditions, all ANDed. Example: `{ status: done, priority: high }` means both must match.

## Type Changes (`src/schema/types.ts`)

Replace `computed?: Record<string, { query: string }>` with structured types:

```typescript
interface ComputedFilter {
  types_includes?: string;
  references_this?: string;
  // Any other key is a field equality condition.
  // At evaluation time, strip types_includes and references_this
  // before treating remaining keys as field conditions.
  [field: string]: string | undefined;
}

interface CountDefinition {
  aggregate: 'count';
  filter: ComputedFilter;
}

interface PercentageDefinition {
  aggregate: 'percentage';
  filter: ComputedFilter;
  numerator: Record<string, string>;
}

type ComputedDefinition = CountDefinition | PercentageDefinition;
```

`SchemaDefinition.computed` and `ResolvedSchema.computed` change to `Record<string, ComputedDefinition>`.

## Evaluation Engine (`src/schema/computed.ts`)

New file. Core function:

```typescript
type ComputedResult =
  | { value: number }
  | { value: number; numerator: number; denominator: number }

function evaluateComputed(
  db: Database,
  nodeId: string,
  computedDefs: Record<string, ComputedDefinition>
): Record<string, ComputedResult>
```

### SQL Generation

For a filter like `{ types_includes: 'task', references_this: 'source', status: 'open' }`:

1. Start from `nodes n`.
2. JOIN `node_types nt` for `types_includes` — `nt.type = ?`.
3. JOIN `relationships r` for `references_this` — `r.resolved_target_id = ?` (the current nodeId) AND `r.rel_type = ?`.
4. JOIN `fields f` for each field condition — `f.key = ? AND f.value_text = ?`.
5. `COUNT(DISTINCT n.id)` to avoid double-counting from multiple joins.

For **percentage**, run two queries: one with filter only (denominator), one with filter + numerator field joins (numerator). `value = denominator === 0 ? 0 : (numerator / denominator) * 100`.

All filter/numerator values bound as parameters — no string interpolation in SQL.

### `references_this` Resolution

Matches against `relationships.resolved_target_id` only. Reference resolution must have run (it runs at end of indexing). Raw `target_id` is not consulted.

## MCP Integration

### `get-node`

Add optional `include_computed: boolean` parameter (default false). When true:

1. Load the node's types from `node_types`.
2. For each type, check if a schema exists with computed definitions.
3. Collect all computed definitions (merged across schemas, same as field merging).
4. Call `evaluateComputed(db, nodeId, computedDefs)`.
5. Include results in response under a `computed` key.

### `describe-schema`

No change. Returns computed definitions as-is from the schema.

## What Doesn't Change

- **DB schema** — no new tables; computed values are not stored.
- **Indexer** — no computed field evaluation during indexing.
- **Validator** — computed fields are read-only, nothing to validate.
- **Schema loader** — already stores computed definitions in the `schemas` table; just needs to handle the new structured format instead of `{ query: string }`.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Format | Structured YAML objects | Only two patterns (count, percentage) — too small for a parser, right size for structured objects |
| `references_this` matching | `resolved_target_id` only | Resolution already runs at end of indexing; fallback to raw `target_id` would be inconsistent |
| Evaluation location | `src/schema/computed.ts` | Schema logic, not presentation; keeps MCP layer thin |
| MCP inclusion | Opt-in `include_computed` flag | Extra DB queries per node; callers may not need them |
| Result shape | Rich objects | `{ value, numerator, denominator }` for percentage enables display like "3 of 4 done" |
| Multiple conditions | AND semantics | Trivial to implement; avoids artificial single-condition restriction |
| Filter field conditions | Supported | Same AND semantics as numerator; no reason to restrict when already joining fields table |
| `ComputedFilter` index signature | Strip known keys at eval time | Cleaner YAML than a separate `fields` sub-object; comment in code makes intent clear |
