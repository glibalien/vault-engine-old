# `update-node` MCP Tool — Design

## Summary

`update-node` modifies an existing node's fields and/or body content. It reads the existing `.md` file, parses it, merges updates, serializes, writes back, and re-indexes. Title and types are immutable through this tool (use `rename-node` for title, `batch-mutate` delete+create for types).

## Params

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `node_id` | `string` | yes | Vault-relative file path, e.g. `"tasks/review.md"` |
| `fields` | `Record<string, unknown>` | no | Merge into existing fields. `null` removes a field. |
| `body` | `string` | no | Replace entire body content |
| `append_body` | `string` | no | Append to existing body content |

At least one of `fields`, `body`, or `append_body` is required. `body` and `append_body` are mutually exclusive.

## Pipeline

1. **Validate params** — no-updates check, mutual exclusivity check
2. **Check node exists** — in DB and on disk
3. **Read + parse** — `readFileSync` + `parseFile()`
4. **Merge fields** — `{ ...existingFields, ...updates }`, delete nulls, exclude meta-keys
5. **Resolve body** — replace, append (`\n\n` separator), or preserve existing
6. **Validate** — `mergeSchemaFields` + `validateNode`, collect warnings
7. **Serialize** — `computeFieldOrder` + `serializeNode`
8. **Write** — `writeNodeFile()` to same path (in-place update)
9. **Re-index** — `parseFile` + `indexFile` + `resolveReferences` in `db.transaction()`
10. **Return** — hydrated node + warnings

## Field Merge Semantics

- Provided fields overwrite existing values
- Unmentioned fields preserved as-is
- Setting a field to `null` removes it
- `title` and `types` excluded from merge (immutable through this tool)

## Body Handling

- `body` replaces `parsed.contentMd` entirely
- `append_body` appends with `\n\n` separator (or just the value if existing body is empty)
- Neither provided → preserve existing body

## Error Conditions (fail fast)

1. No updates provided → `"No updates provided: at least one of fields, body, or append_body is required"`
2. Both `body` and `append_body` → `"Cannot provide both body and append_body — they are mutually exclusive"`
3. Node not in DB → `"Node not found: {node_id}"`
4. File missing on disk → `"File not found on disk: {node_id}. Database and filesystem are out of sync."`

## Validation

Warns, never rejects — consistent with `create-node` and Phase 2 design. Warnings returned alongside the updated node.

## What This Tool Does NOT Do

- Change title (that's `rename-node`)
- Change types (that's `batch-mutate` delete+create)
- Move the file to a different path
- Handle relationships directly (use `add-relationship` for that)
