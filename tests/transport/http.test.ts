import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { createHttpApp } from '../../src/transport/http.js';

// MCP Streamable HTTP spec requires Accept header with both types
const MCP_ACCEPT = 'application/json, text/event-stream';

describe('HTTP transport', () => {
  let db: Database.Database;
  let app: Express;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    app = createHttpApp(() => createServer(db, '/tmp/test-vault'));
  });

  afterEach(() => {
    db.close();
  });

  it('rejects POST /mcp without valid JSON-RPC body', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({});
    // The transport itself handles validation — non-initialize requests
    // without a session ID get 400
    expect([400, 500]).toContain(res.status);
  });

  it('initializes a session via POST /mcp', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    // Call tools/list
    const toolRes = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
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
      .set('Accept', MCP_ACCEPT)
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
