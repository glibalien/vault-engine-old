# SQLite Schema Creation + DB Connection — Design

## Overview

Task 2 of Phase 1. Create the SQLite database layer: a factory function to open and configure better-sqlite3, and a schema creation function with all DDL from the architecture doc.

## Files

```
src/db/
├── connection.ts   — openDatabase() factory, WAL mode, pragmas
├── schema.ts       — createSchema() with all DDL
└── index.ts        — re-exports

tests/db/
├── connection.test.ts
└── schema.test.ts
```

## connection.ts

`openDatabase(dbPath: string): Database` — opens a better-sqlite3 instance and configures:

- `PRAGMA journal_mode = WAL` — concurrent reads during writes
- `PRAGMA foreign_keys = ON` — enforce FK constraints
- `PRAGMA busy_timeout = 5000` — wait up to 5s on lock contention

Creates parent directories if they don't exist (the DB path is typically `.vault-engine/vault.db`). Returns the raw `Database` instance — callers call `db.close()` when done.

## schema.ts

`createSchema(db: Database): void` — runs all `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements inside a single transaction.

### Tables

| Table | Purpose |
|-------|---------|
| `nodes` | Core entities (file-level nodes for Phase 1) |
| `node_types` | Multi-typing (node_id, schema_type) |
| `nodes_fts` | FTS5 virtual table on content_text |
| `fields` | Typed frontmatter fields |
| `relationships` | Wiki-link edges |
| `schemas` | Cached schema definitions |
| `files` | File metadata for change detection |

### Indices

8 indices from the architecture doc covering file_path, parent_id, schema_type, field key+value combinations, relationship source/target/type.

### FTS5 Sync Triggers

The FTS5 table uses `content='nodes'` (external content mode), requiring triggers:

- `AFTER INSERT` on nodes → insert into nodes_fts
- `AFTER DELETE` on nodes → delete from nodes_fts
- `AFTER UPDATE` on nodes → delete old + insert new into nodes_fts

## Approach

- Simple `CREATE TABLE IF NOT EXISTS` — no migration tracking. The DB is a rebuildable index; if schema changes, delete and re-index.
- Factory function returns raw `better-sqlite3` `Database` instance — no wrapper class.

## Testing

- **connection.test.ts** — `:memory:` DB for foreign_keys and busy_timeout pragma assertions. File-based temp DB for WAL mode assertion (WAL mode cannot be set on `:memory:` databases).
- **schema.test.ts** — Runs `createSchema` on `:memory:` DB, verifies all tables exist via `sqlite_master`, verifies idempotency (run twice, no error), verifies FTS5 works with a sample insert+query.
