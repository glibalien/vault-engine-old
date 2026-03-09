# Schema Validation on Index — Design

**Phase 2, Task 3**

## Goal

Validate frontmatter fields against merged schema definitions during indexing. Warn, don't reject — files that violate schema are still valid markdown and still get indexed.

## Validator Module

New file `src/schema/validator.ts` exporting a pure function:

```typescript
function validateNode(parsed: ParsedFile, mergeResult: MergeResult): ValidationResult
```

### Types

```typescript
interface ValidationWarning {
  field: string;
  message: string;
  rule: 'required' | 'type_mismatch' | 'invalid_enum' | 'invalid_reference';
}

interface ValidationResult {
  valid: boolean;          // true if zero warnings
  warnings: ValidationWarning[];
}
```

### Validation Checks

Run in order:

1. **Required fields** — For each merged field with `required: true`, check that `parsed.fields` contains a matching key. Missing → warning with `rule: 'required'`.

2. **Type mismatch** — For each field present in both parsed data and schema, check parser `valueType` is compatible with schema `type`. Mapping:
   - Schema `string` ← parser `string`
   - Schema `number` ← parser `number`
   - Schema `date` ← parser `date`
   - Schema `boolean` ← parser `boolean`
   - Schema `enum` ← parser `string` (value checked separately)
   - Schema `reference` ← parser `reference`
   - Schema `list<string>` ← parser `list`
   - Schema `list<reference>` ← parser `list`

3. **Invalid enum value** — For `enum` fields, check that the value is in the schema's `values` array.

4. **Invalid reference syntax** — For `reference` fields, check that the raw frontmatter value looks like a wiki-link (`[[...]]`). For `list<reference>`, check each item.

The function is pure — no DB access, no side effects. Merge conflicts from `MergeResult` are not validation warnings (they're already surfaced by the merger).

## Integration with indexFile

### DB Schema Change

Add `is_valid` column to `nodes` table — `INTEGER NULL` (SQLite 0/1/null).

### Three-State Model

- `null` — no schema exists for any of the node's types (nothing to validate against)
- `1` — validated, zero warnings
- `0` — validated, has warnings

### indexFile Changes

After inserting the node:
1. Call `mergeSchemaFields(db, parsed.types)`
2. If all types are unknown (no schemas found) → set `is_valid = null`
3. Otherwise → call `validateNode(parsed, mergeResult)`, set `is_valid` to `1` or `0`

### What Doesn't Change

- Watcher and rebuild/incremental indexing call `indexFile` — they get validation automatically.
- Schema reload does not trigger bulk re-validation. Existing nodes keep stale `is_valid` until individually re-indexed.

## Exports

- `src/schema/validator.ts` exports `validateNode`, `ValidationResult`, `ValidationWarning`
- `src/schema/index.ts` re-exports all three

## Testing

### Unit Tests (`tests/schema/validator.test.ts`)

- Required field missing → warning
- Required field present → no warning
- Type mismatch → warning
- All compatible type mappings pass
- Invalid enum value → warning, valid enum passes
- Invalid reference syntax → warning, valid reference passes
- `list<reference>` with mixed valid/invalid items
- Empty merge result → valid, no warnings
- Multiple warnings accumulate

### Integration Tests (extend `tests/sync/indexer.test.ts`)

- `indexFile` sets `is_valid = 1` when node passes
- `indexFile` sets `is_valid = 0` when node has warnings
- `indexFile` sets `is_valid = null` when no schema exists
