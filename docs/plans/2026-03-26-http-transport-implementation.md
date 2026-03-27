# HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Streamable HTTP transport so remote MCP clients can connect to vault-engine over HTTP alongside existing stdio transport.

**Architecture:** New `src/transport/` module with Express-based HTTP server that manages per-session `StreamableHTTPServerTransport` instances. CLI flag parsing in `src/index.ts` selects stdio, http, or both. One `McpServer` shared across all transports/sessions.

**Tech Stack:** Express, `@modelcontextprotocol/sdk` StreamableHTTPServerTransport, supertest (testing), `StreamableHTTPClientTransport` (integration testing)

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install express and supertest**

```bash
npm install express && npm install -D @types/express supertest @types/supertest
```

- [ ] **Step 2: Verify install succeeded**

```bash
npx tsc --noEmit
```

Expected: No new type errors (express types are dev-only, not imported in src yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add express and supertest dependencies for HTTP transport"
```

---

### Task 2: CLI Argument Parsing in `src/index.ts`

**Files:**
- Modify: `src/index.ts`
- Test: `tests/transport/args.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transport/args.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/transport/args.js';

describe('parseArgs', () => {
  it('returns defaults with no args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'stdio',
      port: 3333,
    });
  });

  it('parses positional dbPath and vaultPath', () => {
    const result = parseArgs(['/tmp/vault.db', '/tmp/vault']);
    expect(result).toEqual({
      dbPath: '/tmp/vault.db',
      vaultPath: '/tmp/vault',
      transport: 'stdio',
      port: 3333,
    });
  });

  it('parses --transport http', () => {
    const result = parseArgs(['--transport', 'http']);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'http',
      port: 3333,
    });
  });

  it('parses --transport both --port 4000', () => {
    const result = parseArgs(['--transport', 'both', '--port', '4000']);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'both',
      port: 4000,
    });
  });

  it('parses positional args mixed with flags', () => {
    const result = parseArgs(['/tmp/vault.db', '/tmp/vault', '--transport', 'http', '--port', '5000']);
    expect(result).toEqual({
      dbPath: '/tmp/vault.db',
      vaultPath: '/tmp/vault',
      transport: 'http',
      port: 5000,
    });
  });

  it('rejects invalid transport value', () => {
    expect(() => parseArgs(['--transport', 'websocket'])).toThrow('Invalid --transport value');
  });

  it('rejects non-numeric port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow('Invalid --port value');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/transport/args.test.ts
```

Expected: FAIL — module `../../src/transport/args.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/transport/args.ts`:

```typescript
export interface ParsedArgs {
  dbPath: string | undefined;
  vaultPath: string | undefined;
  transport: 'stdio' | 'http' | 'both';
  port: number;
}

const VALID_TRANSPORTS = new Set(['stdio', 'http', 'both']);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    dbPath: undefined,
    vaultPath: undefined,
    transport: 'stdio',
    port: 3333,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transport') {
      const value = argv[++i];
      if (!VALID_TRANSPORTS.has(value)) {
        throw new Error(`Invalid --transport value: "${value}". Must be stdio, http, or both.`);
      }
      result.transport = value as ParsedArgs['transport'];
    } else if (arg === '--port') {
      const value = argv[++i];
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`Invalid --port value: "${value}". Must be a positive number.`);
      }
      result.port = num;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) result.dbPath = positional[0];
  if (positional.length >= 2) result.vaultPath = positional[1];

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/transport/args.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/args.ts tests/transport/args.test.ts
git commit -m "feat: add CLI argument parser for transport flags"
```

---

### Task 3: HTTP Transport Module

**Files:**
- Create: `src/transport/http.ts`
- Create: `src/transport/index.ts`
- Test: `tests/transport/http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transport/http.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { createHttpApp } from '../../src/transport/http.js';

