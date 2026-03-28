import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createAuthSchema } from '../../src/auth/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { createHttpApp } from '../../src/transport/http.js';

const TEST_PASSWORD = 'integration-test-password';
const ISSUER_URL = new URL('https://vault.example.com');
const MCP_ACCEPT = 'application/json, text/event-stream';

describe('HTTP transport with auth', () => {
  let db: Database.Database;
  let app: Express;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    createAuthSchema(db);
    app = createHttpApp(() => createServer(db, '/tmp/test-vault'), {
      db,
      ownerPassword: TEST_PASSWORD,
      issuerUrl: ISSUER_URL,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('rejects unauthenticated POST /mcp with 401', async () => {
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
    expect(res.status).toBe(401);
  });

  it('HEAD /mcp remains accessible without auth', async () => {
    const res = await request(app).head('/mcp');
    expect(res.status).toBe(200);
    expect(res.headers['mcp-protocol-version']).toBe('2025-03-26');
  });

  it('sessionless GET /mcp remains accessible without auth', async () => {
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(200);
    expect(res.headers['mcp-protocol-version']).toBe('2025-03-26');
  });

  it('serves OAuth metadata at /.well-known/oauth-authorization-server', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER_URL.href);
    expect(res.body.authorization_endpoint).toBeDefined();
    expect(res.body.token_endpoint).toBeDefined();
    expect(res.body.registration_endpoint).toBeDefined();
  });

  it('GET /authorize returns HTML form', async () => {
    // First register a client
    const regRes = await request(app)
      .post('/register')
      .send({
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        client_name: 'Test Client',
      });
    expect(regRes.status).toBe(201);
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: clientId,
        redirect_uri: 'https://example.com/callback',
        response_type: 'code',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
        state: 'test-state',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form');
    expect(res.text).toContain('name="password"');
  });
});
