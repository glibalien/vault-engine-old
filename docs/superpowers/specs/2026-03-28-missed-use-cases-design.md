# Missed Use Cases — Design Spec

Six changes to fill gaps identified during tool suite review: bulk field updates, standalone delete, relationship-based filtering, path filtering, duplicate detection, and `get-recent` consolidation.

Net tool count change: 23 → 24 (+`delete-node`, +`find-duplicates`, -`get-recent`).

## 1. Bulk Field Updates via `update-node` Query Mode

### Current State

`update-node` requires `node_id` to target a single node. Vault-wide field patches (e.g., "set `priority` to `medium` on all tasks where it's null") require N round-trips.

### Change

Add an optional `query` object as an alternative to `node_id`. When present, resolve matching nodes using the same SQL construction as `query-nodes`, then apply the field patch to each.

### New Params

```
query?: {
  schema_type?: string
  filters?: Array<{ field: string, operator: string, value: string | number | boolean | string[] }>
}
dry_run?: boolean  // default false; only valid with query
```

### Constraints

- `node_id` and `query` are mutually exclusive — error if both provided.
- `body`, `append_body`, `title`, and `types` are forbidden when `query` is present — validation error. These are per-node identity or content changes.
- `dry_run` only valid with `query` — returns matched nodes without writing.
- At least one of `schema_type` or `filters` must be present in `query` (prevent accidental vault-wide update).

### Execution

- Resolve matching nodes via the same dynamic SQL as `query-nodes` (reuse or extract the SQL builder).
- Wrap all updates in a single transaction with file snapshot/rollback (same pattern as `batch-mutate`).
- Call `updateNodeInner` for each matched node.
- Run `resolveReferences(db)` once at the end.

### Response

Single-node mode (existing): `{ node, warnings }`.

Query mode: `{ updated: number, nodes: [...hydrated], warnings: [...] }`.

Dry-run mode: `{ matched: number, nodes: [...hydrated] }` — no writes.

---

## 2. Standalone `delete-node`

### Current State

Delete only exists as an op inside `batch-mutate` via `deleteNodeInner`.

### Change

Register a new `delete-node` tool that wraps `deleteNodeInner` in a transaction + `resolveReferences`.

### Params

```
node_id: string  // required, vault-relative path
```

### Behavior

1. Validate node exists in DB and on disk.
2. Delete file from disk.
3. Cascade DB rows (relationships, fields, node_types, nodes, files).
4. Run `resolveReferences(db)` to clear stale `resolved_target_id` pointers.
5. Return `{ node_id, deleted: true }`.

Incoming references in other files become broken links — same as filesystem deletion. No `delete_references` flag; cleaning up dangling references is a separate concern.

---

## 3a. Fix Reference Field Filtering in `query-nodes`

### Current State

The `eq` operator does `value_text = ?` with `String(value)`. For reference fields, `value_text` stores `"[[Bob Jones]]"`, so filtering by `"Bob Jones"` fails silently.

### Change

Add reference-aware comparison via CASE expressions on `value_type` (already stored in the `fields` table — no schema lookups needed).

### Operators Affected

**`eq` / `neq`**: When `value_type = 'reference'`, strip `[[` and `]]` before comparison:

```sql
CASE f0.value_type
  WHEN 'reference' THEN REPLACE(REPLACE(f0.value_text, '[[', ''), ']]', '')
  ELSE f0.value_text
END = ?
```

**`contains`**: Add an OR branch for `list`-typed fields that may contain references:

```sql
(f0.value_text LIKE '%' || ? || '%' ESCAPE '\'
 OR (f0.value_type = 'list' AND f0.value_text LIKE '%[[' || ? || ']]%'))
```

This handles `attendees: [[[Alice]], [[Bob]]]` where `value_text` is `["[[Alice]]","[[Bob]]"]`.

**`in`**: Unwrap reference values before checking membership — same REPLACE approach as `eq`.

**`gt`/`lt`/`gte`/`lte`**: No change needed. Ordering on reference text is rarely meaningful; existing behavior is fine.

---

## 3b. `references` Filter on `query-nodes`

### Change

Add an optional `references` param that JOINs the `relationships` table.

### New Param

```
references?: {
  target: string                                    // node title or ID
  rel_type?: string                                 // e.g. "assignee", "wiki-link"
  direction?: 'outgoing' | 'incoming' | 'both'     // default 'outgoing'
}
```

### Semantics by Direction

- **`outgoing`** (default): Find nodes that link TO this target. Matches `relationships.resolved_target_id` or `relationships.target_id` (for unresolved links).
- **`incoming`**: Find nodes that this target links TO. Matches `relationships.source_id`.
- **`both`**: Union of the above.

### Resolution

`target` is resolved before querying:
1. Try exact node ID match (`nodes.id`).
2. Fall back to title lookup via `resolveTarget(db, target)`.
3. If resolution fails, use raw text match against `target_id`.

### Composability

AND'd with all other filters. Example — "find all tasks assigned to Alice":