describe('HTTP transport', () => {
  let db: Database.Database;
  let mcpServer: McpServer;
  let app: Express;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    mcpServer = createServer(db, '/tmp/test-vault');
    app = createHttpApp(mcpServer);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects POST /mcp without valid JSON-RPC body', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({});
    // The transport itself handles validation — non-initialize requests
    // without a session ID get 400
    expect([400, 500]).toContain(res.status);
  });

  it('initializes a session via POST /mcp', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeDefined();
  });

  it('returns 404 for unknown session ID', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('mcp-session-id', 'nonexistent-session')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });
    expect(res.status).toBe(404);
  });

  it('routes subsequent requests to correct session', async () => {
    // Initialize
    const initRes = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      });
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();

    // Send initialized notification
    await request(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    // Call list-types tool
    const toolRes = await request(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
    expect(toolRes.status).toBe(200);
  });

  it('cleans up session on DELETE /mcp', async () => {
    // Initialize
    const initRes = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      });
    const sessionId = initRes.headers['mcp-session-id'];

    // Delete session
    const delRes = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', sessionId);
    expect(delRes.status).toBe(200);

    // Verify session is gone
    const afterRes = await request(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
    expect(afterRes.status).toBe(404);
  });

  it('logs requests to stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      });

    const logged = stderrSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('POST /mcp'),
    );
    expect(logged).toBe(true);

    stderrSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/transport/http.test.ts
```

Expected: FAIL — module `../../src/transport/http.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/transport/http.ts`:

```typescript
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    process.stderr.write(`[vault-engine] ${req.method} ${req.path} ${res.statusCode} ${duration}ms\n`);
  });
  next();
}

export function createHttpApp(server: McpServer): Express {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();

  app.use(express.json());
  app.use(requestLogger);

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session ID — create new transport for initialization
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
    await transport.close();
  });

  return app;
}

export async function startHttpTransport(
  server: McpServer,
  port: number,
): Promise<Express> {
  const app = createHttpApp(server);

  return new Promise((resolve) => {
    app.listen(port, () => {
      process.stderr.write(`[vault-engine] HTTP listening on http://localhost:${port}/mcp\n`);
      resolve(app);
    });
  });
}
```

Note: `sessions` is module-level. `createHttpApp` shares the map via closure. `startHttpTransport` calls `createHttpApp` and starts listening. Tests use `createHttpApp` directly (no listen needed — supertest handles that).

- [ ] **Step 4: Create the index re-export**

Create `src/transport/index.ts`:

```typescript
export { createHttpApp, startHttpTransport } from './http.js';
export { parseArgs } from './args.js';
export type { ParsedArgs } from './args.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/transport/http.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
npm test
```

Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/transport/http.ts src/transport/index.ts tests/transport/http.test.ts
git commit -m "feat: add HTTP transport with Express and session management"
```

---

### Task 4: Wire Transport Selection into Entry Point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts` to use `parseArgs` and branch on transport mode**

Replace the full contents of `src/index.ts` with:

