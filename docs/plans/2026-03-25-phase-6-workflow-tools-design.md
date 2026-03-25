# Phase 6: Task Management + Workflow Tools — Design

## Overview

Phase 6 adds higher-level workflow tools that compose existing primitives (`batch-mutate`, `query-nodes`, `traverse-graph`) into productive agent workflows. It also hardens the engine for production use and validates performance at scale.

**Scope:**
- 4 new MCP tools: `create-meeting-notes`, `extract-tasks`, `daily-summary`, `project-status`
- Comparison operators for `query-nodes` (replaces a dedicated `overdue-tasks` tool)
- 5 hardening targets
- 5 performance benchmarks against the ~7000-file test vault

---

## Workflow Tools

### `create-meeting-notes`

Creates a meeting node with linked attendees and project. Auto-creates minimal person stubs for unknown attendees.

**Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | yes | Meeting title |
| `date` | `string` | yes | ISO date |
| `attendees` | `string[]` | yes | Attendee names (resolved to person nodes) |
| `project` | `string` | no | Project name or wiki-link |
| `agenda` | `string` | no | Agenda text for the meeting body |
| `body` | `string` | no | Additional body content |

**Pipeline:**
1. Batch-resolve all attendee names against existing nodes. Call `buildLookupMaps(db)` once, then use the maps for each attendee (avoids N table scans).
2. Split into resolved (existing person node found) and unresolved (no match).
3. Build a `batch-mutate` operations array:
   - One `create` op per unresolved attendee — minimal stub only: `{ title, types: ['person'] }`. No invented fields.
   - One `create` op for the meeting node: `types: ['meeting']`, fields include `date`, `attendees` as wiki-link list, `project` as wiki-link if provided. Body contains agenda if provided.
4. Execute via `batchMutate` — atomic, all-or-nothing.
5. Return hydrated meeting node plus `{ resolved_attendees: string[], created_attendees: string[] }`.

The `created_attendees` vs `resolved_attendees` distinction lets the agent know which person nodes are stubs it may want to enrich later.

### `extract-tasks`

Thin orchestration tool. The calling agent has already read the source node and identified action items. This tool creates and links them.

**Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `source_node_id` | `string` | yes | Node the tasks were extracted from |
| `tasks` | `Array<TaskInput>` | yes | Pre-extracted task definitions |

**`TaskInput` shape:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | yes | Task title |
| `assignee` | `string` | no | Person name or wiki-link |
| `due_date` | `string` | no | ISO date |
| `priority` | `string` | no | e.g. `high`, `medium`, `low` |
| `status` | `string` | no | Defaults to `todo` |
| `fields` | `Record<string, any>` | no | Additional fields |

**Pipeline:**
1. Validate `source_node_id` exists in DB.
2. Look up the title of `source_node_id` from the `nodes` table. Use this title for the wiki-link target (not the file path). If no frontmatter title exists, the title defaults to filename stem (existing engine behavior).
3. Build `batch-mutate` operations array:
   - One `create` op per task: `types: ['task']`, fields from the task input, plus `source: [[source_node_title]]` to link back to the originating node.
4. Execute via `batchMutate`.
5. Return array of created task nodes with their IDs.

The tool does not parse content, apply NLP, or guess at action items. The agent is the intelligence; the tool is the orchestrator. This aligns with design principle 7 ("runs on cheap models") — the tool interface is explicit and unambiguous.

### `daily-summary`

Read-only aggregation tool. Returns structured JSON for the agent to present however it sees fit.

**Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | `string` | no | ISO date, defaults to today |

**Response shape:**

```json
{
  "date": "2026-03-25",
  "overdue": [{ "id": "...", "title": "...", "types": [...], "due_date": "...", "status": "...", "assignee": "..." }],
  "due_today": [...],
  "due_this_week": [...],
  "recently_modified": [{ "id": "...", "title": "...", "types": [...], "updated_at": "..." }],
  "active_projects": [{ "id": "...", "title": "...", "status": "...", "total_tasks": 12, "completed_tasks": 5, "completion_pct": 41.67 }]
}
```

**Implementation notes:**
- Overdue/due items: query `fields` table where `key = 'due_date'` with date comparisons, joined with status filter (`!= 'done'`, `!= 'cancelled'`).
- `due_this_week`: tasks with `due_date` between `date + 1` and the end of the ISO week (Monday-based, so Sunday), exclusive of `due_today`. Computed as: start = `date + 1 day`, end = next Sunday (or same day if `date` is Saturday).
- Recently modified: `nodes` ordered by `updated_at DESC`, limit 20. Only includes nodes that have at least one type in `node_types` (excludes untyped files).
- Active projects: query nodes with type `project` where `fields.key = 'status' AND fields.value_text = 'active'`, plus projects with no `status` field (active by default). Compute task stats via shared `computeProjectTaskStats` helper — raw queries, not computed fields.

