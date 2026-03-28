# `summarize-node` Tool Spec

**Type:** MCP Tool (workflow layer)
**Depends on:** `get-node`, `read-embedded` (both exist)
**Category:** Phase 6 workflow tool

## Purpose

Content assembly tool that reads a node and all its embedded attachments, returning everything as a single unified response. The calling model (Claude, Fireworks, etc.) receives all content in one shot and handles summarization, action item extraction, or any other processing itself.

This eliminates the multi-step tool chain that currently fails with weaker models: `get-node` → notice embeds → `read-embedded` → synthesize. `summarize-node` collapses that into one call.

## Tool Interface

```typescript
tool("summarize-node", {
  description: "Read a node and all its embedded content (audio transcriptions, PDFs, images, documents), returning everything assembled as text. Use this when asked to summarize, review, or analyze a note — especially meeting notes with audio recordings. The tool handles all content extraction; the calling model does the summarization. Also accepts a title instead of a full file path.",
  params: {
    node_id: z.string().optional()
      .describe("Vault-relative file path, e.g. 'Meetings/Q1 Planning.md'"),
    title: z.string().optional()
      .describe("Node title for lookup, e.g. 'Q1 Planning'. Resolved via the same title→path logic as wiki-link resolution. Use this when you know the name but not the directory."),
  }
});
```

**Validation:** At least one of `node_id` or `title` must be provided. If both are provided, `node_id` takes precedence. If `title` is provided without `node_id`, resolve it to a node ID using the existing `resolveTarget(db, title)` function from reference resolution.

## Internal Pipeline

```
1. Resolve node
   ├── node_id provided → use directly
   └── title provided → resolveTarget(db, title) → node_id
       └── not found → return error: "No node found with title '...'"
       └── ambiguous → return error with candidates

2. Read node via get-node internals (parseFile or DB lookup)
   → Extract: title, types, fields, markdown body

3. Parse body for embeds
   → Find all ![[filename]] patterns (reuse existing embed detection from read-embedded)
   → Categorize by type: audio, image, document, unknown

4. For each embed, call read-embedded internals
   → Audio: Fireworks Whisper → transcript text
   → Images: base64 image content blocks (vision-capable models can see these)
   → Documents (PDF, docx, txt): extracted text
   → Unknown/missing: skip with a note in the summary header

5. Assemble and return
```

## Return Format

Array of MCP content blocks. The first block is always a text summary header, followed by the node's own content, followed by extracted embed content.

```
[
  { type: "text", text: "## Node: Q1 Planning Meeting\n**Types:** meeting\n**Fields:** date: 2026-03-27, attendees: [[Alice]], [[Bob]]\n\n**Embedded content found:** 1 audio file (transcribed), 1 image, 1 PDF\n---" },

  { type: "text", text: "## Node Content\n\n<the node's markdown body as-is>" },

  { type: "text", text: "## Audio: Recording 20260327.m4a\n\n<full Whisper transcript with diarization>" },

  { type: "image", data: "<base64>", mimeType: "image/png" },
  { type: "text", text: "## Image: whiteboard-photo.png\n(image returned above)" },

  { type: "text", text: "## Document: proposal.pdf\n\n<extracted text content>" }
]
```

### Key formatting decisions:

- **Header block** includes node metadata (title, types, fields) and an inventory of what was found. This gives the calling model immediate context.
- **Node body** is returned as-is (markdown). The calling model can parse it.
- **Audio transcripts** are returned as text with `## Audio: filename` headers.
- **Images** are returned as MCP image content blocks so vision-capable models can see them, plus a text label block.
- **Documents** are returned as extracted text with `## Document: filename` headers.
- Each embedded item is clearly delineated so the calling model can distinguish between the node's own content and embedded content.

## Title Resolution (also benefits `get-node`)

The `title` parameter uses `resolveTarget(db, title)` — the same function that resolves `[[wiki-links]]` to node IDs during indexing. This means:

- Case-insensitive matching
- Shortest unique path match (Obsidian convention)
- If multiple nodes share the same title, return an error listing the candidates so the model can disambiguate

**Recommendation:** Also add this `title` parameter to `get-node` itself. Same resolution logic, same benefit: models don't need to know directory structure to look up a node by name. This is a small change — add an optional `title` param, resolve before the DB lookup, done.

## Implementation Notes

### File location

`src/mcp/server.ts` — register alongside existing tools. The tool's internal logic can live in a helper function (e.g., `assembleNodeContent()` in a new file or alongside the `read-embedded` handler) that calls existing functions:

- `resolveTarget(db, title)` from `src/sync/indexer.ts` or `src/db/relationships.ts` (wherever it lives)
- `parseFile()` or a DB read for the node content
- The embed resolution + content extraction logic already in `read-embedded`

### Shared internals with `read-embedded`

`summarize-node` should call the same internal functions that `read-embedded` uses — not the MCP tool entry point, but the underlying logic (find embeds, resolve paths, extract content by type). This is the same pattern as `add-relationship` wrapping `update-node` internals.

If `read-embedded`'s logic isn't already extracted into a reusable function, refactor it:

```
read-embedded (MCP tool) → calls assembleEmbeds(vaultPath, nodeId, filterType)
summarize-node (MCP tool) → also calls assembleEmbeds(vaultPath, nodeId, "all")
```

### Error handling

- Node not found (by ID or title): return error message, not a crash
- Embed file missing from disk: include a note in the output (`"## Audio: recording.m4a\n\n⚠️ File not found on disk"`), continue processing other embeds
- Whisper API failure: include error in output, continue with other embeds
- No embeds found: still works — returns the node content with a header noting "No embedded content found"

## What This Tool Does NOT Do

- **No LLM summarization.** The tool assembles content; the calling model summarizes.
- **No write-back.** The tool does not append summaries to the node. The calling model can do that via `update-node` if the user asks.
- **No transclusion.** `![[other-note.md]]` embeds that reference other markdown files are not expanded. Those are transclusions (a separate concern), not attachments.

## CC Prompt

Here's a starting prompt for Claude Code:

---

**New MCP tool: `summarize-node` — content assembly for a node and all its embeds.**

This is a workflow tool that reads a node and all its `![[embedded]]` attachments, returning everything assembled as MCP content blocks. The calling model handles summarization — this tool just does content extraction and assembly.

**Params:**
- `node_id` (optional string): vault-relative file path
- `title` (optional string): node title, resolved via `resolveTarget()` — same logic as wiki-link resolution. At least one required.

**Pipeline:**
1. Resolve node: if `title` provided, use `resolveTarget(db, title)` to find the node ID. Error if not found or ambiguous.
2. Read the node content (title, types, fields, markdown body)
3. Parse body for `![[embed]]` patterns — reuse the detection logic from `read-embedded`
4. For each embed, extract content using the same internals as `read-embedded`:
   - Audio → Whisper transcription (already implemented)
   - Images → base64 image content blocks (already implemented)
   - Documents → text extraction (already implemented)
5. Return assembled MCP content blocks: a summary header with metadata + inventory, the node's markdown body, then each embed's extracted content with clear `## Type: filename` headers

**Key constraint:** Extract `read-embedded`'s embed resolution and content extraction into a shared internal function (e.g., `assembleEmbeds()`) that both tools can call. Don't duplicate the Whisper/image/document logic.

**Also:** Add an optional `title` param to `get-node` using the same `resolveTarget()` lookup, so models can look up nodes by name without knowing directory structure.

Register in `src/mcp/server.ts` alongside existing tools.

---
