# Remark Wiki-Link Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace regex-on-text-nodes wiki-link extraction with a remark transform plugin that produces first-class `wikiLink` AST nodes.

**Architecture:** A unified transform plugin walks the MDAST after parsing, finds `[[target]]` and `[[target|alias]]` in text nodes, and splits them into `text` / `wikiLink` / `text` node sequences. Consumers (`extractWikiLinksFromMdast`, `extractPlainText`) are updated to read from `wikiLink` nodes instead of applying regex. Frontmatter extraction is unchanged (regex on YAML strings).

**Tech Stack:** unified, remark-parse, remark-frontmatter, TypeScript, vitest

**Design doc:** `docs/plans/2026-03-07-remark-wiki-link-plugin-design.md`

---

## Critical Implementation Detail

`parseMarkdown` currently calls `processor.parse(raw)` which only runs the **parser phase** — transform plugins do NOT execute. After adding the wiki-link plugin, `parseMarkdown` must call `processor.runSync(tree)` to execute the transform:

```typescript
export function parseMarkdown(raw: string): Root {
  const tree = processor.parse(raw);
  return processor.runSync(tree) as Root;
}
```

This change is what makes `wikiLink` nodes appear in the MDAST. Without it, the plugin is registered but never runs.

---

### Task 1: Add WikiLinkNode type and mdast module augmentation

**Files:**
- Modify: `src/parser/types.ts`

**Step 1: Add WikiLinkNode interface and module augmentation**

Add below the existing `Position` re-export (after line 4):

```typescript
export interface WikiLinkNode {
  type: 'wikiLink';
  target: string;
  alias?: string;
  position?: Position;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLinkNode;
  }
}
```

This registers `wikiLink` as valid phrasing content in the mdast type system. Any node that accepts `PhrasingContent` children (paragraphs, headings, list items, emphasis, strong) will now accept `WikiLinkNode`.

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors — we added types, nothing uses them yet)

**Step 3: Commit**

```bash
git add src/parser/types.ts
git commit -m "add WikiLinkNode type and mdast module augmentation"
```

---

### Task 2: Create remark-wiki-link plugin with tests

The plugin is tested using a **local processor** (not the shared one in `markdown.ts`). This keeps the plugin isolated — existing tests remain passing because the shared pipeline hasn't changed yet.

**Files:**
- Create: `src/parser/remark-wiki-link.ts`
- Create: `tests/parser/remark-wiki-link.test.ts`

**Step 1: Write the failing tests**

Create `tests/parser/remark-wiki-link.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkWikiLink from '../../src/parser/remark-wiki-link.js';
import type { Root } from 'mdast';
import type { WikiLinkNode } from '../../src/parser/types.js';

function parse(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkWikiLink);
  return processor.runSync(processor.parse(md)) as Root;
}

/** Helper: collect all nodes of a given type from a tree */
function collectNodes<T>(node: any, type: string): T[] {
  const result: T[] = [];
  if (node.type === type) result.push(node as T);
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      result.push(...collectNodes<T>(child, type));
    }
  }
  return result;
}

describe('remarkWikiLink', () => {
  it('transforms [[target]] into a wikiLink node', () => {
    const tree = parse('Hello [[Alice]].');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice');
    expect(links[0].alias).toBeUndefined();
  });

  it('transforms [[target|alias]] preserving both properties', () => {
    const tree = parse('See [[Alice Smith|Alice]].');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice Smith');
    expect(links[0].alias).toBe('Alice');
  });

  it('splits surrounding text into separate text nodes', () => {
    const tree = parse('Hello [[Alice]] goodbye.');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(3);
    expect(para.children[0]).toMatchObject({ type: 'text', value: 'Hello ' });
    expect(para.children[1]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
    expect(para.children[2]).toMatchObject({ type: 'text', value: ' goodbye.' });
  });

  it('handles multiple wiki-links in one paragraph', () => {
    const tree = parse('Talk to [[Alice]] and [[Bob]] today.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe('Alice');
    expect(links[1].target).toBe('Bob');
  });

  it('handles wiki-link as entire paragraph text', () => {
    const tree = parse('[[Alice]]');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(1);
    expect(para.children[0]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
  });

  it('transforms wiki-links inside list items', () => {
    const tree = parse('- Talk to [[Alice]]\n- See [[Bob]]');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(2);
    expect(links.map(l => l.target)).toEqual(['Alice', 'Bob']);
  });

  it('transforms wiki-links inside headings', () => {
    const tree = parse('## Meeting with [[Alice]]');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice');
  });

  it('does NOT transform [[...]] inside fenced code blocks', () => {
    const tree = parse('```\n[[Alice]]\n```');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('does NOT transform [[...]] inside inline code', () => {
    const tree = parse('Use `[[Alice]]` syntax.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('does NOT transform [[...]] inside YAML frontmatter', () => {
    const tree = parse('---\nassignee: "[[Alice]]"\n---\n\nBody text.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('computes position with correct offset for wikiLink nodes', () => {
    const md = 'Hi [[Alice]].';
    const tree = parse(md);
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links[0].position).toBeDefined();
    expect(links[0].position!.start.offset).toBe(3); // "Hi " = 3 chars
    expect(links[0].position!.end.offset).toBe(12);  // "Hi [[Alice]]" = 12 chars
  });

  it('drops empty text fragments when wiki-link is at start or end', () => {
    const tree = parse('[[Alice]] said hello');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(2);
    expect(para.children[0]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
    expect(para.children[1]).toMatchObject({ type: 'text', value: ' said hello' });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/remark-wiki-link.test.ts`