### `project-status`

Detailed status view for a single project.

**Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project_id` | `string` | yes | Project node ID |

**Response shape:**

```json
{
  "project": { "id": "...", "title": "...", "status": "...", "owner": "...", "fields": {} },
  "tasks_by_status": {
    "todo": [{ "id": "...", "title": "...", "assignee": "...", "due_date": "...", "priority": "..." }],
    "in-progress": [...],
    "done": [...],
    "blocked": [...],
    "cancelled": [...]
  },
  "total_tasks": 12,
  "completed_tasks": 5,
  "completion_pct": 41.67,
  "overdue_tasks": [...],
  "recent_activity": [{ "id": "...", "title": "...", "updated_at": "..." }]
}
```

**Implementation notes:**
- Find tasks linked to the project: query `relationships` table where `resolved_target_id = project_id`, then filter to sources that have type `task` in `node_types`. SQL sketch:
  ```sql
  SELECT DISTINCT r.source_id
  FROM relationships r
  JOIN node_types nt ON nt.node_id = r.source_id AND nt.schema_type = 'task'
  WHERE r.resolved_target_id = ?
  ```
  This finds all task nodes that reference the project (via any relationship type — `project`, `source`, body wiki-link, etc.). No `rel_type` filter; a task linked to a project by any means is relevant.
- Group by status field value, compute counts and percentages from raw queries.
- `daily-summary` reuses this same task-stats logic for its `active_projects` section — extract a shared helper (e.g., `computeProjectTaskStats(db, projectId)`).
- Overdue subset: tasks where `due_date < today` and status not in `[done, cancelled]`.
- Recent activity: tasks linked to project ordered by `updated_at DESC`, limit 10.

---

## Query Enhancement: Comparison Operators

### Current state

`query-nodes` field filters support `eq` only.

### Change

Add `operator` field to filter objects with values: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `in`. Default is `eq` for backwards compatibility.

**Zod schema change for filter value:** `value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])`. The `in` operator expects an array of strings; all other operators expect a single value.

### SQL mapping

| Operator | SQL | Column |
|----------|-----|--------|
| `eq` | `= ?` | `value_text` |
| `neq` | `!= ?` | `value_text` |
| `gt` | `> ?` | type-aware |
| `lt` | `< ?` | type-aware |
| `gte` | `>= ?` | type-aware |
| `lte` | `<= ?` | type-aware |
| `contains` | `LIKE '%' \|\| ? \|\| '%' ESCAPE '\'` | `value_text` |
| `in` | `IN (?, ?, ...)` | `value_text` |

**Type-aware column selection** for comparison operators (`gt`, `lt`, `gte`, `lte`):

Branch on `value_type` in the WHERE clause. For a given `(node_id, key)` pair, `value_type` is deterministic (PK is `(node_id, key)`). The SQL uses a CASE on `value_type`:

```sql
AND CASE fi.value_type
  WHEN 'number' THEN fi.value_number > ?
  WHEN 'date' THEN fi.value_date > ?
  ELSE fi.value_text > ?
END
```

This won't use the separate column indices (`idx_fields_key_number`, `idx_fields_key_date`). That's acceptable — the field is already filtered by `key` (indexed), which narrows the scan. If benchmarks reveal this as a bottleneck, we can add an optional `value_type` hint parameter later.

**`contains` operator and LIKE wildcards:** The `ESCAPE '\'` clause is used, and `%` and `_` characters in the user-provided value are escaped before binding (replace `%` with `\%`, `_` with `\_`). This ensures literal matching.

### Example: overdue tasks

```json
{
  "schema_type": "task",
  "filters": [
    { "field": "due_date", "operator": "lt", "value": "2026-03-25" },
    { "field": "status", "operator": "neq", "value": "done" },
    { "field": "status", "operator": "neq", "value": "cancelled" }
  ]
}
```

---

## Hardening

### H1: MCP error handling consistency

**Target:** Every tool handler wrapped in try/catch returning structured errors.

**Error response shape:**
```json
{ "error": "Node not found: tasks/missing.md", "code": "NOT_FOUND" }
```

