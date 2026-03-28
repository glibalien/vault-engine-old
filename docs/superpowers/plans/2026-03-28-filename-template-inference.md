# Filename Template Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically infer `serialization.filename_template` from file path patterns during `infer-schemas`, so `create-node` places files in the correct directory without manual `parent_path` overrides.

**Architecture:** Extend `analyzeVault` in `src/inference/analyzer.ts` with a new `inferFilenameTemplate` function that queries directory frequencies per type from the DB, detects date-prefixed filename patterns, and returns a template string or null. The result flows through `generateSchemas` into schema YAML. A small fix to `formatTemplateValue` in `src/serializer/path.ts` strips `[[]]` brackets from reference values during template interpolation.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/inference/types.ts` | Modify | Add `inferred_template: string \| null` to `TypeAnalysis` |
| `src/inference/analyzer.ts` | Modify | Add `inferFilenameTemplate()`, call it from `analyzeVault` |
| `src/inference/generator.ts` | Modify | Wire `inferred_template` into `buildFreshSchema` and `mergeSchema` |
| `src/serializer/path.ts` | Modify | Fix `formatTemplateValue` to strip `[[]]` brackets |
| `tests/inference/analyzer.test.ts` | Modify | Add tests for `inferFilenameTemplate` and `analyzeVault` integration |
| `tests/inference/generator.test.ts` | Modify | Add tests for template propagation in merge/overwrite modes |
| `tests/serializer/path.test.ts` | Modify | Add test for bracket stripping in `formatTemplateValue` |

---

### Task 1: Add `inferred_template` to `TypeAnalysis`

**Files:**
- Modify: `src/inference/types.ts:21-28`

- [ ] **Step 1: Add the field**

In `src/inference/types.ts`, add `inferred_template` to the `TypeAnalysis` interface:

```typescript
export interface TypeAnalysis {
  name: string;
  node_count: number;
  has_existing_schema: boolean;
  inferred_fields: InferredField[];
  discrepancies: Discrepancy[];
  shared_fields: string[];
  inferred_template: string | null;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

This will produce errors in `analyzer.ts` (the `TypeAnalysis` object literal at line 272 is missing `inferred_template`) and in `tests/inference/generator.test.ts` (the `makeAnalysis` helper). That's expected — we'll fix them in later tasks.

- [ ] **Step 3: Fix `analyzeVault` to compile**

In `src/inference/analyzer.ts`, at line 272 where `typeAnalyses.push({...})` is called, add `inferred_template: null` as a placeholder:

```typescript
    typeAnalyses.push({
      name: schema_type,
      node_count: nodeCount,
      has_existing_schema: hasExistingSchema,
      inferred_fields: inferredFields,
      discrepancies,
      shared_fields: [], // Filled in below
      inferred_template: null, // Filled in by Task 2
    });
```

- [ ] **Step 4: Fix test helper to compile**

In `tests/inference/generator.test.ts`, add `inferred_template: null` to the `makeAnalysis` helper's type object (around line 14):

```typescript
function makeAnalysis(): InferenceResult {
  return {
    types: [
      {
        name: 'task',
        node_count: 10,
        has_existing_schema: false,
        inferred_template: null,
        inferred_fields: [
```

- [ ] **Step 5: Verify everything compiles and tests pass**

Run: `npx tsc --noEmit && npm test`
Expected: All green.

- [ ] **Step 6: Commit**

```bash
git add src/inference/types.ts src/inference/analyzer.ts tests/inference/generator.test.ts
git commit -m "feat(inference): add inferred_template field to TypeAnalysis"
```

---

### Task 2: Implement `inferFilenameTemplate`

**Files:**
- Modify: `src/inference/analyzer.ts`
- Modify: `tests/inference/analyzer.test.ts`

- [ ] **Step 1: Write failing tests for `inferFilenameTemplate`**

Add the following tests to `tests/inference/analyzer.test.ts`. These test `inferFilenameTemplate` directly using an in-memory DB populated with `nodes` and `node_types` rows.

```typescript
import { inferFilenameTemplate, inferFieldType, analyzeVault } from '../../src/inference/analyzer.js';
```

Add a new `describe('inferFilenameTemplate', ...)` block after the existing `describe('inferFieldType', ...)` block:

```typescript
describe('inferFilenameTemplate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertNode(filePath: string, typeName: string) {
    db.prepare('INSERT OR REPLACE INTO nodes (id, title, file_path) VALUES (?, ?, ?)').run(
      filePath,
      filePath.split('/').pop()!.replace('.md', ''),
      filePath,
    );
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(filePath, typeName);
  }

  it('returns template when >=80% of nodes are in the same directory', () => {
    insertNode('Meetings/standup.md', 'meeting');
    insertNode('Meetings/retro.md', 'meeting');
    insertNode('Meetings/planning.md', 'meeting');
    insertNode('Meetings/review.md', 'meeting');
    insertNode('Notes/offsite-notes.md', 'meeting');

    const result = inferFilenameTemplate(db, 'meeting', []);
    expect(result).toBe('Meetings/{{title}}.md');
  });

  it('returns null when no directory has >=80%', () => {
    insertNode('Meetings/standup.md', 'meeting');
    insertNode('Meetings/retro.md', 'meeting');
    insertNode('Notes/planning.md', 'meeting');
    insertNode('Archive/review.md', 'meeting');
    insertNode('Other/misc.md', 'meeting');

    const result = inferFilenameTemplate(db, 'meeting', []);
    expect(result).toBeNull();
  });

  it('handles nested directories using full dirname', () => {
    insertNode('TaskNotes/Tasks/review.md', 'task');
    insertNode('TaskNotes/Tasks/deploy.md', 'task');
    insertNode('TaskNotes/Tasks/bugfix.md', 'task');
    insertNode('TaskNotes/Tasks/refactor.md', 'task');
    insertNode('TaskNotes/Tasks/test.md', 'task');

    const result = inferFilenameTemplate(db, 'task', []);
    expect(result).toBe('TaskNotes/Tasks/{{title}}.md');
  });

  it('returns date-prefixed template when >50% match date pattern and date field exists', () => {
    insertNode('Meetings/2026-03-01-standup.md', 'meeting');
    insertNode('Meetings/2026-03-02-retro.md', 'meeting');
    insertNode('Meetings/2026-03-03-planning.md', 'meeting');
    insertNode('Meetings/review.md', 'meeting');

    const inferredFields = [{ key: 'date', inferred_type: 'reference' as const, frequency: 1, distinct_values: 3, sample_values: [], enum_candidate: false }];
    const result = inferFilenameTemplate(db, 'meeting', inferredFields);
    expect(result).toBe('Meetings/{{date}}-{{title}}.md');
  });

  it('returns plain template when date pattern detected but no date field', () => {
    insertNode('Meetings/2026-03-01-standup.md', 'meeting');
    insertNode('Meetings/2026-03-02-retro.md', 'meeting');
    insertNode('Meetings/2026-03-03-planning.md', 'meeting');
    insertNode('Meetings/review.md', 'meeting');

    const result = inferFilenameTemplate(db, 'meeting', []);
    expect(result).toBe('Meetings/{{title}}.md');
  });

  it('returns plain template when <50% match date pattern even with date field', () => {
    insertNode('Meetings/2026-03-01-standup.md', 'meeting');
    insertNode('Meetings/retro.md', 'meeting');
    insertNode('Meetings/planning.md', 'meeting');
    insertNode('Meetings/review.md', 'meeting');

    const inferredFields = [{ key: 'date', inferred_type: 'reference' as const, frequency: 1, distinct_values: 1, sample_values: [], enum_candidate: false }];
    const result = inferFilenameTemplate(db, 'meeting', inferredFields);
    expect(result).toBe('Meetings/{{title}}.md');
  });

  it('handles root-level dominant directory (empty dirname)', () => {
    insertNode('standup.md', 'meeting');
    insertNode('retro.md', 'meeting');
    insertNode('planning.md', 'meeting');
    insertNode('review.md', 'meeting');
    insertNode('Meetings/offsite.md', 'meeting');

    const result = inferFilenameTemplate(db, 'meeting', []);
    expect(result).toBe('{{title}}.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: FAIL — `inferFilenameTemplate` is not exported from `analyzer.js`.

- [ ] **Step 3: Implement `inferFilenameTemplate`**

Add the following function to `src/inference/analyzer.ts`, before the `analyzeVault` function:

```typescript
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}[- ]/;
const DIR_DOMINANCE_THRESHOLD = 0.8;
const DATE_PATTERN_THRESHOLD = 0.5;

