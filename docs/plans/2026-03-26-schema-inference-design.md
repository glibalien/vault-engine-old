# Schema Inference — Design

## Overview

An `infer-schemas` MCP tool that scans the indexed DB to analyze actual field usage across node types, detect discrepancies against existing schema definitions, and optionally write inferred or merged schema YAML files. The tool always produces a full analysis report regardless of mode.

## MCP Tool Interface

### Tool: `infer-schemas`

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `enum: report, merge, overwrite` | `report` | `report` = return analysis only, write nothing. `merge` = write YAML files that expand existing schemas with inferred data (add fields, union enums, never remove). `overwrite` = write YAML files replacing schemas entirely with inferred data. |
| `types` | `string[]` | all | Limit analysis to specific types. Omit to analyze everything in `node_types`. |

**Return shape:**

```typescript
{
  types: Array<{
    name: string;                    // e.g., "task"
    node_count: number;              // how many nodes have this type
    has_existing_schema: boolean;
    inferred_fields: Array<{
      key: string;
      inferred_type: SchemaFieldType;  // string | number | date | boolean | enum | reference | list<string> | list<reference>
      frequency: number;               // 0.0–1.0, fraction of nodes of this type that have this field
      distinct_values: number;
      sample_values: string[];          // up to 10 examples
      enum_candidate: boolean;          // true if ≤20 distinct values and distinct/total ratio < 0.5
      enum_values?: string[];           // all distinct values, present only when enum_candidate is true
    }>;
    discrepancies: Array<{             // only populated when an existing schema exists
      field: string;
      issue: string;                   // human-readable description
      schema_value: unknown;           // what the schema says
      inferred_value: unknown;         // what the data says
    }>;
    shared_fields: string[];           // field keys that appear with the same inferred type in other types
  }>;
  files_written?: string[];            // vault-relative paths of YAML files written (merge/overwrite modes only)
}
```

## Inference Engine

### Module: `src/inference/`

```
src/inference/
  analyzer.ts     — analyzeVault(), DB queries, type inference, discrepancy detection
  generator.ts    — generateSchemas(), writeSchemaFiles(), YAML serialization
  types.ts        — InferredField, TypeAnalysis, Discrepancy, InferenceResult
  index.ts        — re-exports
```

### Analyzer (`analyzer.ts`)

**Core function:** `analyzeVault(db, types?: string[])` → `InferenceResult`

**Query strategy** (3 queries):

1. **Type counts:** `SELECT schema_type, COUNT(*) FROM node_types GROUP BY schema_type` — filtered by `types` param if provided.
2. **Field profiles:** Single query joining `fields` → `node_types`, grouped by `schema_type` and `key`. Returns `value_type`, `value_text`, and counts per type per field. Provides frequency, distinct values, and sample values. Post-processed in TypeScript to group by type.
3. **Existing schemas:** `SELECT name, definition FROM schemas` — parse JSON to compare against inferred data.

### Type Inference Logic

Applied per field, across all nodes of a given type. **Priority order matters** — earlier matches short-circuit later checks:

| Priority | DB `value_type` | Additional check | Inferred `SchemaFieldType` |
|----------|-----------------|------------------|---------------------------|
| 1 | `reference` | — | `reference` |
| 2 | `date` | — | `date` |
| 3 | `number` | — | `number` |
| 4 | `boolean` | — | `boolean` |
| 5 | `list` | Parse JSON, check if all elements contain `[[` | `list<reference>` if yes, `list<string>` otherwise |
| 6 | `string` | Value contains `[[` | `reference` |
| 7 | `string` | ≤20 distinct values AND distinct/total ratio < 0.5 | `enum` (with `enum_values`) |
| 8 | `string` | Otherwise | `string` |

**Critical: row 6 (string → reference) must evaluate before row 7 (string → enum).** A field where every value is `[[Alice]]` or `[[Bob]]` would pass the enum heuristic (small distinct set, values repeat) but is clearly a reference. Reference detection short-circuits enum evaluation.

**Mixed `value_type` across nodes:** When a field has different `value_type` values for the same key across nodes of the same type, use the most frequent type. Report the mixed types in `sample_values`.

### Discrepancy Detection

When an existing schema exists for a type, compare it field-by-field against inferred data:

- **Field in data but not in schema** → `"field '{key}' exists in {frequency}% of nodes but is not defined in schema"`
- **Field in schema but not in data** → `"field '{key}' defined in schema but not found in any node"`
- **Type mismatch** → `"schema defines '{key}' as '{schemaType}' but data suggests '{inferredType}'"`
- **Missing enum values** → `"value '{value}' appears in data but is not in schema 'values' list for '{key}'"`
- **Extra enum values** → `"schema defines value '{value}' for '{key}' but it never appears in data"`

