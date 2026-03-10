# Serializer + File Path Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build pure functions that serialize structured node data into clean `.md` files and resolve schema `filename_template` to vault-relative paths.

**Architecture:** Three files in `src/serializer/`: `frontmatter.ts` (custom YAML serializer), `node-to-file.ts` (file assembly + field ordering), `path.ts` (template resolution). All serialization is pure-function; only `computeFieldOrder` and `generateFilePath` touch the DB for schema lookup.

**Tech Stack:** TypeScript ESM, better-sqlite3 (DB reads only), vitest for testing.

**Design doc:** `docs/plans/2026-03-09-serializer-design.md`

---

### Task 1: `serializeValue` — scalar value formatting

**Files:**
- Create: `src/serializer/frontmatter.ts`
- Create: `tests/serializer/frontmatter.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/serializer/frontmatter.test.ts
import { describe, it, expect } from 'vitest';
import { serializeValue } from '../../src/serializer/frontmatter.js';

describe('serializeValue', () => {
  it('serializes plain strings unquoted', () => {
    expect(serializeValue('todo')).toBe('todo');
  });

  it('serializes strings with spaces unquoted', () => {
    expect(serializeValue('in progress')).toBe('in progress');
  });

  it('serializes wiki-link strings double-quoted', () => {
    expect(serializeValue('[[Alice Smith]]')).toBe('"[[Alice Smith]]"');
  });

  it('serializes strings with colons double-quoted', () => {
    expect(serializeValue('note: important')).toBe('"note: important"');
  });

  it('serializes strings with hash double-quoted', () => {
    expect(serializeValue('section #1')).toBe('"section #1"');
  });

  it('serializes empty string double-quoted', () => {
    expect(serializeValue('')).toBe('""');
  });

  it('serializes numbers bare', () => {
    expect(serializeValue(3)).toBe('3');
    expect(serializeValue(3.14)).toBe('3.14');
  });

  it('serializes booleans bare', () => {
    expect(serializeValue(true)).toBe('true');
    expect(serializeValue(false)).toBe('false');
  });

  it('serializes Date as YYYY-MM-DD', () => {
    expect(serializeValue(new Date('2025-03-06'))).toBe('2025-03-06');
  });

  it('serializes arrays inline with unquoted safe items', () => {
    expect(serializeValue(['meeting', 'task'])).toBe('[meeting, task]');
  });

  it('serializes arrays with wiki-link items double-quoted', () => {
    expect(serializeValue(['[[Alice Smith]]', '[[Bob Jones]]'])).toBe(
      '["[[Alice Smith]]", "[[Bob Jones]]"]',
    );
  });

  it('serializes mixed arrays quoting only items that need it', () => {
    expect(serializeValue(['safe', '[[ref]]', 'also-safe'])).toBe(
      '[safe, "[[ref]]", also-safe]',
    );
  });

  it('serializes number arrays bare', () => {
    expect(serializeValue([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('quotes strings that look like YAML booleans', () => {
    expect(serializeValue('true')).toBe('"true"');
    expect(serializeValue('false')).toBe('"false"');
    expect(serializeValue('yes')).toBe('"yes"');
    expect(serializeValue('no')).toBe('"no"');
  });

  it('quotes strings that look like numbers', () => {
    expect(serializeValue('123')).toBe('"123"');
    expect(serializeValue('3.14')).toBe('"3.14"');
  });

  it('quotes strings with curly braces', () => {
    expect(serializeValue('{foo}')).toBe('"{foo}"');
  });

  it('quotes strings with square brackets (non-wiki-link)', () => {
    expect(serializeValue('[item]')).toBe('"[item]"');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/frontmatter.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/serializer/frontmatter.ts

const WIKI_LINK_RE = /\[\[/;
const YAML_BOOL_RE = /^(true|false|yes|no|on|off)$/i;
const YAML_NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// Safe: alphanumeric, spaces, hyphens, underscores, periods — no leading/trailing whitespace
const SAFE_STRING_RE = /^[a-zA-Z][a-zA-Z0-9 _.\-]*$/;

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (YAML_BOOL_RE.test(value)) return true;
  if (YAML_NUMBER_RE.test(value)) return true;
  if (WIKI_LINK_RE.test(value)) return true;
  if (!SAFE_STRING_RE.test(value)) return true;
  return false;
}

function quoteString(value: string): string {
  // Escape backslashes and double quotes inside the value
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function serializeScalar(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    return needsQuoting(value) ? quoteString(value) : value;
  }
  return quoteString(String(value));
}

export function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(item => serializeScalar(item));
    return `[${items.join(', ')}]`;
  }
  return serializeScalar(value);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/frontmatter.test.ts`
