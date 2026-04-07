// vault-engine entry point
import 'dotenv/config';
import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';
import { incrementalIndex, watchVault } from './sync/index.js';
import { loadEnforcementConfig } from './enforcement/index.js';
import { loadGlobalFields } from './coercion/globals.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable, createProvider, startEmbeddingWorker } from './embeddings/index.js';
import type { EmbeddingConfig } from './embeddings/types.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { validateAuthEnv } from './auth/env.js';

const args = parseArgs(process.argv.slice(2));
const dbPath = args.dbPath ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = args.vaultPath ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

// Load enforcement and global field config for normalize-on-index
const enforcementConfig = loadEnforcementConfig(vaultPath);
const globalFields = loadGlobalFields(vaultPath);
const skipNormalize = process.env.VAULT_ENGINE_SKIP_NORMALIZE === '1';

if (skipNormalize) {
  console.error('[vault-engine] normalize-on-index: disabled via VAULT_ENGINE_SKIP_NORMALIZE');
}

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
const indexResult = incrementalIndex(db, vaultPath, {
  enforcementConfig,
  globalFields,
  skipNormalize,
});
console.error(`[vault-engine] indexed ${indexResult.indexed}, skipped ${indexResult.skipped}, deleted ${indexResult.deleted}, normalized ${indexResult.normalized}`);
if (indexResult.normalized > 0) {
  console.error(`[vault-engine] normalize-on-index: fixed ${indexResult.normalized} file(s)`);
}

// Start file watcher for live re-indexing of external changes
const watcher = watchVault(db, vaultPath, {
  enforcementConfig,
  globalFields,
  skipNormalize,
  onSchemaChange: () => loadSchemas(db, vaultPath),
});
await watcher.ready;
console.error('[vault-engine] file watcher started');

const serverFactory = () => createServer(db, vaultPath, embeddingConfig ? { embeddingConfig } : undefined);

if (args.transport === 'stdio' || args.transport === 'both') {
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  const authEnv = validateAuthEnv(process.env.OAUTH_OWNER_PASSWORD, process.env.OAUTH_ISSUER_URL);
  createAuthSchema(db);
  await startHttpTransport(serverFactory, args.port, {
    db,
    ownerPassword: authEnv.ownerPassword,
    issuerUrl: authEnv.issuerUrl,
  });
}
