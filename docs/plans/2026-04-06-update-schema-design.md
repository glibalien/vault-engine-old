# Update Schema Tool — Design

## Problem

There is no MCP tool for directly editing schema definitions. The only ways to modify a schema are `infer-schemas` (data-driven, can't express intent) and manual YAML editing (requires leaving the conversation). Neither supports the common workflow of "this field should be `list<reference>`, just fix it."

This gap showed up concretely during Project → project normalization: after normalizing files, we had to re-run `infer-schemas` in overwrite mode just to remove the stale uppercase `Project` field — a sledgehammer for a thumbtack.

## Solution

An `update-schema` MCP tool that performs direct, surgical modifications to `.schemas/*.yaml` files: adding fields, removing fields, changing field types, renaming fields, and updating schema metadata.

## Pipeline

```
tool handler (server.ts)
  → updateSchema(db, vaultPath, schemaName, operations)
    → read .schemas/<name>.yaml from disk (or start empty object if new schema)
    → parse YAML to JS object
    → apply all operations sequentially to in-memory copy
    → validate final result
    → snapshot existing file (for rollback)
    → write via stringifyYaml(schema, { lineWidth: 0 })
    → loadSchemas(db, vaultPath) to reload into DB
    → on reload failure: restore snapshot, return error
    → return updated ResolvedSchema + file_path + warnings
```

### Atomicity

All operations apply to an in-memory copy. Validation runs on the final result after all operations. Write to disk only if validation passes. No partial writes if operation #3 of 5 fails.

### Rollback

Before writing, snapshot the existing YAML file content (or `null` if creating a new schema). If `loadSchemas` throws after the write (e.g., the new schema interacts badly with another schema's extends chain in a way per-file validation didn't catch), restore the snapshot (rewrite original content or delete the new file) and return an error. Same pattern `normalize-fields` uses for bulk operations.

## Module

Core logic in `src/mcp/update-schema.ts`. Tool registration in `server.ts`.

### Read Step

Always reads the raw YAML file from `.schemas/<name>.yaml`, never the DB's `ResolvedSchema`. If `work-task` extends `task`, editing `work-task` only sees/touches the fields defined locally in `work-task.yaml` — not inherited fields from `task`.

If the file doesn't exist, start with `{ name: schemaName, fields: {} }`. This is effectively "create schema." Create the `.schemas/` directory if needed.

### YAML Formatting

Uses `stringifyYaml(schema, { lineWidth: 0 })`, matching the existing `writeSchemaFiles` pattern in `src/inference/generator.ts`. YAML comments are not preserved on write — this is documented in the tool description.

## Operations

Five operations, applied sequentially in array order to an in-memory copy:

### `add_field`

Add a new field definition. Error if field already exists in this schema's local fields.

| Param | Required | Description |
|-------|----------|-------------|
| `field` | yes | Field name to add |
| `definition` | yes | Full field definition (`type`, `values`, `required`, `target_schema`, `default`) |

### `remove_field`

Remove a field definition. Error if field doesn't exist locally. Does NOT modify vault files.

| Param | Required | Description |
|-------|----------|-------------|
| `field` | yes | Field name to remove |

### `rename_field`

Rename a field key in the schema. Error if `field` doesn't exist or `new_name` already exists. Preserves the definition and field ordering. Does NOT rename the field in vault files — use `normalize-fields` with a `rename_key` rule for that.

| Param | Required | Description |
|-------|----------|-------------|
| `field` | yes | Current field name |
| `new_name` | yes | New field name |

### `update_field`

Merge provided definition keys into an existing field's definition. Only provided keys are changed; others are preserved. Error if field doesn't exist locally.

| Param | Required | Description |
|-------|----------|-------------|
| `field` | yes | Field name to update |
| `definition` | yes | Partial field definition to merge |

### `set_metadata`

Set schema-level metadata. Supported keys: `display_name`, `icon`, `extends`, `serialization`.

| Param | Required | Description |
|-------|----------|-------------|
| `key` | yes | Metadata key |
| `value` | yes | New value |

For `extends`, validates the target schema file exists on disk before writing. Error message includes expected file path and instructions.

## Validation

Runs once on the final in-memory schema after all operations are applied:

1. **Field types** — Each field's `type` must be a valid `SchemaFieldType` (`string`, `number`, `date`, `boolean`, `enum`, `reference`, `list<string>`, `list<reference>`)
2. **Enum completeness** — If type is `enum`, `values` must be a non-empty array
3. **Extends chain** — If `extends` is set, `.schemas/<parent>.yaml` must exist on disk. Error: `"Cannot set extends to '<name>': no schema file found at .schemas/<name>.yaml. Create the parent schema first, then extend from it."`
4. **Rename collisions** — `new_name` must not already exist in the schema's fields

> **Out of scope for v1:** Deleting a schema that other schemas extend from. If a delete operation is added later, the same validation should apply in reverse — refuse to delete a parent that has children extending from it.

## Return Value

```typescript
{
  schema: ResolvedSchema,       // Full resolved schema after reload (with inheritance)
  file_path: string,            // e.g. ".schemas/task.yaml"
  operations_applied: number,
  warnings: string[]            // Call-specific only (see below)
}
```

### Warnings

The `warnings` array contains only call-specific warnings, not always-true caveats. Examples:
- `"Field 'status' is inherited from parent schema 'task'; this update only affects the local override in 'work-task'."`

Always-true information (like "YAML comments are not preserved") belongs in the tool description, not in per-call warnings.

## Tool Registration (Zod Schema)

```typescript
tool("update-schema", {
  description: "Update a schema definition. Add, remove, rename, or modify fields and metadata. " +
    "Changes are written to .schemas/*.yaml and reloaded into the DB immediately. " +
    "If the schema doesn't exist yet, it will be created. " +
    "This tool modifies schema definitions only — it does not touch vault files. " +
    "Use normalize-fields to propagate schema changes to existing files. " +
    "Note: YAML comments in schema files are not preserved on write.",
  params: {
    schema_name: z.string()
      .describe("Name of the schema to update or create, e.g. 'task', 'meeting'"),
    operations: z.array(z.object({
      action: z.enum(["add_field", "remove_field", "rename_field", "update_field", "set_metadata"]),
      field: z.string().optional()
        .describe("Field name (required for all field actions)"),
      definition: z.object({
        type: z.string().optional(),
        values: z.array(z.string()).optional(),
        required: z.boolean().optional(),
        target_schema: z.string().optional(),
        default: z.any().optional(),
      }).optional()
        .describe("Field definition (required for add_field, update_field)"),
      new_name: z.string().optional()
        .describe("For rename_field: the new field name"),
      key: z.string().optional()
        .describe("For set_metadata: metadata key (display_name, icon, extends, serialization)"),
      value: z.any().optional()
        .describe("For set_metadata: metadata value"),
    }))
      .describe("Operations to apply sequentially"),
  }
})
```

## Relationship to Other Tools

| Tool | Purpose |
|------|---------|
| `update-schema` | Edit schema definitions (YAML files) |
| `infer-schemas` | Derive schemas from vault data |
| `normalize-fields` | Fix vault files to match schema definitions |
| `describe-schema` | Read schema definitions (read-only) |
| `validate-node` | Check a node against schema definitions |

## Scope

### In scope (v1)
- Add, remove, rename, update individual fields
- Set schema metadata (`display_name`, `icon`, `extends`, `serialization`)
- Create new schemas from scratch (via operations on a non-existent schema name)
- Validation before write, rollback on reload failure

### Out of scope (v1)
- Schema type rename (e.g., `bandartist` → `artist`) — requires updating `types` arrays in vault files
- Bulk schema operations across multiple schemas
- Schema deletion
- Computed field management