Expected: All PASS

**Step 5: Commit**

```
git add src/serializer/frontmatter.ts tests/serializer/frontmatter.test.ts
git commit -m "add serializeValue for custom YAML scalar/array formatting"
```

---

### Task 2: `serializeFrontmatter` — key-value pair rendering

**Files:**
- Modify: `src/serializer/frontmatter.ts`
- Modify: `tests/serializer/frontmatter.test.ts`

**Step 1: Write the failing tests**

Append to `tests/serializer/frontmatter.test.ts`:

```typescript
import { serializeValue, serializeFrontmatter } from '../../src/serializer/frontmatter.js';

describe('serializeFrontmatter', () => {
  it('serializes ordered entries as YAML lines', () => {
    const result = serializeFrontmatter([
      { key: 'title', value: 'Review proposal' },
      { key: 'status', value: 'todo' },
    ]);
    expect(result).toBe('title: Review proposal\nstatus: todo\n');
  });

  it('handles mixed value types', () => {
    const result = serializeFrontmatter([
      { key: 'title', value: 'Q1 Meeting' },
      { key: 'types', value: ['meeting', 'task'] },
      { key: 'date', value: new Date('2025-03-06') },
      { key: 'attendees', value: ['[[Alice Smith]]', '[[Bob Jones]]'] },
      { key: 'status', value: 'todo' },
      { key: 'billable', value: false },
      { key: 'priority', value: 3 },
    ]);
    const lines = result.split('\n');
    expect(lines[0]).toBe('title: Q1 Meeting');
    expect(lines[1]).toBe('types: [meeting, task]');
    expect(lines[2]).toBe('date: 2025-03-06');
    expect(lines[3]).toBe('attendees: ["[[Alice Smith]]", "[[Bob Jones]]"]');
    expect(lines[4]).toBe('status: todo');
    expect(lines[5]).toBe('billable: false');
    expect(lines[6]).toBe('priority: 3');
  });

  it('returns empty string for empty entries', () => {
    expect(serializeFrontmatter([])).toBe('');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/frontmatter.test.ts`
Expected: FAIL — `serializeFrontmatter` not found

**Step 3: Write minimal implementation**

Append to `src/serializer/frontmatter.ts`:

```typescript
export function serializeFrontmatter(
  entries: Array<{ key: string; value: unknown }>,
): string {
  if (entries.length === 0) return '';
  return entries.map(({ key, value }) => `${key}: ${serializeValue(value)}`).join('\n') + '\n';
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/frontmatter.test.ts`
Expected: All PASS

**Step 5: Commit**

```
git add src/serializer/frontmatter.ts tests/serializer/frontmatter.test.ts
git commit -m "add serializeFrontmatter for ordered key-value YAML rendering"
```

---

### Task 3: `serializeNode` — complete `.md` file assembly

