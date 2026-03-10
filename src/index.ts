// vault-engine entry point
import { resolve, dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = process.argv[3] ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

const server = createServer(db, vaultPath);
const transport = new StdioServerTransport();
await server.connect(transport);
