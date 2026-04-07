# Unicode and API Consistency — Design Spec

**Date:** 2026-04-07
**Status:** Draft
**Origin:** [Vault Engine - Unicode and API Consistency Issues](~/Documents/archbrain/Notes/Vault%20Engine%20-%20Unicode%20and%20API%20Consistency%20Issues.md)

## Problem

Three related issues where the query surface and the write surface have divergent resolution logic — a node that is findable is not always writable.

1. **Unicode round-trip failure on write endpoints.** `query-nodes` (FTS) finds a node whose filename contains a curly apostrophe (U+2019), but passing the returned `id` to `get-node`, `update-node`, or `rename-node` returns NOT_FOUND. The ID doesn't survive the JSON round-trip through MCP — write endpoints do strict byte-level path lookups with zero Unicode normalization.

2. **Title lookup inconsistency.** `get-node` with a straight apostrophe (`'` U+0027) in the title doesn't match a stored curly apostrophe (`'` U+2019). These are different codepoints, not different encodings — NFC normalization alone doesn't bridge this gap. Requires typographic normalization.

3. **Indexing lag for externally-created nodes.** A web-clipped node wasn't queryable by `since` or `path_prefix` filters for several minutes despite FTS finding it. Root cause is ambiguous (watcher missed event, `since` semantics, or timing gap), so the fix addresses all three plausible failure modes.

## Design

### 1. Unified Node Resolution (`src/mcp/resolve.ts`)

New module providing two functions with a shared three-tier normalization pipeline. All MCP tool handlers switch from inline `SELECT * FROM nodes WHERE id = ?` to calling these functions.

#### Types

```typescript
type MatchTier = 'exact' | 'nfc' | 'typographic';

type ResolveResult =
  | { found: true; node: NodeRow; matchType: MatchTier }
  | { found: false; identifier: string; tried: MatchTier[] };

function resolveById(db: Database, nodeId: string): ResolveResult;
function resolveByTitle(db: Database, title: string): ResolveResult;
```

#### Resolution Strategy

Both functions apply the same three-tier fallback:

1. **Exact match** — `WHERE id = ?` / `WHERE title = ?` with the raw input. Covers the common case (no Unicode issues).
2. **NFC-normalized** — Apply `String.prototype.normalize('NFC')` to the input. Handles decomposed vs. composed representations of the same character (e.g., `é` as U+00E9 vs. `e` + U+0301).
3. **Typographic-normalized** — Apply `normalizeTypographic()` after NFC. Handles smart quotes, em-dashes, and other web-clipper artifacts mapped to ASCII equivalents.

All comparisons at every tier are case-insensitive (`.toLowerCase()` on both sides), consistent with how `resolveTarget` already handles title matching in the indexing pipeline.

Each tier is attempted in order. The first match wins. The `matchType` field in the result tracks which tier succeeded — tools can surface this in warnings so callers learn the canonical form.

#### Tier 2/3 Lookup Mechanics

Tier 1 is a direct SQL query. Tiers 2 and 3 cannot use `WHERE id = ?` because the stored ID and the input don't match byte-for-byte — that's the whole point.

**For `resolveById`:** On tier 1 miss, load all node IDs from the `nodes` table into memory (~7K short strings for a typical vault). Normalize both the input and each stored ID, compare in JS. This runs only on tier 1 miss, which is the uncommon path.

**For `resolveByTitle`:** Same approach — load all titles, normalize both sides, compare. The existing `buildLookupMaps` pattern in `src/sync/resolver.ts` is structurally similar; `resolveByTitle` builds its own normalized lookup map.

**Future optimization:** If tier 2/3 lookups become hot, add a generated `id_normalized` column with an index. Not needed now — the fallback scan is cheap for vaults up to tens of thousands of files.

#### Typographic Normalization Map

```typescript
function normalizeTypographic(str: string): string;
```

Mapping:

| Typographic | Codepoint(s) | ASCII equivalent |
|---|---|---|
| `'` `'` | U+2018, U+2019 | `'` U+0027 |
| `"` `"` | U+201C, U+201D | `"` U+0022 |
| `–` | U+2013 (en-dash) | `-` U+002D |
| `—` | U+2014 (em-dash) | `-` U+002D |
| `…` | U+2026 (ellipsis) | `...` |
| `\u00A0` | U+00A0 (NBSP) | ` ` U+0020 |

This function is exported from `src/mcp/resolve.ts` for reuse by `src/sync/resolver.ts`.

#### Integration with Tool Handlers