**Files:**
- Create: `src/serializer/node-to-file.ts`
- Create: `tests/serializer/node-to-file.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/serializer/node-to-file.test.ts
import { describe, it, expect } from 'vitest';
import { serializeNode } from '../../src/serializer/node-to-file.js';

describe('serializeNode', () => {
  it('serializes a minimal node with title and types only', () => {
    const result = serializeNode({
      title: 'My Note',
      types: ['note'],
      fields: {},
    });
    expect(result).toBe('---\ntitle: My Note\ntypes: [note]\n---\n');
  });

  it('serializes a node with fields and body', () => {
    const result = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      body: 'Review the three vendor proposals.',
    });
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('title: Review proposal');
    expect(lines[2]).toBe('types: [task]');
    // fields in alphabetical order (no fieldOrder provided)
    expect(lines[3]).toBe('assignee: "[[Bob Jones]]"');
    expect(lines[4]).toBe('due_date: 2025-03-10');
    expect(lines[5]).toBe('priority: high');
    expect(lines[6]).toBe('status: todo');
    expect(lines[7]).toBe('---');
    expect(lines[8]).toBe('');
    expect(lines[9]).toBe('Review the three vendor proposals.');
  });

  it('respects fieldOrder for schema-defined ordering', () => {
    const result = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      fieldOrder: ['status', 'assignee', 'due_date', 'priority'],
    });
    const lines = result.split('\n');
    expect(lines[2]).toBe('types: [task]');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('assignee: "[[Bob Jones]]"');
    expect(lines[5]).toBe('due_date: 2025-03-10');
    expect(lines[6]).toBe('priority: high');
  });

  it('puts schema-ordered fields first, then remaining alphabetically', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: {
        status: 'todo',
        custom_note: 'extra info',
        assignee: '[[Alice]]',
        zebra: 'last',
      },
      fieldOrder: ['status', 'assignee'],
    });
    const lines = result.split('\n');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('assignee: "[[Alice]]"');
    expect(lines[5]).toBe('custom_note: extra info');
    expect(lines[6]).toBe('zebra: last');
  });

  it('skips fieldOrder entries not present in fields', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: { status: 'todo' },
      fieldOrder: ['status', 'assignee', 'priority'],
    });
    const lines = result.split('\n');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('---');
  });

  it('omits fields with null or undefined values', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: { status: 'todo', removed: null, also_gone: undefined },
    });
    expect(result).not.toContain('removed');
    expect(result).not.toContain('also_gone');
  });

  it('produces no blank line when body is absent', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
    });
    expect(result).toBe('---\ntitle: Test\ntypes: [note]\n---\n');
  });

  it('produces no blank line when body is empty string', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
      body: '',
    });
    expect(result).toBe('---\ntitle: Test\ntypes: [note]\n---\n');
  });

  it('ends with trailing newline', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
      body: 'Some content',
    });
    expect(result.endsWith('\n')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/node-to-file.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/serializer/node-to-file.ts
import { serializeFrontmatter, serializeValue } from './frontmatter.js';

export interface SerializeNodeOptions {
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  body?: string;
  fieldOrder?: string[];
}

export function serializeNode(opts: SerializeNodeOptions): string {
  const { title, types, fields, body, fieldOrder } = opts;

  // Build ordered entries: title first, types second
  const entries: Array<{ key: string; value: unknown }> = [
    { key: 'title', value: title },
    { key: 'types', value: types },
  ];

  // Collect field keys, filtering out null/undefined
  const fieldKeys = Object.keys(fields).filter(
    k => fields[k] !== null && fields[k] !== undefined,
  );

  const added = new Set<string>();

  // Schema-ordered fields first
  if (fieldOrder) {
    for (const key of fieldOrder) {
      if (fieldKeys.includes(key) && !added.has(key)) {
        entries.push({ key, value: fields[key] });
        added.add(key);
      }
    }
  }

  // Remaining fields alphabetically
  const remaining = fieldKeys.filter(k => !added.has(k)).sort();
  for (const key of remaining) {
    entries.push({ key, value: fields[key] });
  }

  // Assemble file
  const frontmatter = serializeFrontmatter(entries);
  let result = `---\n${frontmatter}---\n`;

  if (body && body.length > 0) {
    result += `\n${body}\n`;
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/node-to-file.test.ts`
Expected: All PASS

**Step 5: Commit**

```
git add src/serializer/node-to-file.ts tests/serializer/node-to-file.test.ts
git commit -m "add serializeNode for complete .md file assembly with field ordering"
```

---

### Task 4: `computeFieldOrder` — multi-type schema field ordering

**Files:**
- Modify: `src/serializer/node-to-file.ts`
- Modify: `tests/serializer/node-to-file.test.ts`

**Step 1: Write the failing tests**

Append to `tests/serializer/node-to-file.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/index.js';
import { resolve } from 'path';
import { beforeEach, afterEach } from 'vitest';
import { serializeNode, computeFieldOrder } from '../../src/serializer/node-to-file.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('computeFieldOrder', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('returns schema frontmatter_fields for single type', () => {
    const order = computeFieldOrder(['task'], db);
    expect(order).toEqual(['status', 'assignee', 'due_date', 'priority']);
  });

  it('returns empty array for unknown type', () => {
    const order = computeFieldOrder(['unknown'], db);
    expect(order).toEqual([]);
  });

  it('returns empty array for type with no serialization config', () => {
    // All fixture schemas have serialization, so test with empty types
    const order = computeFieldOrder([], db);
    expect(order).toEqual([]);
  });

  it('concatenates and deduplicates for multi-type nodes in alphabetical schema order', () => {
    // meeting: [date, attendees, project, status]
    // task: [status, assignee, due_date, priority]
    // alphabetical: meeting first, then task
    // deduplicated: status already seen from meeting
    const order = computeFieldOrder(['task', 'meeting'], db);
    expect(order).toEqual([
      'date', 'attendees', 'project', 'status',  // from meeting
      'assignee', 'due_date', 'priority',          // from task (status deduped)
    ]);
  });

  it('uses resolved schema (includes inherited fields) for ordering', () => {
    // work-task extends task, has its own frontmatter_fields
    const order = computeFieldOrder(['work-task'], db);
    expect(order).toEqual([
      'status', 'assignee', 'due_date', 'priority',
      'project', 'department', 'billable',
    ]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/node-to-file.test.ts`
