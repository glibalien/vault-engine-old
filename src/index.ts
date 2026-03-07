// vault-engine entry point
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');

const db = openDatabase(dbPath);
createSchema(db);

const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
