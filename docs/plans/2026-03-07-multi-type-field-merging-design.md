# Multi-type Field Merging — Design

## Problem

A node with `types: [meeting, task]` needs fields from both schemas merged into a single field set for validation and introspection. The merger must handle compatible fields, incompatible fields, and enum value set unions.

## API Surface

```typescript
mergeSchemaFields(db: Database, types: string[]): MergeResult
```

Pure function. Loads resolved schemas from DB via `getSchema()`, merges field definitions, returns result. No side effects.

## Return Types

```typescript
interface MergedField {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];        // unioned for enums
  target_schema?: string;
  sources: string[];        // which schemas contributed this field
}

interface MergeConflict {
  field: string;
  definitions: Array<{ schema: string; type: SchemaFieldType }>;
  message: string;
}

interface MergeResult {
  fields: Record<string, MergedField>;
  conflicts: MergeConflict[];
}
```

## Merging Rules

For each field name across all resolved schemas:

1. **Single source** — field appears in only one schema. Include as-is.

2. **Compatible** — same name, same `type`:
   - `required`: true if *any* schema marks it required
   - `default`: first schema's default wins, ordered alphabetically by schema name. This is a deliberate choice for determinism — alphabetical is arbitrary but predictable. In inheritance scenarios, the child already overrides the parent via `resolveInheritance`. In multi-type merging (meeting + task), there's no inherent priority, so alphabetical is defensible.
   - `values` (enum): union the value sets, deduplicated, preserving insertion order
   - `target_schema`: must match if both specify it. If different, treat as a conflict (see rule 3)

3. **Incompatible** — same name, different `type`. Record a `MergeConflict`. The field is excluded from `fields` — consumers must handle the conflict explicitly.

4. **`target_schema` mismatch** — same name, same type (`reference` or `list<reference>`), but different `target_schema` values. Treated as a conflict. The storage type matches but the semantic constraint disagrees.

## Edge Cases

- **Empty types array** — returns `{ fields: {}, conflicts: [] }`
- **Single type** — returns that schema's fields wrapped as `MergedField`s with `sources: [typeName]`
- **Unknown type** — type name has no schema in DB. Noted in `conflicts` with a descriptive message. Merging proceeds with schemas that do exist. Follows warn-don't-reject principle.
- **All types unknown** — returns `{ fields: {}, conflicts: [...] }` with one conflict per unknown type

## File Location

`src/schema/merger.ts` — exports `mergeSchemaFields` and the three types.

`src/schema/index.ts` — re-exports.

## Consumers

- **Task 3 (Schema Validation)** — calls `mergeSchemaFields` to get the combined field set for a node's types, then validates the node's actual fields against it
- **Task 5 (MCP `describe-schema`)** — can use merger to show combined fields for multi-typed queries
- **Phase 3 (`create-node`)** — validates proposed fields against merged schema before writing

## Concrete Example

`types: [meeting, task]`:

| Field | meeting | task | Result |
|-------|---------|------|--------|
| `date` | `date, required` | — | merged, required, sources: [meeting] |
| `attendees` | `list<reference>` | — | merged, sources: [meeting] |
| `project` | `reference (project)` | — | merged, sources: [meeting] |
| `status` | `enum [scheduled, completed, cancelled]` | `enum [todo, in-progress, blocked, done, cancelled], required` | merged, required, values unioned, sources: [meeting, task] |
| `assignee` | — | `reference (person)` | merged, sources: [task] |
| `due_date` | — | `date` | merged, sources: [task] |
| `priority` | — | `enum [critical, high, medium, low]` | merged, sources: [task] |
| `source` | — | `reference` | merged, sources: [task] |