### Shared Field Detection

After analyzing all types, compare field profiles across types. Two fields are "shared" if they have the same key and the same inferred type in 2+ types. Each type's `shared_fields` array lists the keys of such fields. This surfaces candidates for base schema inheritance — the user decides whether to act on it.

### What Is Not Inferred

- **`required`** — frequency is reported but required is a design intent decision, not inferable from data.
- **`default`** — no way to infer from stored values.
- **`target_schema`** — would require cross-referencing resolved targets against `node_types`; too speculative.
- **`extends`** — shared fields are reported but inheritance structure is a user decision.
- **`serialization`** — filename templates are conventions, not inferable from data.
- **`computed`** — definitionally not inferable from stored field data.

## Schema Generation & Writing

### Generator (`generator.ts`)

**Core functions:**
- `generateSchemas(analysis, mode, existingSchemas)` → `SchemaDefinition[]`
- `writeSchemaFiles(schemas, vaultPath)` → `string[]` (vault-relative paths written)

### Mode Behavior

| Mode | Existing schema | No existing schema |
|------|----------------|-------------------|
| `report` | Return analysis only, write nothing | Return analysis only, write nothing |
| `merge` | Start from existing definition. Add inferred fields not already defined. For enum fields, union the schema's `values` with inferred values. Never remove fields or values. Preserve `serialization`, `computed`, `extends`, and all other existing properties. | Generate fresh schema from inferred data. |
| `overwrite` | Replace entirely with inferred schema. Existing definition is ignored. `extends`, `serialization`, `computed` are all dropped — clean slate from data. | Generate fresh schema from inferred data. |

### Fresh Schema Shape

```yaml
name: task
display_name: Task          # title-cased from type name
fields:
  status:
    type: enum
    values: [todo, in-progress, done]
  assignee:
    type: reference
  due_date:
    type: date
  priority:
    type: enum
    values: [high, medium, low]
```

No `required`, `default`, `target_schema`, `extends`, `serialization`, or `computed` in generated schemas.

### File Writing

- Writes to `.schemas/{type-name}.yaml` in the vault directory.
- Uses the `yaml` library (already a dependency) for serialization.
- After writing, calls `loadSchemas(db, vaultPath)` to reload schemas into the DB so changes take effect immediately without server restart.

## MCP Tool Registration

Registered in `src/mcp/server.ts` alongside the existing 19 tools (becomes tool #20).

**Handler flow:**
1. Parse & validate params (`mode`, `types`) via Zod.
2. Call `analyzeVault(db, types)` to get analysis.
3. If `mode !== 'report'`: call `generateSchemas(analysis, mode, existingSchemas)`, then `writeSchemaFiles(schemas, vaultPath)`, then `loadSchemas(db, vaultPath)`.
4. Return structured response (analysis + `files_written` if applicable).

**Error cases:**
- Empty vault (no nodes indexed) → `toolError("No indexed nodes found. Run incremental index first.", "VALIDATION_ERROR")`
- Specified type not found → `toolError("Type '{name}' not found in indexed data.", "NOT_FOUND")`
- File write failure → `toolError("Failed to write schema file: {details}", "INTERNAL_ERROR")`

## Testing

Tests in `tests/inference/` using the existing fixture vault and in-memory SQLite.

### `analyzer.test.ts`
- Index fixture files into an in-memory DB.
- Run `analyzeVault` and verify:
  - Correct inferred types for each field (string, number, date, boolean, enum, reference, list<string>, list<reference>).
  - Frequency calculations (fraction of nodes with each field).
  - Enum candidate detection (≤20 distinct, ratio < 0.5).
  - Reference detection from string values containing `[[` (short-circuits enum check).
  - List element inspection (`list<reference>` vs `list<string>`).
  - Discrepancy detection against loaded schemas.
  - Shared field detection across types.

### `generator.test.ts`
- Feed known analysis results into `generateSchemas` for each mode:
  - `report` mode: returns empty array (no schemas generated).
  - `merge` mode: preserves existing fields, adds new inferred fields, unions enum values, preserves `serialization`/`computed`/`extends`.
  - `overwrite` mode: produces clean schema from inferred data only, drops all existing properties.
- Test YAML file writing to a temp directory.
- Verify `display_name` generation (title-cased from type name).
