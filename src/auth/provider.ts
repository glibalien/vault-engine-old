import type Database from 'better-sqlite3';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { SqliteClientsStore } from './store.js';

export const ACCESS_TOKEN_TTL = 3600;       // 1 hour
export const REFRESH_TOKEN_TTL = 2592000;   // 30 days
const AUTH_CODE_TTL = 600;                  // 10 minutes

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifyPassword(input: string, expected: string): boolean {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuthForm(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  error?: string,
): string {
  const clientName = client.client_name ?? client.client_id;
  const scope = params.scopes?.join(' ') ?? '';
  return `<!DOCTYPE html>
<html>
<head><title>Authorize - vault-engine</title></head>
<body>
  <h1>Authorize</h1>
  <p>Client <strong>${escapeHtml(clientName)}</strong> (${escapeHtml(client.client_id)}) is requesting access.</p>
  ${error ? `<p style="color:red">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="response_type" value="code">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="S256">
    ${params.state ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}">` : ''}
    ${scope ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ''}
    ${params.resource ? `<input type="hidden" name="resource" value="${escapeHtml(params.resource.toString())}">` : ''}
    <label>Password: <input type="password" name="password" required autofocus></label>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

// Row type interfaces used by later tasks
interface CodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  state: string | null;
  created_at: number;
  expires_at: number;
}

interface TokenRow {
  token: string;
  type: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  created_at: number;
  expires_at: number;
  revoked: number;
}

export class VaultOAuthProvider implements OAuthServerProvider {
  private readonly store: SqliteClientsStore;

  constructor(
    private readonly db: Database.Database,
    private readonly ownerPassword: string,
    private readonly issuerUrl: URL,
  ) {
    this.store = new SqliteClientsStore(db);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.store;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const password = (res.req as { body?: Record<string, string> })?.body?.password;

    if (!password) {
      res.type('html').send(renderAuthForm(client, params));
      return;
    }

    if (!verifyPassword(password, this.ownerPassword)) {
      res.type('html').send(renderAuthForm(client, params, 'Invalid password'));
      return;
    }

    const code = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      params.scopes?.join(' ') ?? '',
      params.resource?.toString() ?? null,
      params.state ?? null,
      now,
      now + AUTH_CODE_TTL,
    );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(redirectUrl.toString());
  }

  // Stubs -- implemented in Tasks 4 and 5
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string,
  ): Promise<string> {
    throw new Error('Not implemented');
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    throw new Error('Not implemented');
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    throw new Error('Not implemented');
  }

  async verifyAccessToken(_token: string): Promise<AuthInfo> {
    throw new Error('Not implemented');
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    throw new Error('Not implemented');
  }
}
