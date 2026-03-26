# Vault Engine — Enhancements & Roadmap

Post-Phase 6 enhancements, bugs found during initial testing, and priority sequencing. This document covers everything beyond the core engine (Phases 1–6).

---

## Bugs & Fixes Found During Testing

### B1: `rename-node` drops file into vault root

When `new_path` is omitted and the node's type has no schema or no `filename_template`, the renamed file ends up in the vault root instead of staying in its current directory. The fallback should preserve the original file's directory: `Daily Notes/old title.md` renamed to `new title` should become `Daily Notes/new title.md`, not `new title.md`.

**Fix:** When `new_path` is not provided and `generateFilePath` can't resolve a template, use `path.dirname(oldPath)` as the base directory.

### B2: Serializer uses inline YAML array syntax

The serializer produces `types: [person]` instead of the multi-line list style used by the rest of the vault:

```yaml
types:
  - person
```

Both parse correctly and render fine in Obsidian. Cosmetic issue — fix if visual consistency matters.

### B3: Schema enum values don't match actual vault data

The shipped `.schemas/task.yaml` defines hardcoded enum values from the architecture doc examples (e.g., `status: [todo, in-progress, blocked, done, cancelled]`, `priority: [critical, high, medium, low]`) rather than values derived from the actual vault (e.g., `open`, `normal`). Validation correctly warns but doesn't reject — this is working as designed, but the schemas need updating to match reality.