Every tool handler that currently does a direct `SELECT * FROM nodes WHERE id = ?` switches to `resolveById(db, nodeId)`. Tools accepting a `title` param (`get-node`, `summarize-node`) call `resolveByTitle(db, title)`. The dispatch logic (which param was provided → which function to call) stays in the tool handler, not inside the resolution functions.

On `found: false`, the handler returns the existing NOT_FOUND error. On `found: true` with `matchType !== 'exact'`, tools include `matchType` in the response warnings so callers can learn and use the canonical form.

**Affected handlers:** `get-node`, `update-node` (single-node mode), `rename-node`, `delete-node`, `validate-node` (by node_id mode), `summarize-node`, `add-relationship`, `remove-relationship`, `read-embedded`.

#### Wiki-Link Resolution (Indexing Pipeline)

The same normalization applies to `src/sync/resolver.ts`. A wiki-link `[[Alice's Notes]]` (straight quote) pointing at `Alice's Notes.md` (curly quote) currently fails to resolve — same root cause, same fix.

**Changes to `buildLookupMaps`:** Normalize map keys (both title and path-suffix keys) with NFC + typographic normalization. Store the original node ID as the map value so resolution returns the canonical ID.

**Changes to `resolveTargetWithMaps`:** Normalize the incoming wiki-link target with the same pipeline before map lookup.

This makes the fix bidirectional: curly-quote wiki-links resolve to straight-quote filenames, and vice versa.

### 2. Reconciliation Pass (`src/sync/reconciler.ts`)

New module providing a periodic safety net for dropped chokidar events.

#### API

```typescript
function reconcileOnce(db: Database, vaultPath: string): { indexed: number; skipped: number; deleted: number };

function startReconciler(
  db: Database,
  vaultPath: string,
  opts?: { intervalMs?: number; firstTickMs?: number }
): { close(): void };
```

- `reconcileOnce` — single-shot reconciliation. Calls `incrementalIndex(db, vaultPath)`. Same mtime-first, hash-fallback logic already implemented. Exposed as a standalone function for direct use and testing.
- `startReconciler` — starts a recurring timer. First tick fires after `firstTickMs` (default 30,000ms / 30s), subsequent ticks at `intervalMs` (default 300,000ms / 5 minutes). Returns a handle with `close()` to stop the timer.

#### First Tick Timing

The first tick fires at 30s, not at the full interval. Startup is when drift is most likely — the watcher is just coming up, and files written during downtime need to be caught. `incrementalIndex` runs once at startup but only catches what exists at that exact moment. The early first tick closes the gap between startup-time indexing and the first scheduled tick.

#### Concurrency with the Watcher

A reconciler tick and a watcher event could fire on overlapping files simultaneously. `incrementalIndex` uses `db.transaction()` and `indexFile` uses `INSERT OR REPLACE`, so concurrent writes to the same node are safe at the DB level (SQLite serializes transactions). However, to avoid redundant work and potential race conditions on file reads, a single in-process mutex is shared between the watcher's per-file dispatch and the reconciler tick. Only one indexing operation runs at a time. This is cheap — the watcher's per-file work is fast, and the reconciler's mtime scan is I/O-bound, not CPU-bound.

#### Lifecycle

Started in `src/index.ts` after the watcher, for all transport modes. `close()` called during shutdown alongside `watcher.close()`.

#### Relationship to Write Tools

Engine-initiated writes (`create-node`, `update-node`, `rename-node`, `batch-mutate`) already index synchronously before returning — they call `parseFile` + `indexFile` within their transaction and hold write locks. This is an existing guarantee, not new work. The reconciler will see these files as already-indexed (mtime match) and skip them. No conflict.

The watcher is the primary path for low-latency detection of external edits. The reconciler is a safety net for completeness. Write tools are self-indexing. These three mechanisms are complementary.

### 3. `since` Filter Semantics

#### Current State

`nodes.updated_at` has `DEFAULT (datetime('now'))` — set when the row is inserted or replaced. `query-nodes`'s `since` param filters on `n.updated_at > ?`. This accidentally answers "when did the engine learn about it" rather than "when was the file modified," but the column name is misleading and the semantics aren't intentional.

#### Schema Changes