**Error codes:** `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `INTERNAL_ERROR`.

**Scope:** Audit all existing tools (15+) plus the 4 new workflow tools. Ensure no raw stack traces reach the agent.

### H2: Input validation tightening

**Target:** Zod schemas at MCP boundary reject clearly invalid input.

**Checks to add:**
- String params: `.min(1)` where empty string is meaningless (node_id, title, etc.)
- Path params: reject `..` segments
- Date params: validate ISO 8601 format via regex (`/^\d{4}-\d{2}-\d{2}/`)
- Numeric params: validate ranges (e.g., `limit` > 0, `max_depth` > 0)
- Array params: reasonable max lengths to prevent abuse

Focus on tool params only — internal code trusts validated input.

### H3: Batch-scoped write lock timing

**Target:** No watcher re-index during `batch-mutate` execution.

**Problem:** The current write lock is per-file and released immediately after each file write (in `writeNodeFile`'s `try/finally`). In `batch-mutate`, by the time the watcher's debounce fires (300ms after the last write), the per-file lock has already been released. The watcher sees no lock and re-indexes, causing a spurious loop.

**Fix:** Two-phase locking for batch operations:
1. Each `*Inner` function acquires its file's write lock as it writes (existing behavior).
2. Instead of releasing immediately, batch-scoped locks are collected in a set.
3. All collected locks are released in a `finally` block after the entire batch transaction commits (and after `resolveReferences`).
4. Non-batch operations (single create/update/etc.) continue with per-file acquire/release as today.

Implementation: `batchMutate` passes a `deferredLocks: Set<string>` into each `*Inner` call. When present, `writeNodeFile` adds the path to `deferredLocks` instead of releasing in `finally`. `batchMutate`'s outer `finally` releases all deferred locks.

### H4: Transaction safety audit

**Target:** `batch-mutate` filesystem rollback handles all failure modes.

**Test scenarios:**
- Write permission error on Nth file in a batch.
- Partial file write (simulate with a write that throws after creating the file).
- Rollback of created files (should be deleted) and modified files (should be restored to original content).
- Verify DB transaction rolls back cleanly in all cases.

### H5: Watcher resilience under bulk writes

**Target:** Zero spurious re-index events during a 20-operation `batch-mutate`.

**Test:**
1. Set up a vault with the watcher running.
2. Execute a 20-operation `batch-mutate` (mix of create, update, delete).
3. Instrument the watcher to count how many times `indexFile`/`deleteFile` are called during and after the batch (wait for debounce to settle, e.g., 500ms after batch completes).
4. Assert: zero watcher-triggered index operations for files written by the batch.
5. This test validates the H3 fix (batch-scoped locks). If any files slip through, the deferred lock release timing needs adjustment.

---

## Performance

All benchmarks run against the ~7000-file test vault.

| ID | Target | Metric | Threshold |
|----|--------|--------|-----------|
| P1 | Full rebuild (`rebuildIndex`) | Wall clock | < 30s |
| P2 | Incremental index, no changes (`incrementalIndex`) | Wall clock | < 2s |
| P3 | `query-nodes` with filters | p95 latency | < 100ms |
| P4 | `traverse-graph` (2-hop) | p95 latency | < 200ms |
| P5 | `hydrateNodes` (100 nodes) | Wall clock | < 50ms |

**Methodology:** 10 warm-up iterations discarded, then 100 measured iterations. Report p50, p95, p99. All measurements on hot SQLite page cache (warm-up ensures this). Cold-start performance is not a target — the engine is a long-running process.

**Approach:**
1. Write benchmark scripts runnable via `npm run bench`.
2. Profile any that miss thresholds — add indices, optimize SQL, batch more aggressively.
3. `hydrateNodes` N+1 audit: confirm batch loading stays efficient, no per-node queries creeping in at scale.

---

## Shared Helpers

### `computeProjectTaskStats(db, projectId)`

Shared by `project-status` and `daily-summary`. Queries relationships + fields tables directly to compute:
- Tasks grouped by status
- Total / completed counts
- Completion percentage
- Overdue subset

Does not use Phase 2 computed fields — computes from raw queries for reliability and because `project-status` needs the per-status breakdown anyway.

---

## File Organization

Workflow tool implementations go in a new `src/mcp/workflow-tools.ts` module. This module exports handler functions that `server.ts` registers via `server.tool()`. This keeps `server.ts` (already ~1580 lines with 15 tools) from growing further. The shared `computeProjectTaskStats` helper lives in the same module.

Tool registrations (Zod schemas + one-line handler calls) stay in `server.ts` for discoverability. Logic lives in `workflow-tools.ts`.

---

## Task Breakdown (Proposed)

1. **Comparison operators for `query-nodes`** — foundation for date/status filtering used by workflow tools
2. **`project-status` tool + `computeProjectTaskStats` helper** — standalone + provides shared logic
3. **`daily-summary` tool** — depends on shared helper from task 2
4. **`create-meeting-notes` tool** — uses `batchMutate`, attendee resolution + stub creation
5. **`extract-tasks` tool** — uses `batchMutate`, thin orchestration
6. **Hardening (H1-H5)** — error handling, validation, batch-scoped locks, transaction safety, watcher resilience
7. **Performance benchmarks + optimization** — benchmark scripts, profiling, fixes
8. **Documentation** — tool descriptions, setup guide updates
