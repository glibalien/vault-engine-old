# Filename Template Inference Design

**Goal:** Automatically populate `serialization.filename_template` in schema YAML files during `infer-schemas`, so `create-node` places files in the correct directory without manual `parent_path` overrides.

## Problem

`infer-schemas` infers field names, types, and enum values — but never populates `filename_template`. Without a template, `create-node` falls back to the vault root. The data to infer templates already exists: the `nodes` table has `file_path` for every indexed file.

## Approach

Extend `analyzeVault` in `src/inference/analyzer.ts` to infer templates as part of the existing per-type analysis pass. The inferred template flows through `generateSchemas` into schema YAML files.

## Data Model

Add one field to `TypeAnalysis` in `src/inference/types.ts`:

```typescript
export interface TypeAnalysis {
  // ... existing fields
  inferred_template: string | null;
}
```

No new interfaces. The string slots directly into the existing `SchemaDefinition.serialization.filename_template`.

## Inference Algorithm

New function `inferFilenameTemplate(db, typeName, inferredFields)` in `src/inference/analyzer.ts`:

### Step 1: Directory frequency analysis

SQL query joining `nodes` + `node_types`. Extract full dirname from `file_path` (everything before last `/`; empty string for root-level files). `GROUP BY` directory, `ORDER BY count DESC`.

### Step 2: Dominance check

If the top directory contains ≥80% of the type's nodes → it's the dominant directory. Otherwise return `null` (no template proposed).

### Step 3: Date pattern detection

Only if both conditions hold:
- The type has a `date` field (check `inferredFields` for a field named `date`)
- \>50% of filenames in the dominant directory match `YYYY-MM-DD-*` or `YYYY-MM-DD *` prefix

If both → `<dir>/{{date}}-{{title}}.md`. Otherwise → `<dir>/{{title}}.md`.

### Step 4: Integration with `analyzeVault`

After computing fields for each type, call `inferFilenameTemplate` and set `TypeAnalysis.inferred_template`.

### Thresholds

- 80% for dominant directory (hardcoded)
- 50% for date pattern detection (hardcoded)

## Generator Integration (`src/inference/generator.ts`)

### Overwrite mode (`buildFreshSchema`)

If `inferred_template` is non-null, set `serialization: { filename_template: inferred_template }`.

### Merge mode (`mergeSchema`)

Only populate `serialization.filename_template` from inference if the existing schema **does not already have one**. Existing templates are never overwritten in merge mode.

### Report mode

No schema generation. `inferred_template` is on `TypeAnalysis` and appears in the JSON response naturally.

## `formatTemplateValue` Fix (`src/serializer/path.ts`)

`formatTemplateValue` currently calls `String(value)`, which leaves `[[2026-03-28]]` brackets intact. Fix:

```typescript
function formatTemplateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  const match = str.match(/^\[\[(.+)\]\]$/);
  return match ? match[1] : str;
}
```

This is a general fix — any reference field used in a template gets its brackets stripped.

## Tests

Tests in `tests/inference/`:

1. **Dominant directory detection** — Nodes clustered ≥80% in one directory → correct template.
2. **No dominant directory** — Nodes spread (<80% in any dir) → `null`.
3. **Date pattern detection** — Dominant dir + >50% date-prefixed filenames + `date` field → `{{date}}-{{title}}.md`. Date-prefixed filenames but no `date` field → plain `{{title}}.md`.
4. **Merge vs overwrite** — Merge preserves existing template. Overwrite replaces with inferred.
5. **`formatTemplateValue` bracket stripping** — `[[foo]]` → `foo`, plain strings unchanged.

## Files Changed

| File | Change |
|------|--------|
| `src/inference/types.ts` | Add `inferred_template` to `TypeAnalysis` |
| `src/inference/analyzer.ts` | Add `inferFilenameTemplate()`, call from `analyzeVault` |
| `src/inference/generator.ts` | Wire `inferred_template` into `buildFreshSchema` and `mergeSchema` |
| `src/serializer/path.ts` | Fix `formatTemplateValue` to strip `[[]]` brackets |
| `tests/inference/template.test.ts` | New test file for template inference |
| `tests/serializer/path.test.ts` | Test for bracket stripping in `formatTemplateValue` |
