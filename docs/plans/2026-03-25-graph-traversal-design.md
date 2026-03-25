# Phase 5: Graph Traversal — Design

## Goal

Add an N-hop graph traversal MCP tool (`traverse-graph`) that lets the agent navigate the relationship graph starting from any node, with direction filtering, relationship type filtering, schema type filtering, and cycle detection.

## Scope

This phase covers graph traversal only. Block IDs and sub-file addressing are deferred.

## Architecture Overview

A new `src/graph/` module implements BFS traversal over the existing `relationships` table. No schema changes needed — the relationships infrastructure from Phase 1 (with `resolved_target_id` from Phase 2) provides everything.

```
traverse-graph MCP tool (src/mcp/server.ts)
  └── traverseGraph(db, options)          (src/graph/traversal.ts)
        ├── Level-by-level BFS over relationships table
        ├── Cycle detection via visited Set
        └── Returns raw IDs, depths, and edges
  └── MCP handler hydrates nodes          (reuses hydrateNodes in server.ts)
```

The `traverseGraph` function returns node IDs, depth annotations, and edges — it does not hydrate nodes. Hydration is done by the MCP tool handler using the `hydrateNodes` closure in `server.ts`, consistent with how other tools work.

**Note:** The existing `hydrateNodes` closure does not include `title` in its output. As part of this phase, `hydrateNodes` must be extended to select `nodes.title` and include it in the returned objects. This is a minor change (add `title` to the SELECT and to the mapped output) that also benefits existing tools (`get-recent`, `query-nodes`) which currently omit title.

## Data Model

No new tables or indices. The existing `relationships` table with its indices (`idx_rel_source`, `idx_rel_target`, `idx_rel_type`, `idx_rel_resolved`) is sufficient.

Traversal uses `resolved_target_id` for outgoing edges and `source_id` for incoming edges. Unresolved relationships (`resolved_target_id IS NULL`) are not traversable.

## Types

Module: `src/graph/traversal.ts`

### `TraverseOptions`

```typescript
interface TraverseOptions {
  node_id: string;                    // starting node (must exist in DB)
  direction: 'outgoing' | 'incoming' | 'both';  // default 'both'
  rel_types?: string[];               // filter which edge types to traverse
  target_types?: string[];            // filter which node types appear in results (display only)
  max_depth: number;                  // default 2, capped 1-10
}
```

### `TraverseEdge`

```typescript
interface TraverseEdge {
  source_id: string;                  // node ID of the source
  target_id: string;                  // raw wiki-link text from relationships.target_id
  resolved_target_id: string;         // resolved node ID
  rel_type: string;
  context: string | null;
}
```

Edges include both `target_id` (raw wiki-link text, human-readable) and `resolved_target_id` (node ID, machine-usable for follow-up queries).

### `TraverseResult`

```typescript
interface TraverseResult {
  root_id: string;
  node_ids: Array<{ id: string; depth: number }>;  // excludes root
  edges: TraverseEdge[];
}
```

This is the raw result from `traverseGraph`. The MCP tool handler hydrates `root_id` and `node_ids` into full node objects using `hydrateNodes`.

### MCP response shape (after hydration)

```typescript
{
  root: { id, file_path, node_type, title, types, fields, content_text, updated_at };
  nodes: Array<{ id, file_path, node_type, title, types, fields, content_text, updated_at, depth: number }>;
  edges: TraverseEdge[];
}
```

The hydrated node shape matches what other tools return (including `title`). The root has no `depth` field — it is implicitly depth 0 by definition.

## BFS Algorithm

Level-by-level BFS. Each iteration processes all nodes at the current depth in one batched SQL query, rather than dequeuing one node at a time.