Expected: FAIL (module `../../src/parser/remark-wiki-link.js` not found)

**Step 3: Implement the plugin**

Create `src/parser/remark-wiki-link.ts`:

```typescript
import type { Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import type { WikiLinkNode } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const remarkWikiLink: Plugin<[], Root> = () => (tree: Root) => {
  transformChildren(tree);
};

function transformChildren(node: any): void {
  if (!node.children || !Array.isArray(node.children)) return;
  if (node.type === 'yaml') return;

  let changed = false;
  const newChildren: any[] = [];

  for (const child of node.children) {
    if (child.type === 'text' && WIKI_LINK_RE.test(child.value)) {
      newChildren.push(...splitTextNode(child));
      changed = true;
    } else {
      newChildren.push(child);
    }
  }

  if (changed) {
    node.children = newChildren;
  }

  for (const child of node.children) {
    transformChildren(child);
  }
}

function splitTextNode(node: Text): (Text | WikiLinkNode)[] {
  const result: (Text | WikiLinkNode)[] = [];
  const text = node.value;
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(makeText(text.slice(lastIndex, match.index), node, lastIndex));
    }

    const wikiLink: WikiLinkNode = {
      type: 'wikiLink',
      target: match[1].trim(),
    };
    const alias = match[2]?.trim();
    if (alias) wikiLink.alias = alias;

    if (node.position && node.position.start.offset != null) {
      const startOffset = node.position.start.offset + match.index;
      const endOffset = startOffset + match[0].length;
      wikiLink.position = {
        start: {
          line: node.position.start.line,
          column: node.position.start.column + match.index,
          offset: startOffset,
        },
        end: {
          line: node.position.start.line,
          column: node.position.start.column + match.index + match[0].length,
          offset: endOffset,
        },
      };
    }

    result.push(wikiLink);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(makeText(text.slice(lastIndex), node, lastIndex));
  }

  return result;
}

function makeText(value: string, parent: Text, offsetInParent: number): Text {
  const node: Text = { type: 'text', value };
  if (parent.position && parent.position.start.offset != null) {
    const startOffset = parent.position.start.offset + offsetInParent;
    node.position = {
      start: {
        line: parent.position.start.line,
        column: parent.position.start.column + offsetInParent,
        offset: startOffset,
      },
      end: {
        line: parent.position.start.line,
        column: parent.position.start.column + offsetInParent + value.length,
        offset: startOffset + value.length,
      },
    };
  }
  return node;
}

export default remarkWikiLink;
```

**Note on position line/column:** The `line` and `column` values are computed assuming the wiki-link is on the same line as the text node's start. This is correct for the vast majority of wiki-links (which don't span lines). The `offset` is always accurate. If multi-line accuracy is needed later, the function can scan for newlines — but that's premature for now.

**Note on `WIKI_LINK_RE.test()` resetting:** The `test()` call in `transformChildren` advances `lastIndex` on the shared regex. We avoid this bug by using `new RegExp(...)` for the actual extraction in `splitTextNode`. The `test()` in `transformChildren` is on a module-level regex with `g` flag, which WILL have `lastIndex` side effects. Fix: reset it or use a non-`g` regex for the test. Simplest fix — use a separate non-`g` regex for the test:

Replace line in `transformChildren`:
```typescript
if (child.type === 'text' && WIKI_LINK_RE.test(child.value)) {
```
With:
```typescript
if (child.type === 'text' && child.value.includes('[[')) {
```