/**
 * Infer a filename_template for a type based on directory frequency
 * and date-prefix patterns in existing file paths.
 */
export function inferFilenameTemplate(
  db: Database.Database,
  typeName: string,
  inferredFields: InferredField[],
): string | null {
  // Query all file paths for this type
  const rows = db.prepare(
    `SELECT n.file_path FROM nodes n
     JOIN node_types nt ON n.id = nt.node_id
     WHERE nt.schema_type = ?`
  ).all(typeName) as Array<{ file_path: string }>;

  if (rows.length === 0) return null;

  // Count directory frequencies
  const dirCounts = new Map<string, number>();
  for (const row of rows) {
    const lastSlash = row.file_path.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : row.file_path.slice(0, lastSlash);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  // Find dominant directory
  let topDir = '';
  let topCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > topCount) {
      topDir = dir;
      topCount = count;
    }
  }

  // Dominance check
  if (topCount / rows.length < DIR_DOMINANCE_THRESHOLD) return null;

  // Date pattern detection — only if type has a date field
  const hasDateField = inferredFields.some(f => f.key === 'date');
  if (hasDateField) {
    const filesInDir = rows.filter(r => {
      const lastSlash = r.file_path.lastIndexOf('/');
      const dir = lastSlash === -1 ? '' : r.file_path.slice(0, lastSlash);
      return dir === topDir;
    });

    const dateCount = filesInDir.filter(r => {
      const filename = r.file_path.slice(topDir.length > 0 ? topDir.length + 1 : 0);
      return DATE_PREFIX_RE.test(filename);
    }).length;

    if (filesInDir.length > 0 && dateCount / filesInDir.length > DATE_PATTERN_THRESHOLD) {
      if (topDir === '') return '{{date}}-{{title}}.md';
      return `${topDir}/{{date}}-{{title}}.md`;
    }
  }

  // Plain template
  if (topDir === '') return '{{title}}.md';
  return `${topDir}/{{title}}.md`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/inference/analyzer.ts tests/inference/analyzer.test.ts