```
1. Validate root node_id exists in DB. Error if not.
2. Initialize:
   - visited = Set{root}
   - currentLevel = [root]
   - edges = []
   - depthMap = Map{root -> 0}
   - currentDepth = 0
3. While currentLevel is not empty AND currentDepth < max_depth:
   a. Query neighbors for ALL nodes in currentLevel using IN (?) placeholders:
      - outgoing: WHERE source_id IN (?) AND resolved_target_id IS NOT NULL
      - incoming: WHERE resolved_target_id IN (?)
      - both: union of the above
   b. nextLevel = []
   c. For each relationship row:
      - Determine neighbor_id (resolved_target_id for outgoing, source_id for incoming)
      - Skip if neighbor_id is null (unresolved target)
      - Skip if rel_types specified and row's rel_type not in set
      - Record edge {source_id, target_id, resolved_target_id, rel_type, context}
      - Skip if neighbor_id already in visited
      - Add neighbor_id to visited
      - Record depthMap[neighbor_id] = currentDepth + 1
      - Add neighbor_id to nextLevel
   d. currentLevel = nextLevel
   e. currentDepth += 1
4. Collect all entries from depthMap (excluding root) as node_ids with depth
5. Apply target_types filter to node_ids array (display filter only — see below)
6. Return { root_id, node_ids, edges }
```

### Key behaviors

- **Level-by-level batching:** All nodes at the same depth are expanded in a single SQL query using `IN (?)` placeholders. For depth=3, this is 3 queries (plus 1 for hydration), not one per node.
- **Cycle detection:** The `visited` set prevents re-enqueuing nodes. Cycles are handled naturally — a node is only expanded once.
- **Edge recording vs visited check:** Edges are recorded even when the neighbor is already visited. This captures cross-links in the subgraph (e.g., two people both attending the same meeting). The visited check only prevents re-enqueuing, not edge recording.
- **`rel_types` filters traversal:** Only edges matching the specified `rel_types` are walked and recorded. Edges that don't match are neither traversed nor included in the response.
- **`target_types` filters results only, not traversal:** The BFS walks the full graph regardless of `target_types`. Filtering is applied only when assembling the final `node_ids` array. This ensures nodes "hidden behind" intermediate types are still discovered. For example, with `target_types: ['person']`, a meeting at depth 1 is traversed through (but excluded from `nodes`) so that people at depth 2 are found.
- **`target_types` does not filter edges:** All traversed edges appear in `edges` regardless of `target_types`. This means the response may contain edges referencing node IDs not present in `nodes` — these represent the traversal paths through filtered-out intermediate nodes. The agent can use these to understand how the result nodes are connected to the root.
- **Unresolved relationships are skipped:** Only `resolved_target_id` (not raw `target_id`) is used for traversal. Dangling references cannot be walked.
- **`target_types` check:** Uses the `node_types` table — a node matches if it has at least one type in the `target_types` set. This requires a query against `node_types` for the discovered node IDs (can be batched with the hydration step).
- **Non-contiguous depths with `target_types`:** When `target_types` filters out intermediate nodes, the `depth` values on returned nodes may be non-contiguous (e.g., no depth-1 nodes but depth-2 nodes present). Depths represent actual graph distance from the root, not a renumbered position. This is intentional.
- **Self-referential edges:** A node can have a relationship where `source_id = resolved_target_id` (self-link). The BFS handles this correctly: the neighbor is the same node already in `visited`, so it won't be re-enqueued, but the edge is recorded per the "edges recorded even when neighbor already visited" rule.
- **Edge directionality reflects the relationship row, not traversal direction:** Edges in the response always have `source_id` and `target_id` matching the original relationship row. For incoming traversal, the neighbor being discovered is `source_id` (not `resolved_target_id`), but the edge is still recorded as `source_id -> target_id` per the row.
- **Duplicate edges with `direction: 'both'`:** When both the outgoing and incoming queries are run, the same relationship row can appear in both result sets (if both endpoints are in `currentLevel`). Deduplicate by `relationships.id` before processing.
- **IN clause chunking:** SQLite has a variable limit (`SQLITE_MAX_VARIABLE_NUMBER`, typically 999+). If a level exceeds this, chunk the `IN (?)` query into batches. At vault scale this is unlikely but the implementation should handle it defensively.