This is cheaper than regex and has no `lastIndex` issue. The `includes('[[')` check is a fast-path guard — the actual regex runs in `splitTextNode`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/remark-wiki-link.test.ts`
Expected: PASS (all 12 tests)

**Step 5: Run existing tests to verify no regressions**

Run: `npm test`
Expected: PASS (all existing tests still pass because the shared pipeline in `markdown.ts` hasn't changed)

**Step 6: Commit**

```bash
git add src/parser/remark-wiki-link.ts tests/parser/remark-wiki-link.test.ts
git commit -m "add remark-wiki-link transform plugin with tests

Splits [[target]] and [[target|alias]] in text nodes into first-class
wikiLink AST nodes. Tested in isolation; not yet wired into shared pipeline."
```

---

### Task 3: Integrate plugin and update all consumers

This task wires the plugin into the shared pipeline and updates every consumer in one atomic change. After this task, `wikiLink` nodes flow through the entire parser pipeline.

**Files:**
- Modify: `src/parser/markdown.ts`
- Modify: `src/parser/wiki-links.ts`
- Modify: `tests/parser/wiki-links.test.ts`
- Modify: `tests/parser/markdown.test.ts` (minor — verify it still passes)

**Step 1: Update `src/parser/markdown.ts`**

Full replacement:

```typescript
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkWikiLink from './remark-wiki-link.js';
import type { Root } from 'mdast';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkWikiLink);

export function parseMarkdown(raw: string): Root {
  const tree = processor.parse(raw);
  return processor.runSync(tree) as Root;
}

export function extractPlainText(mdast: Root): string {
  const parts: string[] = [];
  collectText(mdast, parts);
  return parts.join('\n').trim();
}

function collectText(node: any, parts: string[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(node.value);
    return;
  }

  if (node.type === 'wikiLink') {
    parts.push(node.alias ?? node.target);
    return;
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectText(child, parts);
    }
  }
}
```

Key changes from the original:
- Import and `.use(remarkWikiLink)` added to pipeline
- `parseMarkdown` now calls `processor.runSync(tree)` to execute transforms
- `collectText` handles `wikiLink` nodes directly (emits `alias ?? target`)
- `stripWikiLinks` import removed — no longer needed

**Step 2: Update `src/parser/wiki-links.ts`**

Full replacement:

```typescript
import type { Root } from 'mdast';
import type { WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface RawWikiLink {
  target: string;
  alias?: string;
}

export function extractWikiLinksFromString(text: string): RawWikiLink[] {
  const links: RawWikiLink[] = [];
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    links.push({
      target: match[1].trim(),
      alias: match[2]?.trim(),
    });
  }
  return links;
}

export function extractWikiLinksFromMdast(mdast: Root): WikiLink[] {
  const links: WikiLink[] = [];
  visitForLinks(mdast, links, undefined);
  return links;
}

function visitForLinks(node: any, links: WikiLink[], parent: any | undefined): void {
  if (node.type === 'wikiLink') {
    links.push({
      target: node.target,
      alias: node.alias,
      source: 'body',
      context: parent ? buildContext(parent) : undefined,
      position: node.position,
    });
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      visitForLinks(child, links, node);
    }
  }
}

function buildContext(parent: any): string {
  if (!parent.children || !Array.isArray(parent.children)) return '';
  return parent.children
    .map((child: any) => {
      if (child.type === 'text') return child.value;
      if (child.type === 'wikiLink') return child.alias ?? child.target;
      return '';
    })
    .join('');
}
```

Key changes from the original:
- `extractWikiLinksFromMdast` walks `wikiLink` nodes (not text nodes with regex)
- `visitForLinks` passes parent for context building
- `buildContext` reconstructs surrounding sentence from sibling text/wikiLink nodes
- `stripWikiLinks` removed entirely
- `extractWikiLinksFromString` unchanged (frontmatter path)

**Step 3: Update `tests/parser/wiki-links.test.ts`**

Full replacement:

```typescript
import { describe, it, expect } from 'vitest';
import { extractWikiLinksFromString, extractWikiLinksFromMdast } from '../../src/parser/wiki-links.js';
import type { Root } from 'mdast';

