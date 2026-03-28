import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Response } from 'express';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../../src/auth/schema.js';
import { VaultOAuthProvider } from '../../src/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

const TEST_PASSWORD = 'test-password-123';
const ISSUER_URL = new URL('https://vault.example.com');

function makeClient(): OAuthClientInformationFull {
  return {
    client_id: 'test-client-id',
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret: 'test-secret',
    redirect_uris: [new URL('https://example.com/callback')],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    client_name: 'Test Client',
  };
}

function makeParams(overrides?: Partial<AuthorizationParams>): AuthorizationParams {
  return {
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'test-challenge-abc123',
    state: 'test-state-xyz',
    scopes: [],
    ...overrides,
  };
}

function mockResponse(body?: Record<string, string>): Response {
  return {
    req: { body: body ?? {} },
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
    redirect: vi.fn(),
  } as unknown as Response;
}

describe('VaultOAuthProvider', () => {
  let db: Database.Database;
  let provider: VaultOAuthProvider;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createAuthSchema(db);
    provider = new VaultOAuthProvider(db, TEST_PASSWORD, ISSUER_URL);
  });

  afterEach(() => {
    db.close();
  });

  describe('authorize', () => {
    it('renders HTML form when no password in body', async () => {
      const res = mockResponse();
      await provider.authorize(makeClient(), makeParams(), res);

      expect(res.type).toHaveBeenCalledWith('html');
      expect(res.send).toHaveBeenCalled();
      const html = (res.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(html).toContain('<form');
      expect(html).toContain('name="password"');
      expect(html).toContain('test-client-id');
    });

    it('re-renders form with error on wrong password', async () => {
      const res = mockResponse({ password: 'wrong-password' });
      await provider.authorize(makeClient(), makeParams(), res);

      expect(res.type).toHaveBeenCalledWith('html');
      const html = (res.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(html).toContain('Invalid password');
    });

    it('redirects with code on correct password', async () => {
      const res = mockResponse({ password: TEST_PASSWORD });
      await provider.authorize(makeClient(), makeParams(), res);

      expect(res.redirect).toHaveBeenCalled();
      const redirectUrl = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(redirectUrl.origin).toBe('https://example.com');
      expect(redirectUrl.pathname).toBe('/callback');
      expect(redirectUrl.searchParams.get('code')).toBeDefined();
      expect(redirectUrl.searchParams.get('state')).toBe('test-state-xyz');
    });

    it('stores authorization code in database', async () => {
      const res = mockResponse({ password: TEST_PASSWORD });
      await provider.authorize(makeClient(), makeParams(), res);

      const rows = db.prepare('SELECT * FROM oauth_codes').all();
      expect(rows).toHaveLength(1);
    });
  });
});