## SQL Queries

Per-level neighbor query (outgoing), batched:
```sql
SELECT id, source_id, target_id, rel_type, context, resolved_target_id
FROM relationships
WHERE source_id IN (?, ?, ...) AND resolved_target_id IS NOT NULL
```

Per-level neighbor query (incoming), batched:
```sql
SELECT id, source_id, target_id, rel_type, context, resolved_target_id
FROM relationships
WHERE resolved_target_id IN (?, ?, ...)
```

The `id` column is selected for deduplication when `direction: 'both'` (see above).

For `direction: 'both'`, execute both queries and merge results. Deduplicate by `relationships.id` (the autoincrement PK) — a single relationship row can match both the outgoing and incoming queries when both endpoints are in `currentLevel`, so dedup prevents recording the same edge twice.

Final hydration follows the existing pattern: batch-load from `nodes`, `node_types`, and `fields` tables using `IN (?)` placeholders.

## MCP Tool: `traverse-graph`

### Parameters

```typescript
{
  node_id: z.string()
    .describe("ID of the starting node (vault-relative path, e.g. 'projects/acme.md')"),
  direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
    .describe("'outgoing': follow links FROM this node. 'incoming': follow links TO this node. 'both': follow both."),
  rel_types: z.array(z.string()).optional()
    .describe("Only traverse these relationship types, e.g. ['assignee', 'source']. Omit for all types."),
  target_types: z.array(z.string()).optional()
    .describe("Filter result nodes to those with at least one of these schema types. Does NOT affect traversal — all nodes are explored, but only matching types appear in the response."),
  max_depth: z.number().default(2)
    .describe("Maximum hops from the starting node (1-10). Default 2."),
}
```

### `max_depth` validation

Clamped in the `traverseGraph` function body: `Math.max(1, Math.min(10, max_depth))`. No Zod `.min()/.max()` — clamping is silent, not an error.

### Response

```json
{
  "root": {
    "id": "projects/acme.md",
    "title": "Acme Launch",
    "node_type": "file",
    "types": ["project"],
    "fields": { "status": "active", "owner": "[[Alice Smith]]" },
    "file_path": "projects/acme.md",
    "content_text": "...",
    "updated_at": "2026-03-20T10:00:00"
  },
  "nodes": [
    {
      "id": "people/alice.md",
      "title": "Alice Smith",
      "node_type": "file",
      "types": ["person"],
      "fields": { "role": "PM" },
      "depth": 1,
      "file_path": "people/alice.md",
      "content_text": "...",
      "updated_at": "2026-03-19T14:00:00"
    }
  ],
  "edges": [
    {
      "source_id": "projects/acme.md",
      "target_id": "Alice Smith",
      "resolved_target_id": "people/alice.md",
      "rel_type": "owner",
      "context": null
    }
  ]
}
```

### Error cases

- Node not found: returns error message
- `max_depth` out of range: silently clamped to 1-10

### Response size

No explicit `limit` parameter. The `max_depth` cap at 10 is the primary size control. For vault-sized datasets (hundreds to low thousands of nodes), even a full traversal at depth 10 produces manageable result sets. If this becomes a problem in practice, a `limit` on returned nodes can be added as a backwards-compatible parameter.

## File Organization

- `src/graph/traversal.ts` — `traverseGraph` function + `TraverseOptions`, `TraverseEdge`, `TraverseResult` types
- `src/graph/index.ts` — barrel export
- MCP tool registration in `src/mcp/server.ts` (consistent with all other tools; handler calls `traverseGraph` then `hydrateNodes`)
- Tests in `tests/graph/traversal.test.ts`

## What This Phase Does NOT Include

- Block IDs / sub-file addressing — deferred
- Block-level node creation — deferred
- Block-level reference and mutation support — deferred
- Multiple root nodes — single root only; agent can call multiple times
- Recursive CTE approach — application-level BFS chosen for clarity and natural cycle detection
