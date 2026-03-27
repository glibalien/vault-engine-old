# read-embedded Tool Design

## Overview

New MCP tool that reads a vault node, finds all `![[filename]]` embeds in its markdown body, resolves them to filesystem paths, and returns their content based on MIME type. Images are returned as base64, audio is transcribed via Fireworks Whisper API, and documents are extracted as text.

## Architecture

### New Module: `src/attachments/`

```
src/attachments/
  types.ts        — AttachmentType enum, ResolvedEmbed, ReadResult interfaces
  resolver.ts     — Parse embeds from markdown, resolve to filesystem paths
  readers.ts      — Type-branched content extraction (image/audio/document)
  index.ts        — Re-exports
```

### Modified Files

- `src/mcp/server.ts` — New `read-embedded` tool registration
- `src/index.ts` — Add `import 'dotenv/config'` as first import
- `.gitignore` — Add `.env`
- `package.json` — Add `openai`, `mammoth`, `pdf-parse`, `dotenv` dependencies

### New Files

- `.env.example` — Template with `FIREWORKS_API_KEY=your-key-here`

## Embed Resolution

### Parsing Embeds

Regex on raw markdown content: `![[filename]]` patterns via `/!\[\[([^\]]+)\]\]/g`.

- Strip optional size suffix (e.g., `![[photo.png|400]]` → `photo.png`)
- Skip `.md` file embeds (those are transclusions, not attachments)
- The remark-wiki-link plugin doesn't handle `!` prefix, so embeds are NOT in the AST as distinct nodes — regex is the correct approach here

### Path Resolution Order

For each embed filename, try in order (first match wins):

1. `{vaultPath}/Attachments/{filename}`
2. `{vaultPath}/{filename}` (vault root)
3. `{sourceNodeDir}/{filename}` (same directory as the source note)
4. Recursive search: walk `vaultPath` for a file matching the basename, skipping `node_modules/`, `.vault-engine/`, `.git/`

The recursive search is the slow path — only triggered when the three fast lookups miss. Uses `fs.readdirSync` with `{ recursive: true }` (Node 20+) filtered to the target basename.

Unresolved embeds are reported in the summary text block but don't cause tool errors.

### File Type Classification by Extension

| Type | Extensions |
|------|-----------|
| Image | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg` |
| Audio | `m4a`, `mp3`, `wav`, `ogg`, `webm` |
| Document | `pdf`, `docx`, `txt`, `md` |

Unknown extensions are skipped with a note in the summary.

## Content Readers

### Images (`png, jpg, jpeg, gif, webp, svg`)

- Read file with `fs.readFileSync`
- Raster formats: return MCP image content block `{ type: "image", data: base64string, mimeType: "image/png" }`
- SVG: return as text content block (base64 image blocks are for raster formats)

### Audio (`m4a, mp3, wav, ogg, webm`)

- Check `process.env.FIREWORKS_API_KEY` at call time — if missing, return text block: `"FIREWORKS_API_KEY not set — cannot transcribe audio files"`
- Create OpenAI client: `new OpenAI({ apiKey: process.env.FIREWORKS_API_KEY, baseURL: "https://api.fireworks.ai/inference/v1" })`
- Call `client.audio.transcriptions.create()`:
  - `model: "whisper-v3"`
  - `file: fs.createReadStream(path)`
  - `response_format: "verbose_json"`
  - `timestamp_granularities: ["word", "segment"]`
  - `extra_body: { diarize: true }`
- Format diarized response: merge consecutive segments from same speaker, format as:
  ```
  **Speaker N** (M:SS - M:SS)
  transcribed text

  **Speaker M** (M:SS - M:SS)
  transcribed text
  ```
- Fall back to `response.text` if no segments returned
- Timestamp formatting: `M:SS` or `H:MM:SS` for segments over an hour

### Documents

- **PDF:** `pdf-parse` — read file buffer, extract text via `pdf(buffer)`
- **DOCX:** `mammoth.extractRawText({ path })` — returns plain text
- **TXT/MD:** `fs.readFileSync(path, 'utf-8')`

### Error Handling

Each reader catches errors per-file. One bad attachment doesn't kill the whole request — the failure is reported as a text block and counted in the summary.

## MCP Tool Interface

### Registration

```typescript
server.tool(
  'read-embedded',
  'Read and return embedded attachments (![[file]]) from a vault note. Images returned as base64, audio transcribed via Whisper, documents as extracted text.',
  {
    node_id: z.string().min(1).describe('Vault-relative file path of the node to read embeds from'),
    filter_type: z.enum(['all', 'audio', 'image', 'document']).optional().default('all')
      .describe('Filter to specific attachment types'),
  },
  async (params) => { ... }
)
```

### Handler Flow

1. Look up node in DB — return `toolError("Node not found: ...", "NOT_FOUND")` if missing
2. Read raw markdown from disk via `fs.readFileSync`
3. Parse embeds via regex
4. Filter by `filter_type` if not `'all'`
5. Resolve paths using the 4-step resolution order
6. Read content via type-branched readers
7. Return array of MCP content blocks

### Return Format

- **First block:** text summary — e.g., `"Found 2 images, 1 audio file (transcribed), 1 PDF. 1 embed could not be resolved."`
- **Subsequent blocks:** one per resolved attachment:
  - Images: `{ type: "image", data: base64string, mimeType: "image/..." }`
  - Audio transcripts: `{ type: "text", text: "--- recording.m4a ---\n{transcript}" }`
  - Documents: `{ type: "text", text: "--- document.pdf ---\n{extracted text}" }`

### Error Cases

| Condition | Response |
|-----------|----------|
| Node not in DB | `toolError("Node not found: ...", "NOT_FOUND")` |
| Node file missing from disk | `toolError("File not found on disk: ...", "NOT_FOUND")` |
| No embeds found | Success with summary: `"No embedded attachments found in ..."` |
| Individual attachment failure | Error text block per failed file, counted in summary |
| `FIREWORKS_API_KEY` not set | Text block error per audio file: `"FIREWORKS_API_KEY not set — cannot transcribe audio files"` |

## Environment Configuration

- **API key:** `process.env.FIREWORKS_API_KEY` — read at tool call time, not at startup
- **dotenv:** `import 'dotenv/config'` as first import in `src/index.ts`
- **`.env.example`:** Template with `FIREWORKS_API_KEY=your-key-here`
- **`.gitignore`:** Add `.env` entry

The server starts and works for all non-audio tools without the Fireworks API key. Audio transcription fails gracefully with a clear error message when the key is missing.

## Dependencies

| Package | Purpose |
|---------|---------|
| `openai` | Fireworks Whisper API (OpenAI-compatible endpoint) |
| `mammoth` | DOCX text extraction |
| `pdf-parse` | PDF text extraction |
| `dotenv` | Load `.env` into `process.env` |

## Testing Strategy

- **Unit tests for resolver:** embed regex parsing, path resolution with mock filesystem
- **Unit tests for readers:** each file type branch with fixture files
- **Unit tests for diarization formatting:** segment merging, timestamp formatting
- **Integration test for MCP tool:** round-trip with a fixture vault containing embeds
- **Error case tests:** missing API key, unresolvable embeds, corrupt files