Expected: FAIL — `computeFieldOrder` not found

**Step 3: Write minimal implementation**

Add to `src/serializer/node-to-file.ts`:

```typescript
import type Database from 'better-sqlite3';
import { getSchema } from '../schema/loader.js';

export function computeFieldOrder(
  types: string[],
  db: Database.Database,
): string[] {
  if (types.length === 0) return [];

  // Process schemas in alphabetical order for deterministic output
  const sortedTypes = [...types].sort();
  const seen = new Set<string>();
  const order: string[] = [];

  for (const typeName of sortedTypes) {
    const schema = getSchema(db, typeName);
    if (!schema?.serialization?.frontmatter_fields) continue;

    for (const field of schema.serialization.frontmatter_fields) {
      if (!seen.has(field)) {
        seen.add(field);
        order.push(field);
      }
    }
  }

  return order;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/node-to-file.test.ts`
Expected: All PASS

**Step 5: Commit**

```
git add src/serializer/node-to-file.ts tests/serializer/node-to-file.test.ts
git commit -m "add computeFieldOrder for multi-type schema field ordering"
```

---

### Task 5: `generateFilePath` — template resolution

**Files:**
- Create: `src/serializer/path.ts`
- Create: `tests/serializer/path.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/serializer/path.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/index.js';
import { resolve } from 'path';
import { generateFilePath } from '../../src/serializer/path.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('generateFilePath', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a simple title template', () => {
    const result = generateFilePath('Review proposal', ['task'], {}, db);
    expect(result).toBe('tasks/Review proposal.md');
  });

  it('resolves a date+title template', () => {
    const result = generateFilePath(
      'Q1 Planning',
      ['meeting'],
      { date: new Date('2025-03-06') },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Q1 Planning.md');
  });

  it('falls back to title.md when no schema exists', () => {
    const result = generateFilePath('Random note', ['unknown'], {}, db);
    expect(result).toBe('Random note.md');
  });

  it('falls back to title.md when schema has no filename_template', () => {
    // Load schemas without serialization config — simulate by using empty types
    const result = generateFilePath('Note', [], {}, db);
    expect(result).toBe('Note.md');
  });

  it('throws when a template variable is missing', () => {
    // meeting template requires {{date}} but we don't provide it
    expect(() => {
      generateFilePath('Q1 Planning', ['meeting'], {}, db);
    }).toThrow(/date/);
  });

  it('picks template from first schema alphabetically for multi-type', () => {
    // meeting (alphabetically before task) has template "meetings/{{date}}-{{title}}.md"
    const result = generateFilePath(
      'Sprint Review',
      ['task', 'meeting'],
      { date: new Date('2025-03-06') },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Sprint Review.md');
  });

  it('sanitizes unsafe filename characters', () => {
    const result = generateFilePath('What: Why? *How*', ['task'], {}, db);
    expect(result).toBe('tasks/What Why How.md');
    expect(result).not.toContain(':');
    expect(result).not.toContain('?');
    expect(result).not.toContain('*');
  });

  it('handles date fields passed as strings', () => {
    const result = generateFilePath(
      'Q1 Planning',
      ['meeting'],
      { date: '2025-03-06' },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Q1 Planning.md');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/path.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/serializer/path.ts
import type Database from 'better-sqlite3';
import { getSchema } from '../schema/loader.js';

const UNSAFE_CHARS_RE = /[\\:*?"<>|]/g;
const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g;

function formatTemplateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function sanitizeSegment(segment: string): string {
  return segment.replace(UNSAFE_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

export function generateFilePath(
  title: string,
  types: string[],
  fields: Record<string, unknown>,
  db: Database.Database,
): string {
  // Find first schema (alphabetically) with a filename_template
  let template: string | undefined;
  const sortedTypes = [...types].sort();

  for (const typeName of sortedTypes) {
    const schema = getSchema(db, typeName);
    if (schema?.serialization?.filename_template) {
      template = schema.serialization.filename_template;
      break;
    }
  }

  if (!template) {
    template = '{{title}}.md';
  }

  // Build variable lookup: title + all fields
  const vars: Record<string, string> = { title };
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) {
      vars[key] = formatTemplateValue(value);
    }
  }

  // Interpolate template variables
  const resolved = template.replace(TEMPLATE_VAR_RE, (match, varName: string) => {
    if (!(varName in vars)) {
      throw new Error(
        `filename_template variable '${varName}' has no value. ` +
        `Template: '${template}', available: [${Object.keys(vars).join(', ')}]`,
      );
    }
    return vars[varName];
  });

  // Sanitize each path segment individually (preserve directory separators)
  const segments = resolved.split('/');
  return segments.map(sanitizeSegment).join('/');
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/path.test.ts`
Expected: All PASS

