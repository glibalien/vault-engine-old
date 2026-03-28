import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createSchema } from '../../src/db/schema.js';
import { createAuthSchema } from '../../src/auth/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { createHttpApp } from '../../src/transport/http.js';
import type { Express } from 'express';

const TEST_PASSWORD = 'flow-test-password';
const ISSUER_URL = new URL('https://vault.example.com');
const REDIRECT_URI = 'https://example.com/callback';
const MCP_ACCEPT = 'application/json, text/event-stream';

// PKCE helpers
function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function generateCodeVerifier(): string {
  return base64url(Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

describe('Full OAuth 2.1 flow', () => {
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

  it('completes register → authorize → token → MCP request → refresh → revoke flow', async () => {
    // Step 1: Register client via DCR
    const regRes = await request(app)
      .post('/register')
      .send({
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        client_name: 'Integration Test Client',
      });
    expect(regRes.status).toBe(201);
    const { client_id, client_secret } = regRes.body;
    expect(client_id).toBeDefined();

    // Step 2: Generate PKCE pair
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Step 3: Authorize with password (POST form)
    const authRes = await request(app)
      .post('/authorize')
      .type('form')
      .send({
        client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'my-state',
        password: TEST_PASSWORD,
      });
    expect(authRes.status).toBe(302);
    const redirectUrl = new URL(authRes.headers.location);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeDefined();
    expect(redirectUrl.searchParams.get('state')).toBe('my-state');

    // Step 4: Exchange code for tokens
    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id,
        client_secret,
        code_verifier: codeVerifier,
      });
    expect(tokenRes.status).toBe(200);
    const { access_token, refresh_token } = tokenRes.body;
    expect(access_token).toBeDefined();
    expect(refresh_token).toBeDefined();

    // Step 5: Make authenticated MCP request
    const mcpRes = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${access_token}`)
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
    expect(mcpRes.status).toBe(200);

    // Step 6: Refresh token
    const refreshRes = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token,
        client_id,
        client_secret,
      });
    expect(refreshRes.status).toBe(200);
    const newAccessToken = refreshRes.body.access_token;
    const newRefreshToken = refreshRes.body.refresh_token;
    expect(newAccessToken).toBeDefined();
    expect(newRefreshToken).toBeDefined();

    // Step 7: Revoke token
    const revokeRes = await request(app)
      .post('/revoke')
      .type('form')
      .send({
        token: newAccessToken,
        client_id,
        client_secret,
      });
    expect(revokeRes.status).toBe(200);

    // Step 8: Revoked token should fail
    const failRes = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${newAccessToken}`)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      });
    expect(failRes.status).toBe(401);
  });
});