```json
{
  "schema_type": "task",
  "references": { "target": "Alice", "rel_type": "assignee" }
}
```

### SQL

For `outgoing`:
```sql
JOIN relationships r_ref ON r_ref.source_id = n.id
  AND (r_ref.resolved_target_id = ? OR (r_ref.resolved_target_id IS NULL AND LOWER(r_ref.target_id) = LOWER(?)))
```

Plus optional `AND r_ref.rel_type = ?` when `rel_type` is provided.

For `incoming`:
```sql
JOIN relationships r_ref ON r_ref.source_id = ?
  AND (r_ref.resolved_target_id = n.id)
```

Where `?` is the resolved target node ID.

For `both`: use an EXISTS subquery with OR:
```sql
WHERE EXISTS (
  SELECT 1 FROM relationships r_ref
  WHERE (r_ref.source_id = n.id AND (r_ref.resolved_target_id = ? OR (r_ref.resolved_target_id IS NULL AND LOWER(r_ref.target_id) = LOWER(?))))
     OR (r_ref.source_id = ? AND r_ref.resolved_target_id = n.id)
)
```

---

## 4. Path/Folder Filter on `query-nodes`

### New Param

```
path_prefix?: string  // e.g. "Meetings/", "projects/acme/"
```

### SQL

```sql
WHERE n.id LIKE ? || '%'
```

Normalize: if the provided prefix doesn't end with `/`, append it. This prevents `Meetings` from matching `Meetings-archive/foo.md`.

### Composability

AND'd with all other filters. "Tasks in the projects folder":

```json
{ "schema_type": "task", "path_prefix": "projects/" }
```

---

## 5. Duplicate Detection — `find-duplicates`

### New Tool

```
find-duplicates
```

### Params

```
schema_type?: string       // scope to a type
include_fields?: boolean   // default false — add field overlap scoring
threshold?: number         // 0.0–1.0, default 0.8 — minimum similarity
limit?: number             // default 50 — max groups returned
```

### Title Similarity (Baseline)

1. Load all `(id, title)` from `nodes`, optionally filtered by type.
2. Normalize: lowercase, trim, collapse whitespace, strip punctuation.
3. Exact matches on normalized title → group immediately (similarity 1.0).
4. Near-matches: Levenshtein distance on normalized titles, scored as `1 - (distance / max_length)`. Pairs above `threshold` are grouped.

For performance in large vaults: bucket by first 3 characters of normalized title to prune O(n^2) comparisons. Only compare within same bucket and adjacent buckets.

### Field Overlap (when `include_fields: true`)

For each candidate group from title matching:
1. Load fields for all nodes in the group.
2. Compute Jaccard similarity on `{ key: value }` pairs.
3. Combined score: `0.7 * title_similarity + 0.3 * field_similarity`.
4. Re-filter against `threshold`.

### Response

```json
{
  "groups": [
    {
      "similarity": 0.95,
      "reason": "identical normalized title",
      "nodes": [
        { "id": "meetings/weekly-standup.md", "title": "Weekly Standup", "types": ["meeting"] },
        { "id": "meetings/weekly-standup-1.md", "title": "Weekly Standup", "types": ["meeting"] }
      ]
    }
  ],
  "total_groups": 3
}
```

---

## 6. Remove `get-recent`, Consolidate into `query-nodes`

### Current State

`get-recent` filters by `schema_type` and `since` (ISO date), orders by `updated_at DESC`. This is a strict subset of `query-nodes` except for the `since` param, which `query-nodes` lacks.

### Change

1. Add `since` param to `query-nodes`:

```
since?: string  // ISO date — filter where updated_at > value
```

SQL: `conditions.push('n.updated_at > ?')`.

2. Delete `get-recent` tool registration, handler, and tests.

### Migration

Every `get-recent` call maps directly:

| `get-recent` | `query-nodes` |
|---|---|
| `{ schema_type: "task", since: "2026-03-27", limit: 10 }` | `{ schema_type: "task", since: "2026-03-27", order_by: "updated_at DESC", limit: 10 }` |
| `{ limit: 5 }` | `{ order_by: "updated_at DESC", limit: 5 }` |

Note: the second case currently violates `query-nodes`' "at least one filter required" constraint. We should relax this: when `since` is provided, it counts as a filter (no need for `schema_type`, `full_text`, or `filters`). Similarly, `path_prefix` and `references` should count as sufficient filters.

---

## Implementation Order

1. **Bulk updates on `update-node`** — highest priority gap
2. **Standalone `delete-node`** — trivial lift
3. **Reference field filtering fix** (3a) — fix existing behavior
4. **`references` filter** (3b) — new capability
5. **`path_prefix` filter** (4) — new capability
6. **`find-duplicates`** (5) — new tool
7. **Remove `get-recent`** (6) — consolidation, add `since` to `query-nodes`

Items 3a–4 could be done in a single pass over `query-nodes` SQL construction since they all modify the same function. Item 6 should go last since it's a removal that touches tests.
