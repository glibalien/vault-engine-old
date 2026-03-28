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

  describe('challengeForAuthorizationCode', () => {
    it('returns stored code challenge', async () => {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
        VALUES ('test-code', 'test-client-id', 'https://example.com/callback', 'stored-challenge', '', NULL, NULL, ?, ?)
      `).run(now, now + 600);

      const challenge = await provider.challengeForAuthorizationCode(makeClient(), 'test-code');
      expect(challenge).toBe('stored-challenge');
    });

    it('throws on unknown code', async () => {
      await expect(
        provider.challengeForAuthorizationCode(makeClient(), 'nonexistent'),
      ).rejects.toThrow();
    });

    it('throws on expired code', async () => {
      const past = Math.floor(Date.now() / 1000) - 1000;
      db.prepare(`
        INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
        VALUES ('expired-code', 'test-client-id', 'https://example.com/callback', 'challenge', '', NULL, NULL, ?, ?)
      `).run(past - 600, past);

      await expect(
        provider.challengeForAuthorizationCode(makeClient(), 'expired-code'),
      ).rejects.toThrow();
    });
  });

  describe('exchangeAuthorizationCode', () => {
    function insertCode(overrides?: Partial<{ code: string; client_id: string; redirect_uri: string; expires_at: number }>) {
      const now = Math.floor(Date.now() / 1000);
      const defaults = {
        code: 'valid-code',
        client_id: 'test-client-id',
        redirect_uri: 'https://example.com/callback',
        expires_at: now + 600,
      };
      const vals = { ...defaults, ...overrides };
      db.prepare(`
        INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
        VALUES (?, ?, ?, 'challenge', '', NULL, 'state', ?, ?)
      `).run(vals.code, vals.client_id, vals.redirect_uri, now, vals.expires_at);
    }

    it('returns access and refresh tokens', async () => {
      insertCode();
      const tokens = await provider.exchangeAuthorizationCode(
        makeClient(), 'valid-code', undefined, 'https://example.com/callback',
      );

      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.expires_in).toBe(3600);
    });

    it('deletes code after use (single-use)', async () => {
      insertCode();
      await provider.exchangeAuthorizationCode(
        makeClient(), 'valid-code', undefined, 'https://example.com/callback',
      );

      const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get('valid-code');
      expect(row).toBeUndefined();
    });

    it('stores tokens as hashes in database', async () => {
      insertCode();
      const tokens = await provider.exchangeAuthorizationCode(
        makeClient(), 'valid-code', undefined, 'https://example.com/callback',
      );

      // The raw token should NOT be in the database
      const accessRow = db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(tokens.access_token);
      expect(accessRow).toBeUndefined();

      // The hash should be in the database
      const { hashToken } = await import('../../src/auth/provider.js');
      const hashRow = db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(hashToken(tokens.access_token));
      expect(hashRow).toBeDefined();
    });

    it('rejects expired code', async () => {
      const past = Math.floor(Date.now() / 1000) - 1000;
      insertCode({ expires_at: past });

      await expect(
        provider.exchangeAuthorizationCode(makeClient(), 'valid-code', undefined, 'https://example.com/callback'),
      ).rejects.toThrow();
    });

    it('rejects code for wrong client', async () => {
      insertCode({ client_id: 'other-client' });

      await expect(
        provider.exchangeAuthorizationCode(makeClient(), 'valid-code', undefined, 'https://example.com/callback'),
      ).rejects.toThrow();
    });

    it('rejects code with wrong redirect_uri', async () => {
      insertCode();

      await expect(
        provider.exchangeAuthorizationCode(makeClient(), 'valid-code', undefined, 'https://evil.com/steal'),
      ).rejects.toThrow();
    });
  });
});