describe('extractWikiLinksFromString', () => {
  it('extracts a simple wiki-link', () => {
    const result = extractWikiLinksFromString('[[Bob Jones]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: undefined }]);
  });

  it('extracts a wiki-link with alias', () => {
    const result = extractWikiLinksFromString('[[Bob Jones|Bob]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: 'Bob' }]);
  });

  it('extracts multiple wiki-links from one string', () => {
    const result = extractWikiLinksFromString('Talk to [[Alice]] and [[Bob]]');
    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('Alice');
    expect(result[1].target).toBe('Bob');
  });

  it('returns empty array for no links', () => {
    const result = extractWikiLinksFromString('no links here');
    expect(result).toEqual([]);
  });

  it('handles wiki-links in array values', () => {
    const values = ['[[Alice Smith]]', '[[Bob Jones]]'];
    const results = values.flatMap(v => extractWikiLinksFromString(v));
    expect(results).toHaveLength(2);
    expect(results[0].target).toBe('Alice Smith');
    expect(results[1].target).toBe('Bob Jones');
  });
});

describe('extractWikiLinksFromMdast', () => {
  it('extracts wiki-links from wikiLink nodes with context', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Read proposal from ' },
            {
              type: 'wikiLink',
              target: 'Acme Corp',
              position: {
                start: { line: 5, column: 20, offset: 59 },
                end: { line: 5, column: 33, offset: 72 },
              },
            } as any,
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('Acme Corp');
    expect(result[0].source).toBe('body');
    expect(result[0].context).toBe('Read proposal from Acme Corp');
    expect(result[0].position).toBeDefined();
  });

  it('extracts multiple wiki-links from multiple paragraphs', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'wikiLink', target: 'Alice' } as any,
            { type: 'text', value: ' and ' },
            { type: 'wikiLink', target: 'Bob' } as any,
          ],
        },
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'wikiLink', target: 'Charlie' } as any,
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result).toHaveLength(3);
    expect(result.map(l => l.target)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('builds context from sibling nodes in parent', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Talk to ' },
            { type: 'wikiLink', target: 'Alice', alias: 'A' } as any,
            { type: 'text', value: ' and ' },
            { type: 'wikiLink', target: 'Bob' } as any,
            { type: 'text', value: ' today.' },
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result[0].context).toBe('Talk to A and Bob today.');
    expect(result[1].context).toBe('Talk to A and Bob today.');
  });
});
```

Key changes:
- `extractWikiLinksFromMdast` tests now construct MDAST with `wikiLink` nodes (post-transform shape)
- `stripWikiLinks` tests removed entirely
- Context test added to verify `buildContext` from parent sibling nodes

**Step 4: Run all tests**

Run: `npm test`
Expected: PASS (all tests across all files)

If `tests/parser/markdown.test.ts` or `tests/parser/parse-file.test.ts` fail, debug by checking:
- `extractPlainText` still strips `[[` from output (the `wikiLink` node handler emits plain target/alias)
- `extractWikiLinksFromMdast` still finds all body links (walks `wikiLink` nodes)
- `parseFile` still combines frontmatter + body links correctly

**Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parser/markdown.ts src/parser/wiki-links.ts tests/parser/wiki-links.test.ts
git commit -m "integrate remark-wiki-link into parser pipeline

Wire plugin into shared processor, update extractPlainText and
extractWikiLinksFromMdast to consume wikiLink AST nodes, remove
stripWikiLinks. All existing tests pass with identical external behavior."
```

---

### Task 4: Update architecture docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the parser pipeline section in CLAUDE.md**

In the parser pipeline description, update the wiki-links module description to reflect the new architecture:

- `remark-wiki-link.ts` — Custom remark transform plugin. Splits `[[target]]` and `[[target|alias]]` in text nodes into `wikiLink` AST nodes. Runs after remarkParse + remarkFrontmatter.
- `wiki-links.ts` — `extractWikiLinksFromMdast` walks `wikiLink` AST nodes (not regex on text). `extractWikiLinksFromString` provides regex extraction for frontmatter values.
- `markdown.ts` — unified pipeline now includes remarkWikiLink. `parseMarkdown` calls `runSync` to execute transforms. `extractPlainText` handles `wikiLink` nodes directly.

Also update the `parseFile` flow diagram:

```
parseFile(filePath, raw)
  ├── parseMarkdown(raw)         → MDAST with wikiLink nodes (unified/remark + remarkFrontmatter + remarkWikiLink)
  ├── parseFrontmatter(raw)      → { data, content, types, fields, wikiLinks }  (gray-matter + regex)
  ├── extractWikiLinksFromMdast() → body wiki-links from wikiLink AST nodes
  └── extractPlainText()         → plain text for FTS (reads wikiLink node target/alias)
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "update CLAUDE.md for remark-wiki-link plugin architecture"
```

---

## Copy the revised architecture doc into the project

After all tasks complete, copy `~/Downloads/vault-engine-architecture.md` over the existing `vault-engine-architecture.md` so the project has the updated version with the "Wiki-Link Parsing: Two Strategies by Context" section.

```bash
cp ~/Downloads/vault-engine-architecture.md vault-engine-architecture.md
git add vault-engine-architecture.md
git commit -m "update architecture doc with wiki-link two-strategy section"
```