**Step 5: Commit**

```
git add src/serializer/path.ts tests/serializer/path.test.ts
git commit -m "add generateFilePath for schema filename_template resolution"
```

---

### Task 6: Re-exports and round-trip integration test

**Files:**
- Create: `src/serializer/index.ts`
- Create: `tests/serializer/round-trip.test.ts`

**Step 1: Create the barrel export**

```typescript
// src/serializer/index.ts
export { serializeNode, computeFieldOrder } from './node-to-file.js';
export type { SerializeNodeOptions } from './node-to-file.js';
export { generateFilePath } from './path.js';
```

**Step 2: Write the round-trip integration test**

This test verifies that serialized output parses back to equivalent data through the existing parser pipeline.

```typescript
// tests/serializer/round-trip.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/index.js';
import { resolve } from 'path';
import { serializeNode, computeFieldOrder } from '../../src/serializer/index.js';
import { parseFile } from '../../src/parser/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('serializer round-trip', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a task node through serialize → parse', () => {
    const fieldOrder = computeFieldOrder(['task'], db);
    const md = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      body: 'Review the three vendor proposals.',
      fieldOrder,
    });

    const parsed = parseFile('tasks/Review proposal.md', md);

    expect(parsed.frontmatter.title).toBe('Review proposal');
    expect(parsed.types).toEqual(['task']);
    expect(parsed.fields.find(f => f.key === 'status')?.value).toBe('todo');
    expect(parsed.fields.find(f => f.key === 'assignee')?.value).toBe('[[Bob Jones]]');
    expect(parsed.fields.find(f => f.key === 'priority')?.value).toBe('high');
    expect(parsed.contentMd).toBe('Review the three vendor proposals.');
  });

  it('round-trips a meeting node with list references', () => {
    const fieldOrder = computeFieldOrder(['meeting'], db);
    const md = serializeNode({
      title: 'Q1 Planning Meeting',
      types: ['meeting'],
      fields: {
        date: new Date('2025-03-06'),
        attendees: ['[[Alice Smith]]', '[[Bob Jones]]'],
        project: '[[CenterPoint]]',
        status: 'scheduled',
      },
      body: 'Discuss Q1 roadmap.\n\n## Action Items\n\n- [[Alice Smith]] to prepare deck',
      fieldOrder,
    });

    const parsed = parseFile('meetings/q1.md', md);

    expect(parsed.frontmatter.title).toBe('Q1 Planning Meeting');
    expect(parsed.types).toEqual(['meeting']);
    expect(parsed.fields.find(f => f.key === 'attendees')?.value).toEqual([
      '[[Alice Smith]]',
      '[[Bob Jones]]',
    ]);
    expect(parsed.fields.find(f => f.key === 'project')?.value).toBe('[[CenterPoint]]');

    // Wiki-links from body should be extracted
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    expect(bodyLinks.some(l => l.target === 'Alice Smith')).toBe(true);
  });

  it('round-trips a node with no body', () => {
    const md = serializeNode({
      title: 'Simple Note',
      types: ['note'],
      fields: {},
    });

    const parsed = parseFile('Simple Note.md', md);
    expect(parsed.frontmatter.title).toBe('Simple Note');
    expect(parsed.types).toEqual(['note']);
    expect(parsed.contentMd).toBe('');
  });

  it('round-trips a person node with tags', () => {
    const fieldOrder = computeFieldOrder(['person'], db);
    const md = serializeNode({
      title: 'Alice Smith',
      types: ['person'],
      fields: {
        role: 'Engineering Manager',
        company: 'Acme Corp',
        email: 'alice@acme.com',
        tags: ['engineering', 'leadership'],
      },
      body: 'Key contact for the [[CenterPoint]] project.',
      fieldOrder,
    });

    const parsed = parseFile('people/Alice Smith.md', md);
    expect(parsed.fields.find(f => f.key === 'role')?.value).toBe('Engineering Manager');
    expect(parsed.fields.find(f => f.key === 'tags')?.value).toEqual([
      'engineering',
      'leadership',
    ]);
  });
});
```

**Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/round-trip.test.ts`
Expected: All PASS (no new implementation needed — this validates the full pipeline)

**Step 4: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: All PASS

**Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```
git add src/serializer/index.ts tests/serializer/round-trip.test.ts
git commit -m "add serializer re-exports and round-trip integration tests"
```