git commit -m "feat(inference): implement inferFilenameTemplate with directory frequency and date pattern detection"
```

---

### Task 3: Wire `inferFilenameTemplate` into `analyzeVault`

**Files:**
- Modify: `src/inference/analyzer.ts:272-280`
- Modify: `tests/inference/analyzer.test.ts`

- [ ] **Step 1: Write failing test for `analyzeVault` integration**

Add a test to the existing `describe('analyzeVault', ...)` block in `tests/inference/analyzer.test.ts`:

```typescript
  it('populates inferred_template from file paths', () => {
    // Index 5 meetings in Meetings/ dir — 100% dominance
    for (const name of ['standup', 'retro', 'planning', 'review', 'sync']) {
      const raw = `---\ntitle: ${name}\ntypes: [meeting]\ndate: "[[2026-03-01]]"\n---\n# ${name}\n`;
      const relativePath = `Meetings/${name}.md`;
      const parsed = parseFile(relativePath, raw);
      indexFile(db, parsed, relativePath, '2026-03-28T00:00:00.000Z', raw);
    }

    const result = analyzeVault(db);
    const meeting = result.types.find(t => t.name === 'meeting')!;
    expect(meeting).toBeDefined();
    expect(meeting.inferred_template).toBe('Meetings/{{title}}.md');
  });

  it('returns null inferred_template when files are spread across directories', () => {
    const dirs = ['A', 'B', 'C', 'D', 'E'];
    for (const dir of dirs) {
      const raw = `---\ntitle: ${dir}-task\ntypes: [task]\n---\n# ${dir}\n`;
      const relativePath = `${dir}/${dir}-task.md`;
      const parsed = parseFile(relativePath, raw);
      indexFile(db, parsed, relativePath, '2026-03-28T00:00:00.000Z', raw);
    }

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    expect(task).toBeDefined();
    expect(task.inferred_template).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: FAIL — `inferred_template` is `null` for the first test because `analyzeVault` doesn't call `inferFilenameTemplate` yet.

- [ ] **Step 3: Wire the call into `analyzeVault`**

In `src/inference/analyzer.ts`, in the `analyzeVault` function, replace the `inferred_template: null` placeholder in the `typeAnalyses.push(...)` call (around line 272) with a call to `inferFilenameTemplate`:

```typescript
    typeAnalyses.push({
      name: schema_type,
      node_count: nodeCount,
      has_existing_schema: hasExistingSchema,
      inferred_fields: inferredFields,
      discrepancies,
      shared_fields: [], // Filled in below
      inferred_template: inferFilenameTemplate(db, schema_type, inferredFields),
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/inference/analyzer.ts tests/inference/analyzer.test.ts
git commit -m "feat(inference): wire inferFilenameTemplate into analyzeVault pipeline"
```

---

### Task 4: Wire inferred template into schema generation

**Files:**
- Modify: `src/inference/generator.ts:15-30` (`buildFreshSchema`), `src/inference/generator.ts:32-75` (`mergeSchema`), `src/inference/generator.ts:77-100` (`generateSchemas`)
- Modify: `tests/inference/generator.test.ts`

- [ ] **Step 1: Write failing tests**

Add these tests to `tests/inference/generator.test.ts`, inside the existing `describe('generateSchemas', ...)` block:

```typescript
  it('includes inferred_template in fresh schema (overwrite mode)', () => {
    const analysis = makeAnalysis();
    analysis.types[0].inferred_template = 'tasks/{{title}}.md';

    const result = generateSchemas(analysis, 'overwrite', new Map());
    expect(result[0].serialization?.filename_template).toBe('tasks/{{title}}.md');
  });

  it('does not set serialization when inferred_template is null', () => {
    const analysis = makeAnalysis();
    analysis.types[0].inferred_template = null;

    const result = generateSchemas(analysis, 'overwrite', new Map());
    expect(result[0].serialization).toBeUndefined();
  });

  it('does not overwrite existing template in merge mode', () => {
    const existing: ResolvedSchema = {
      name: 'task',
      ancestors: [],
      fields: {
        status: { type: 'enum', values: ['todo', 'done'] },
      },
      serialization: { filename_template: 'custom/{{title}}.md' },
    };

    const analysis = makeAnalysis();
    analysis.types[0].has_existing_schema = true;
    analysis.types[0].inferred_template = 'tasks/{{title}}.md';

    const result = generateSchemas(analysis, 'merge', new Map([['task', existing]]));
    expect(result[0].serialization?.filename_template).toBe('custom/{{title}}.md');
  });

  it('populates template in merge mode when existing schema has no template', () => {
    const existing: ResolvedSchema = {
      name: 'task',
      ancestors: [],
      fields: {
        status: { type: 'enum', values: ['todo', 'done'] },
      },
    };

    const analysis = makeAnalysis();
    analysis.types[0].has_existing_schema = true;
    analysis.types[0].inferred_template = 'tasks/{{title}}.md';

    const result = generateSchemas(analysis, 'merge', new Map([['task', existing]]));
    expect(result[0].serialization?.filename_template).toBe('tasks/{{title}}.md');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inference/generator.test.ts`
Expected: FAIL — `serialization` is `undefined` in overwrite mode, and merge mode doesn't populate from inference.

- [ ] **Step 3: Update `buildFreshSchema` to accept and use `inferred_template`**

In `src/inference/generator.ts`, change `buildFreshSchema` to accept the `TypeAnalysis` object instead of just `inferred_fields`:

```typescript
function buildFreshSchema(name: string, typeAnalysis: InferenceResult['types'][0]): SchemaDefinition {
  const fields: Record<string, FieldDefinition> = {};
  for (const field of typeAnalysis.inferred_fields) {
    const def: FieldDefinition = { type: field.inferred_type };
    if (field.inferred_type === 'enum' && field.enum_values) {
      def.values = [...field.enum_values];
    }
    fields[field.key] = def;
  }

  const schema: SchemaDefinition = {
    name,
    display_name: titleCase(name),
    fields,
  };

  if (typeAnalysis.inferred_template) {
    schema.serialization = { filename_template: typeAnalysis.inferred_template };
  }

  return schema;
}
```

- [ ] **Step 4: Update `mergeSchema` to populate template from inference when none exists**

In `src/inference/generator.ts`, change `mergeSchema` to accept `inferred_template`:

```typescript
function mergeSchema(
  existing: ResolvedSchema,
  typeAnalysis: InferenceResult['types'][0],
): SchemaDefinition {
  const fields: Record<string, FieldDefinition> = {};

  // Start with all existing fields (preserving their full definitions)
  for (const [key, def] of Object.entries(existing.fields)) {
    fields[key] = { ...def };
  }

  // Add inferred fields that don't already exist, and union enum values
  for (const field of typeAnalysis.inferred_fields) {
    if (fields[field.key]) {
      // Field exists — only merge enum values
      const existingDef = fields[field.key];
      if (existingDef.type === 'enum' && existingDef.values && field.enum_values) {
        const merged = new Set([...existingDef.values, ...field.enum_values]);
        existingDef.values = [...merged];
      }
    } else {
      // New field — add it
      const def: FieldDefinition = { type: field.inferred_type };
      if (field.inferred_type === 'enum' && field.enum_values) {
        def.values = [...field.enum_values];
      }
      fields[field.key] = def;
    }
  }

  const schema: SchemaDefinition = {
    name: existing.name,
    display_name: existing.display_name ?? titleCase(existing.name),
    fields,
  };

  // Preserve existing properties
  if (existing.icon) schema.icon = existing.icon;
  if (existing.extends) schema.extends = existing.extends;
  if (existing.computed) schema.computed = existing.computed;

  // Serialization: preserve existing, or populate from inference
  if (existing.serialization) {
    schema.serialization = existing.serialization;
  } else if (typeAnalysis.inferred_template) {
    schema.serialization = { filename_template: typeAnalysis.inferred_template };
  }

  return schema;
}
```

- [ ] **Step 5: Update `generateSchemas` call sites**

In `src/inference/generator.ts`, update the `generateSchemas` function to pass `typeAnalysis` instead of `typeAnalysis.inferred_fields`:

```typescript
export function generateSchemas(
  analysis: InferenceResult,
  mode: InferenceMode,
  existingSchemas: Map<string, ResolvedSchema>,
): SchemaDefinition[] {
  if (mode === 'report') return [];

  const schemas: SchemaDefinition[] = [];

  for (const typeAnalysis of analysis.types) {
    if (mode === 'merge' && typeAnalysis.has_existing_schema) {
      const existing = existingSchemas.get(typeAnalysis.name);
      if (existing) {
        schemas.push(mergeSchema(existing, typeAnalysis));
        continue;
      }
    }

    // overwrite mode, or merge with no existing schema — build fresh
    schemas.push(buildFreshSchema(typeAnalysis.name, typeAnalysis));
  }

  return schemas;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/inference/generator.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/inference/generator.ts tests/inference/generator.test.ts
git commit -m "feat(inference): wire inferred_template into schema generation for merge and overwrite modes"
```

---

### Task 5: Fix `formatTemplateValue` to strip `[[]]` brackets

**Files:**
- Modify: `src/serializer/path.ts:8-11`
- Modify: `tests/serializer/path.test.ts`

- [ ] **Step 1: Write failing test**

Add this test to the existing `describe('generateFilePath', ...)` block in `tests/serializer/path.test.ts`:

```typescript
  it('strips [[]] brackets from reference field values in templates', () => {
    const result = generateFilePath(
      'Q1 Planning',
      ['meeting'],
      { date: '[[2025-03-06]]' },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Q1 Planning.md');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serializer/path.test.ts`
Expected: FAIL — the result will contain `[[2025-03-06]]` in the path, and `[` / `]` are not in the `UNSAFE_CHARS_RE` set so `sanitizeSegment` won't strip them either. The test will fail with an assertion mismatch.

- [ ] **Step 3: Fix `formatTemplateValue`**

In `src/serializer/path.ts`, replace `formatTemplateValue`:

```typescript
function formatTemplateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  const match = str.match(/^\[\[(.+)\]\]$/);
  return match ? match[1] : str;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/path.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/serializer/path.ts tests/serializer/path.test.ts
git commit -m "fix(serializer): strip [[]] brackets from reference values in filename templates"
```