Add `indexed_at` column and rename `updated_at` to `file_mtime` on the `nodes` table:

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  file_path       TEXT,
  node_type       TEXT NOT NULL,
  content_text    TEXT,
  content_md      TEXT,
  title           TEXT,
  depth           INTEGER DEFAULT 0,
  is_valid        INTEGER DEFAULT 1,
  file_mtime      TEXT,       -- file modification time from disk (stat)
  indexed_at      TEXT DEFAULT (datetime('now'))  -- when engine last indexed this node
);
```

- **`file_mtime`** — populated from the `mtime` param passed to `indexFile` (file stat time). Unambiguous name — no risk of confusion with row-level update semantics.
- **`indexed_at`** — `DEFAULT (datetime('now'))`, refreshed on every `INSERT OR REPLACE` (every re-index of the file, not just first ingest). This means `indexed_at` answers "when did the engine last see a change to this file," not "when did the engine first learn about it."

The schema is rebuildable (no migration needed). `createSchema` gets the new DDL, `indexFile` populates both columns, `rebuildIndex` repopulates everything.

#### `indexFile` Changes

```typescript
// In the INSERT OR REPLACE for nodes:
// - file_mtime: set to the mtime param (string, from fs.stat)
// - indexed_at: set to new Date().toISOString() explicitly (not relying on DEFAULT,
//   since INSERT OR REPLACE may not trigger defaults consistently across SQLite versions)
```

#### Query Changes

- **`since`** — switches from `n.updated_at > ?` to `n.indexed_at > ?`. This is the right default for "what's new since my last check" — a file clipped at 2:00pm with mtime 2:00pm but indexed at 2:05pm gets found by `since=2:03pm`.
- **New `modified_since` param** — filters on `n.file_mtime > ?`. Different question: "what files were touched on disk after this date, regardless of when the engine indexed them."

#### Tool Descriptions

The `query-nodes` tool description must be unambiguous about the distinction:

- **`since`** — "Return nodes the engine indexed after this time. Use this to find what's new since your last check."
- **`modified_since`** — "Return nodes whose underlying file was modified after this time. Use this to find files touched on disk, regardless of when the engine indexed them."

### 4. Integration Tests

**New test file: `tests/mcp/unicode-resolution.test.ts`**

#### Unicode Resolution Tests

1. **Curly apostrophe in filename/title** — create node with `It's` (U+2019) in the path, resolve by ID with straight `It's` (U+0027). Expect `found: true`, `matchType: 'typographic'`.

2. **Smart double quotes** — `"quoted"` (U+201C/U+201D) title resolved with `"quoted"` (U+0022). Expect `matchType: 'typographic'`.

3. **Em-dash in title** — `A—B` (U+2014) resolved with `A-B` (U+002D). Expect `matchType: 'typographic'`.

4. **NFC vs NFD** — `café` as composed (U+00E9) vs decomposed (U+0065 + U+0301). Expect `matchType: 'nfc'`.

5. **Exact match** — passing the exact stored ID returns `matchType: 'exact'`.

6. **Title resolution with typographic normalization** — `resolveByTitle` with straight quotes finds a curly-quote title.

7. **Not found** — nonexistent ID returns `{ found: false, tried: ['exact', 'nfc', 'typographic'] }`.

#### Wiki-Link Resolution Tests

8. **Forward normalization** — wiki-link `[[Alice's Notes]]` (straight) resolves to `Alice's Notes.md` (curly) during indexing. Assert `resolved_target_id` is populated.

9. **Reverse normalization** — wiki-link `[[Alice\u2019s Notes]]` (curly) resolves to `Alice's Notes.md` (straight) on disk. Same fix, both directions.

#### `since` / `modified_since` Tests

10. **`since` filters on indexed_at** — create a node, query with `since` before indexing time (found) and after (not found).

11. **`modified_since` filters on file_mtime** — same pattern using file modification time boundaries.

#### Reconciler Tests

12. **`reconcileOnce` detects drift** — write a file directly to disk (bypassing engine write tools), call `reconcileOnce`, assert the node is now queryable and the return value shows `indexed: 1`.

13. **`reconcileOnce` detects deletions** — delete a file from disk that's in the DB, call `reconcileOnce`, assert the node is removed.

14. **`startReconciler` timer wiring** — start with `intervalMs: 50, firstTickMs: 10`, write a file to disk, wait briefly, assert the node appears. Confirms the timer actually fires and calls `reconcileOnce`.

## Out of Scope

- **NFC normalization at ingest time** — store original characters as-is. Normalization is lookup-only (Option A from brainstorming).
- **`resolveTarget` rewrite** — the indexing-pipeline resolver gets normalization support but retains its existing structure (`buildLookupMaps` + `resolveTargetWithMaps`). No architectural change.
- **Diagnosing chokidar event drops** — the reconciler sidesteps the root cause. Issue glibalien/vault-engine#2 remains open for investigation.
- **`id_normalized` column** — future optimization if tier 2/3 lookups become hot. Not needed at current vault scale.
