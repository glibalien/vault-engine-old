# Serializer + File Path Generation — Design

Phase 3, Task 1. Pure functions that convert structured node data into clean markdown files and resolve schema filename templates to vault-relative paths.

## Decisions

1. **Custom YAML serializer** — not js-yaml or gray-matter.stringify. Frontmatter is always flat (scalars + arrays of scalars), so a ~60-80 line custom serializer gives exact control over output format without fighting a general-purpose library's quoting behavior.
2. **Match fixture/hand-written style** — bare dates (`2025-03-06`), double-quoted wiki-link references (`"[[Alice]]"`), inline arrays (`[task, meeting]`), unquoted plain strings. The project philosophy is "markdown is canonical" — files should look human-authored.
3. **Serializer handles type formatting** — accepts `Date` objects, booleans, numbers, arrays, reference strings. Single source of truth for "how does this value look in frontmatter."
4. **`frontmatter_fields` for ordering only, not filtering** — schema fields appear in declared order, unknown fields appended alphabetically. All fields serialized. Consistent with "warn, don't reject."
5. **Error on missing template variables** — `generateFilePath` throws if a `{{key}}` has no matching value. Silent fallbacks produce confusing paths.

## YAML Value Formatting Rules

| Value type | Output format | Example |
|---|---|---|
| `string` (plain, safe) | unquoted | `status: todo` |
| `string` (wiki-link) | double-quoted | `assignee: "[[Bob Jones]]"` |
| `string` (special chars) | double-quoted | `notes: "contains: colons"` |
| `number` | bare | `priority: 3` |
| `boolean` | bare | `billable: false` |
| `Date` | bare YYYY-MM-DD | `due_date: 2025-03-06` |
| `string[]` / `number[]` | inline array | `types: [meeting, task]` |
| `string[]` with refs | inline, items quoted | `attendees: ["[[Alice]]", "[[Bob]]"]` |

**Safe-pattern heuristic** applies to both top-level scalar values and individual array items: alphanumeric + spaces + hyphens + underscores don't need quoting. Everything else gets double-quoted. When in doubt, quote.

**Wiki-link detection:** `/\[\[/` test on the string value (same regex pattern used in the parser).

## `serializeNode` — Field Ordering

Input:

```typescript
interface SerializeNodeOptions {
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  body?: string;
  fieldOrder?: string[];  // pre-computed ordered field names
}
```

Output: complete `.md` file string.

Ordering logic:
1. `title` always first
2. `types` always second
3. Fields listed in `fieldOrder` (in that order), skipping any not present in `fields`
4. Remaining fields not in `fieldOrder`, sorted alphabetically
5. Fields with `undefined` or `null` values omitted

Body: if provided and non-empty, blank line between closing `---` and body. Trailing newline at end of file. Body written as-is (no transformation).

### Multi-Type Field Ordering

`computeFieldOrder` builds the `fieldOrder` array for multi-type nodes:
1. Collect schemas for all types from DB
2. Process schemas in alphabetical order by name (deterministic)
3. Concatenate each schema's `serialization.frontmatter_fields`, deduplicating (first occurrence wins)
4. Single-type nodes get their schema's exact declared order
5. Returns `string[]` — the serializer stays pure, no schema awareness

Example for `types: [meeting, task]`:
- `meeting` fields: `[date, attendees, project, status]`
- `task` fields (appended, dedup): `[date, attendees, project, status, assignee, due_date, priority]`

## `generateFilePath` — Template Resolution

```typescript
function generateFilePath(
  title: string,
  types: string[],
  fields: Record<string, unknown>,
  db: Database.Database,
): string
```

Pipeline:
1. Look up schemas for the node's types from DB
2. Find the first schema with `serialization.filename_template` (schemas in alphabetical order)
3. If no schema/template, fall back to `"{{title}}.md"`
4. Interpolate: `{{title}}` from title, `{{date}}` and other `{{key}}` from fields
5. Date values formatted as `YYYY-MM-DD` in filenames
6. If any variable unresolved, throw error
7. Sanitize: strip characters unsafe for filenames (`\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) within path segments, preserve `/` from template directory structure

Collision detection (file already exists at path) is not this function's responsibility — handled by the MCP tool layer.

## File Structure

```
src/serializer/
    frontmatter.ts    # Custom YAML serializer
                      #   serializeValue(value: unknown): string
                      #   serializeFrontmatter(entries: Array<{ key: string; value: unknown }>): string
    node-to-file.ts   # Complete .md file assembly
                      #   serializeNode(opts: SerializeNodeOptions): string
                      #   computeFieldOrder(types: string[], db: Database.Database): string[]
    path.ts           # Filename template resolution
                      #   generateFilePath(title, types, fields, db): string
    index.ts          # Re-exports: serializeNode, computeFieldOrder, generateFilePath
```

No new dependencies. `frontmatter.ts` and `serializeNode` are pure functions (no DB, no filesystem). `computeFieldOrder` and `generateFilePath` read from DB (schema lookup). `path.ts` is the only file that touches the DB directly.