**Fix:** Run the schema inference tool (Enhancement #1 below) or manually update `.schemas/*.yaml` to reflect actual frontmatter values.

---

## Enhancements

### 1. Schema Inference / Vault Initialization Tool

**Priority:** Do first
**Effort:** Small
**Depends on:** Phase 1–2 (indexed DB)

The most immediate gap. The engine assumes schemas are manually authored, but anyone with an existing vault needs schemas that match their actual frontmatter conventions — not example values from an architecture doc.

**Capabilities:**

- Scan the indexed DB for all distinct field names, value types, and enum sets per node type
- Propose `.schemas/*.yaml` files that reflect what actually exists in the vault
- Detect field types: references (values containing `[[`), dates (ISO patterns), numbers, booleans, enums (small distinct value sets), free-text strings
- Identify required fields (present in >90% of nodes of that type)
- Detect common field names across types that could indicate shared schema inheritance
- Output as either a report (agent reviews and confirms) or direct YAML file writes

**Implementation path:** A quick version is just SQL queries against the `fields` table — `SELECT DISTINCT value_text FROM fields WHERE key = 'status' AND node_id IN (SELECT node_id FROM node_types WHERE schema_type = 'task')`. The full tool adds type inference, frequency analysis, and YAML generation.

**MCP tool:** `infer-schemas` — returns proposed schema definitions as structured JSON. Optional `write: true` param to write the YAML files directly.

---

### 2. Database Visualization

**Priority:** Do second
**Effort:** Medium–Large
**Depends on:** Phase 1–2 (query layer)

A web UI served by the engine that renders structured views of vault data. Not a full companion app — a focused visualization layer.

**Views:**

- **Table view.** Spreadsheet-style grid of nodes filtered by type, with columns from schema fields. Sortable, filterable. The Dataview equivalent, but live and schema-aware.
- **Kanban board.** Cards grouped by an enum field (e.g., tasks by status). Drag-and-drop triggers `update-node` calls.
- **Graph view.** Interactive relationship graph using D3 or similar. Nodes are dots, wiki-links are edges. Filter by type, zoom to neighborhoods.
- **Timeline.** Nodes with date fields plotted chronologically. Useful for meetings, milestones, project phases.
- **Dashboard.** Composable panels: pinned queries, summary stats, recent activity. Essentially a visual `daily-summary`.

**Architecture:** Lightweight web server (Express or Fastify) alongside the MCP server. Serves a React/Svelte SPA that calls the same query layer the MCP tools use. Live updates via WebSocket or SSE when the watcher detects changes.

---

### 3. HTTP Transport

**Priority:** Do first (prerequisite for Fireworks LLM integration)
**Effort:** Small
**Depends on:** Phase 1 (MCP server)

Add Streamable HTTP transport as an alternative to stdio. Required for connecting to Fireworks (or any remote LLM provider) since their Response API can only call remote MCP servers, not spawn local subprocesses.

**Implementation:** A new entry point (or `--transport http --port 3333` flag) that uses `StreamableHTTPServerTransport` from the MCP SDK instead of `StdioServerTransport`. ~30 lines of Express setup. Keep stdio as the default for Claude Code.

**Mirrors the existing obsidian-tools pattern:** FastAPI server handles chat interface and LLM calls, Fireworks model makes tool calls to the local MCP server over HTTP.

---

### 4. Obsidian Chat Plugin

**Priority:** Do second
**Effort:** Medium
**Depends on:** Enhancement #3 (HTTP transport)

An Obsidian plugin that provides a chat interface within the editor, connected to the engine via HTTP. The user talks to an LLM that has access to all vault-engine MCP tools.

**Capabilities:**

- Chat sidebar within Obsidian
- LLM calls go to Fireworks (or any OpenAI-compatible API) with vault-engine tools available
- Results rendered inline — query results as tables, created nodes as links
- Quick actions: "create a task from this selection," "link this note to [project]"

**Reuses the existing obsidian-tools chat plugin pattern** — swap the MCP server endpoint from obsidian-tools to vault-engine.

---

### 5. Template System

**Priority:** Do first
**Effort:** Small
**Depends on:** Phase 3 (write path)

Pre-defined templates for common node creation patterns. Reduces the verbosity of `create-node` calls.

**Concept:**

- Templates defined in `.templates/*.yaml` alongside schemas
- Each template specifies: base type(s), default field values, body boilerplate, relationship stubs
- Example: a "weekly standup" template creates a meeting node with `date: today`, a body outline with `## Updates`, `## Blockers`, `## Action Items` sections, and a link to the team project
- MCP tool: `create-from-template` — takes template name + overrides

---

### 6. Conflict Resolution

**Priority:** Defer
**Effort:** Medium
**Depends on:** Phase 3 (write path)

Handle the case where a file is modified externally between the engine's read and write. Currently the engine overwrites without checking.

**Approach:** Compare file hash at read time vs write time. If they differ, someone else edited the file. Options: merge (if changes don't overlap), prompt the user, or write a `.conflict` copy.

Only matters when concurrent editing is actually a problem in practice.

---

### 7. Import / Migration Tools

**Priority:** Do third
**Effort:** Medium
**Depends on:** Phase 3 (write path), Enhancement #1 (schema inference)

Tools to import data from other systems into vault-engine markdown files.

**Sources:**

- Tana (JSON export → markdown with frontmatter)
- Notion (export → clean up frontmatter, map properties to fields)
- Todoist / Asana / Linear (task export → task nodes)
- CSV/JSON (generic tabular data → typed nodes)

Each importer: parse source format → map to vault-engine node structure → `batch-mutate` to create all nodes atomically.

---

### 8. Export & Publishing

**Priority:** Defer
**Effort:** Medium
**Depends on:** Phase 1–2 (query layer)

Render vault content for external consumption.

- Export a node or query result set as PDF, HTML, or DOCX (via pandoc)
- Publish a subset of the vault as a static site (filtered by type, tag, or visibility field)
- RSS feed generation from nodes with date fields

Users can use pandoc directly in the meantime.

---

### 9. Multi-Vault

**Priority:** Defer
**Effort:** Large
**Depends on:** All phases

Link nodes across separate vaults. Explicitly deferred in the architecture doc — large scope, niche need. Changes the ID model (currently vault-relative paths) and reference resolution.

---

### 10. Automation & Scheduled Workflows

**Priority:** Do third
**Effort:** Medium
**Depends on:** Phase 6 (workflow tools)

Trigger MCP tool calls on a schedule or in response to file events, without an LLM in the loop.

**Examples:**

- Every morning at 8am, run `daily-summary` and write the result to `Daily Notes/YYYY-MM-DD.md`
- When a file with `types: [meeting]` is created, auto-run `extract-tasks` after 5 minutes (gives the user time to finish writing)
- Weekly: find all tasks where `status != done` and `due_date < today`, update status to `overdue`

Automations defined as YAML configs that map triggers (file events, schedules, field changes) to MCP tool calls.

---

### 11. Permissions & Sharing

**Priority:** Defer
**Effort:** Large
**Depends on:** Phase 1+

Only relevant if the vault is used by a team. Adds node-level visibility (`private`, `team`, `public`), authorship tracking, and access control. Changes the fundamental single-user model.

---

### 12. Version History & Undo

**Priority:** Defer
**Effort:** Medium
**Depends on:** Phase 3 (write path)

Git integration (auto-commit after mutations with structured messages), a `mutations` table for undo without git, and a field-level diff view. Git covers most of this for users who already have their vault in a repo.

---

### 13. Mobile Access

**Priority:** Do third
**Effort:** Large
**Depends on:** Enhancement #3 (HTTP transport), auth layer

Issue commands to the vault from a phone. The vault stays local; the phone reaches the engine remotely.

**Architecture (recommended path):**

1. Start with Tailscale tunnel — almost zero effort for technical users
2. Upgrade to a lightweight cloud relay for robustness
3. Long-term aspiration: local sync + mobile engine (massive undertaking)

**Mobile app scope (deliberately narrow):**

- Chat-first UI — natural language commands to the LLM with vault-engine tools
- Quick capture widget — tap, type a title, pick a type, done
- Read-only dashboard — overdue tasks, today's meetings, recent changes
- No full markdown editing — that's what the phone's notes app is for

---

### 14. Companion App

**Priority:** Do third
**Effort:** Large
**Depends on:** Phase 1+ (MCP server), Enhancement #2 (visualization)

A purpose-built desktop app for operating the vault. Not for writing prose — for reviewing query results, triaging tasks, browsing the graph, and watching agent activity.

**Key capabilities:**

- Live query panels (pinned query-nodes results that update in real time)
- Agent activity feed (files created, fields updated, references resolved)
- Inline command palette with schema-aware autocomplete
- Split view: rendered markdown + structured data (frontmatter, relationships, validation warnings)

Only justified once the engine is mature enough to be the primary interface.

---

## Priority & Sequencing

| Priority | Item | Why |
|----------|------|-----|
| **Do first** | 1. Schema Inference | Unblocks onboarding. Small effort. You hit this gap immediately during testing. |
| **Do first** | 3. HTTP Transport | Prerequisite for Fireworks LLM integration. Small effort. |
| **Do first** | 5. Template System | Small scope, big ergonomic win for the write path. |
| **Do second** | 2. Database Visualization | Makes the engine usable for task management without the companion app. |
| **Do second** | 4. Obsidian Chat Plugin | Bridges the gap to the existing obsidian-tools workflow. |
| **Do third** | 14. Companion App | Only justified once the engine is mature. |
| **Do third** | 7. Import / Migration Tools | Grows the user base by reducing switching costs. |
| **Do third** | 10. Automation & Scheduled Workflows | Transforms the engine from a query tool into an active system. |
| **Do third** | 13. Mobile Access | High value but depends on HTTP transport, auth, and a mature write path. |
| **Defer** | 6. Conflict Resolution | Only matters when concurrent editing is actually a problem. |
| **Defer** | 8. Export & Publishing | Pandoc covers most of this in the meantime. |
| **Defer** | 9. Multi-Vault | Explicitly deferred in the architecture doc. Large scope, niche need. |
| **Defer** | 11. Permissions & Sharing | Changes the fundamental model. Only if team use cases emerge. |
| **Defer** | 12. Version History | Git covers most of this. Engine-level undo is a polish item. |
