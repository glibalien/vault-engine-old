# Design: Custom Remark Wiki-Link Plugin

**Date:** 2026-03-07
**Status:** Approved

## Problem

The current parser extracts wiki-links from body content by applying regex to MDAST `text` nodes at read time. The architecture requires wiki-links to be first-class AST nodes so that write-path operations (rename refactoring, node merging) can safely transform them via parse-walk-transform-serialize rather than fragile regex find-and-replace on raw strings.

## Two-Strategy Rule (from architecture doc)

- **Body content:** Wiki-links become `wikiLink` AST nodes via a remark plugin
- **Frontmatter values:** Wiki-links extracted via regex on parsed YAML strings (unchanged)

## Approach: MDAST Transform Plugin

A unified plugin that runs after `remark-parse` builds the MDAST. Walks text nodes, finds `[[...]]` via regex, splits each text node into alternating `text` / `wikiLink` / `text` children.

Chosen over a micromark syntax extension because:
- ~50-60 lines vs ~100-120 for micromark
- Same MDAST output shape
- No micromark state machine complexity
- No new dependencies

## WikiLinkNode Shape

```typescript
interface WikiLinkNode {
  type: 'wikiLink';
  target: string;       // "Alice Smith"
  alias?: string;       // "Alice" (from [[Alice Smith|Alice]])
  position?: Position;  // computed from parent text node offset
}
```

`target` and `alias` are distinct properties so the future serializer is trivial:
```typescript
`[[${node.target}${node.alias ? `|${node.alias}` : ''}]]`
```

TypeScript module augmentation on `mdast` registers `WikiLinkNode` as valid phrasing content.

## Transform Behavior

Given a text node `"Talk to [[Alice]] about the budget"`, the plugin produces:

```
paragraph
  text "Talk to "
  wikiLink { target: "Alice" }
  text " about the budget"
```

**Position computation:** Each `wikiLink` and surrounding text fragment gets a position derived from the parent text node's start offset plus the match index. If the parent has no position, positions are omitted.

**Edge cases:**
- Text node with no wiki-links: left untouched
- Text node that IS a wiki-link with no surrounding text: single `wikiLink` node
- Multiple wiki-links in one text node: alternating sequence, empty text fragments dropped

**Untouched contexts:** `yaml` nodes are skipped (frontmatter handled separately). `code` and `inlineCode` nodes don't have text children, so they're naturally safe.

## Impact on Existing Modules

### `src/parser/remark-wiki-link.ts` (new)
The plugin. Unified attacher returning a transformer.

### `src/parser/markdown.ts`
- Add `.use(remarkWikiLink)` to pipeline after `remarkFrontmatter`
- `extractPlainText`: add case for `wikiLink` nodes — emit `node.alias ?? node.target`

### `src/parser/wiki-links.ts`
- `extractWikiLinksFromMdast`: rewrite to walk `wikiLink` nodes instead of regex on text nodes
- `extractWikiLinksFromString`: unchanged (frontmatter path)
- `stripWikiLinks`: removed (no longer needed)
- Context for body links: built by walking parent paragraph's children (text values + wikiLink targets) instead of regex stripping

### `src/parser/types.ts`
- Add `WikiLinkNode` interface
- Add mdast module augmentation

### No changes to:
- `src/parser/frontmatter.ts`
- `src/parser/index.ts`

## Test Plan

### New: `tests/parser/remark-wiki-link.test.ts`
Parse raw markdown through full pipeline, assert MDAST shape:
- Simple `[[target]]` — wikiLink node, no alias
- `[[target|alias]]` — both properties
- Multiple wiki-links in one paragraph
- Wiki-link as entire paragraph text
- Wiki-link inside list item and heading
- `[[...]]` inside fenced code block — no wikiLink node
- `[[...]]` inside inline code — no wikiLink node
- `[[...]]` inside YAML frontmatter — not transformed
- Position accuracy

### Updated: `tests/parser/wiki-links.test.ts`
- `extractWikiLinksFromString` tests: unchanged
- `extractWikiLinksFromMdast` tests: rewritten for `wikiLink` node input
- `stripWikiLinks` tests: removed

### Unchanged: `tests/parser/parse-file.test.ts`
Integration tests verify same external contract (WikiLink[], contentText). Should pass without changes if refactor is correct.

## Scope

**In scope (Phase 1):** Parsing plugin only. Produces `wikiLink` AST nodes for reading/indexing.

**Deferred to Phase 3:** `mdast-to-markdown` serialization extension for `remark-stringify`. The node shape is designed to make this trivial when needed.