```typescript
// vault-engine entry point
import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';
import { incrementalIndex } from './sync/index.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable, createProvider, startEmbeddingWorker } from './embeddings/index.js';
import type { EmbeddingConfig } from './embeddings/types.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';

const args = parseArgs(process.argv.slice(2));

const dbPath = args.dbPath ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = args.vaultPath ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

// Load embedding config from .vault-engine/config.json if it exists
let embeddingConfig: EmbeddingConfig | undefined;
const configPath = join(dirname(dbPath), 'config.json');
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.embeddings) {
      embeddingConfig = config.embeddings as EmbeddingConfig;
    }
  } catch {
    console.error('[vault-engine] failed to read config.json');
  }
}

// Set up sqlite-vec and embedding worker if configured
if (embeddingConfig) {
  loadVecExtension(db);
  const provider = createProvider(embeddingConfig);

  // Handle dimension mismatch
  const existingDims = getVecDimensions(db);
  if (existingDims !== null && existingDims !== provider.dimensions) {
    console.error(`[vault-engine] embedding dimensions changed (${existingDims} → ${provider.dimensions}), rebuilding vec table`);
    dropVecTable(db);
    // Re-queue all chunks
    db.transaction(() => {
      db.prepare('DELETE FROM embedding_queue').run();
      const chunks = db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>;
      const insertQueue = db.prepare('INSERT INTO embedding_queue (chunk_id) VALUES (?)');
      for (const chunk of chunks) {
        insertQueue.run(chunk.id);
      }
    })();
  }

  createVecTable(db, provider.dimensions);
  startEmbeddingWorker(db, provider, { batchSize: embeddingConfig.batchSize });
}

// Index vault on startup (incremental — fast if DB already populated)
const indexResult = incrementalIndex(db, vaultPath);
console.error(`[vault-engine] indexed ${indexResult.indexed}, skipped ${indexResult.skipped}, deleted ${indexResult.deleted}`);

const server = createServer(db, vaultPath, embeddingConfig ? { embeddingConfig } : undefined);

// Start transport(s)
if (args.transport === 'stdio' || args.transport === 'both') {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  await startHttpTransport(server, args.port);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass (entry point not tested directly — it's the startup script).

- [ ] **Step 4: Add `start:http` convenience script to `package.json`**

Add to `"scripts"` in `package.json`:

```json
"start:http": "node dist/index.js --transport http"
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat: wire transport selection into entry point with --transport flag"
```

---

### Task 5: Integration Test — Full Round-Trip via HTTP

**Files:**
- Create: `tests/transport/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/transport/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createHttpApp } from '../../src/transport/http.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('HTTP transport integration', () => {
  let db: Database.Database;
  let httpServer: Server;
  let client: Client;
  let port: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const mcpServer = createServer(db, '/tmp/test-vault');
    const app = createHttpApp(mcpServer);

    // Start on random available port
    port = await new Promise<number>((resolve) => {
      httpServer = createHttpServer(app);
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // Connect MCP client via Streamable HTTP
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    client = new Client({ name: 'integration-test', version: '0.1.0' });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
  });

  it('lists tools via HTTP transport', async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain('list-types');
    expect(toolNames).toContain('query-nodes');
  });

  it('calls list-types tool and gets results', async () => {
    indexFixture(db, 'sample-task.md', 'tasks/review.md');
    indexFixture(db, 'sample-person.md', 'people/alice.md');

    const result = await client.callTool({ name: 'list-types', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const typeNames = data.map((t: { type: string }) => t.type);
    expect(typeNames).toContain('task');
    expect(typeNames).toContain('person');
  });

  it('calls query-nodes with full_text search', async () => {
    indexFixture(db, 'sample-task.md', 'tasks/review.md');

    const result = await client.callTool({
      name: 'query-nodes',
      arguments: { full_text: 'review' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
npx vitest run tests/transport/integration.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass, including new transport tests.

- [ ] **Step 4: Commit**

```bash
git add tests/transport/integration.test.ts
git commit -m "test: add HTTP transport integration tests with MCP client round-trip"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to the `## Commands` section, after the existing entries:

```markdown
npm run start:http     # start with HTTP transport on port 3333
node dist/index.js --transport http --port 3333  # HTTP only
node dist/index.js --transport both --port 3333  # stdio + HTTP
```

Add a new subsection under `## Architecture`:

```markdown
### Transport Layer (`src/transport/`)

CLI argument parsing and HTTP transport setup.

- **`args.ts`** — `parseArgs(argv)` extracts `--transport` (stdio|http|both, default stdio) and `--port` (default 3333) flags plus positional dbPath/vaultPath.
- **`http.ts`** — `createHttpApp(server)` creates an Express app with POST/GET/DELETE `/mcp` routes. Per-session `StreamableHTTPServerTransport` instances stored in a `Map`. `startHttpTransport(server, port)` calls `createHttpApp` and starts listening. Logs to stderr.
- **`index.ts`** — Re-exports `createHttpApp`, `startHttpTransport`, `parseArgs`.
```

- [ ] **Step 2: Verify no type errors**

```bash
npx tsc --noEmit
```

Expected: Clean.

- [ ] **Step 3: Run full test suite one last time**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with HTTP transport architecture and commands"
```
