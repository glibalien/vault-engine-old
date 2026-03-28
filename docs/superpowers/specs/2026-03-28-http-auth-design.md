# HTTP Authentication Design: OAuth 2.1 for MCP

## Summary

Add OAuth 2.1 authentication to the HTTP transport, implementing the MCP auth spec for claude.ai integration. Single-user system behind a persistent Cloudflare tunnel. Static bearer token path deferred (YAGNI — OAuth is the only consumer for now).

Addresses [glibalien/vault-engine#3](https://github.com/glibalien/vault-engine/issues/3).

## Context

- HTTP transport (`src/transport/http.ts`) is fully implemented with Express, session management, and logging — but zero authentication
- The endpoint is behind a persistent Cloudflare tunnel (publicly routable)
- claude.ai expects OAuth 2.1 with Dynamic Client Registration per the MCP auth spec
- MCP SDK v1.27.1 provides a complete server-side OAuth framework: `mcpAuthRouter()`, handler functions, bearer auth middleware, PKCE validation, rate limiting, and error handling
- We implement two interfaces (`OAuthServerProvider`, `OAuthRegisteredClientsStore`) and the SDK handles the rest

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth mechanism | OAuth 2.1 only | Only consumer is claude.ai; static bearer token deferred |
| Resource owner auth | Static password (`OAUTH_OWNER_PASSWORD` env var) | Single-user system; simple and effective |
| Token storage | SQLite (same DB) | Survives restarts; avoids re-auth friction; `better-sqlite3` already available |
| Client registration | Open DCR | Registration alone doesn't grant access; password gate is the security boundary |
| Token format | Opaque (`crypto.randomBytes`) | Single-server; simpler than JWT; immediately revocable via DB |
| Token DB storage | SHA-256 hashed | If DB leaks, raw bearer tokens not exposed. Client secrets stored plaintext (SDK constraint; high-entropy, not passwords) |
| Access token lifetime | 1 hour | Standard; short enough to limit leaked-token exposure |
| Refresh token lifetime | 30 days | Convenience for single user; rotation on each use |
| Rate limiting on /authorize | 5 per minute per IP | Brute-force protection for password |
| SDK integration | `mcpAuthRouter()` | All-in-one router; protocol-compliant by construction |
| Auth scope | HTTP transport only | Stdio is local IPC, no auth needed |

## Architecture

### New Module: `src/auth/`

```
src/auth/
  schema.ts    — DDL for 3 auth tables
  store.ts     — SqliteClientsStore (OAuthRegisteredClientsStore)
  provider.ts  — VaultOAuthProvider (OAuthServerProvider)
  index.ts     — re-exports
```

### Integration Points

- `src/transport/http.ts` — installs `mcpAuthRouter()` before MCP routes; wraps `/mcp` with `requireBearerAuth()`
- `src/index.ts` — validates env vars at startup (HTTP mode only), creates auth schema, passes auth config through to HTTP transport

### Request Flow

```
Client                    Express                         VaultOAuthProvider         SQLite
  |                          |                                   |                      |
  |-- POST /register ------->|                                   |                      |
  |                          |-- SDK handler ---- registerClient -->                     |
  |                          |                                   |-- INSERT client ----->|
  |<-- 201 {client_id} ------|                                   |                      |
  |                          |                                   |                      |
  |-- GET /authorize ------->|                                   |                      |
  |                          |-- SDK handler ---- authorize() --->|                      |
  |<-- 200 HTML form --------|                                   |                      |
  |                          |                                   |                      |
  |-- POST /authorize ------>|  (password + OAuth params)        |                      |
  |                          |-- SDK handler ---- authorize() --->|                      |
  |                          |                                   |-- validate password   |
  |                          |                                   |-- INSERT code ------->|
  |<-- 302 redirect?code= --|                                   |                      |
  |                          |                                   |                      |
  |-- POST /token ---------->|  (code + code_verifier)           |                      |
  |                          |-- SDK handler                     |                      |
  |                          |   |- challengeForAuthorizationCode -> SELECT code ------->|
  |                          |   |- PKCE validation (SDK)        |                      |
  |                          |   |- exchangeAuthorizationCode --->|                      |
  |                          |                                   |-- DELETE code ------->|
  |                          |                                   |-- INSERT tokens ----->|
  |<-- 200 {access_token} ---|                                   |                      |
  |                          |                                   |                      |
  |-- POST /mcp ------------>|                                   |                      |
  |    Authorization: Bearer |-- requireBearerAuth middleware     |                      |
  |                          |   |- verifyAccessToken ---------->|-- SELECT token ------>|
  |                          |   |- sets req.auth                |                      |
  |                          |-- MCP handler (existing) -------->|                      |
  |<-- 200 MCP response -----|                                   |                      |
```

## SQLite Schema

### `oauth_clients`

Registered OAuth clients from Dynamic Client Registration.

| Column | Type | Notes |
|---|---|---|
| `client_id` | TEXT PK | UUID generated by SDK's registration handler |
| `client_id_issued_at` | INTEGER | Unix timestamp |
| `client_secret` | TEXT | Plaintext; nullable for public clients (see note below) |
| `client_secret_expires_at` | INTEGER | Unix timestamp; nullable |
| `metadata` | TEXT | Full `OAuthClientMetadata` JSON blob (redirect_uris, grant_types, token_endpoint_auth_method, etc.) |

**Why client secrets are not hashed:** The SDK's `authenticateClient` middleware calls `getClient()` and directly compares the stored secret against the incoming request's secret. Hashing on storage would break this comparison. Client secrets are high-entropy random values (not human-chosen passwords) with no reuse risk. The real security boundary is bearer tokens, which are hashed.

### `oauth_codes`

Authorization codes. Short-lived, single-use.

| Column | Type | Notes |
|---|---|---|
| `code` | TEXT PK | Random UUID |
| `client_id` | TEXT FK → oauth_clients | |
| `redirect_uri` | TEXT | |
| `code_challenge` | TEXT | PKCE S256 challenge |
| `scopes` | TEXT | Space-separated |
| `resource` | TEXT | RFC 8707; nullable |
| `state` | TEXT | Echoed back in redirect |
| `created_at` | INTEGER | Unix timestamp |
| `expires_at` | INTEGER | `created_at + 600` (10 minutes) |

### `oauth_tokens`

Access and refresh tokens. Stored as SHA-256 hashes.

| Column | Type | Notes |
|---|---|---|
| `token` | TEXT PK | SHA-256 hash of opaque token value |
| `type` | TEXT | `'access'` or `'refresh'` |
| `client_id` | TEXT FK → oauth_clients | |
| `scopes` | TEXT | Space-separated |
| `resource` | TEXT | RFC 8707; nullable |
| `created_at` | INTEGER | Unix timestamp |
| `expires_at` | INTEGER | Unix timestamp (access: +3600, refresh: +2592000) |
| `revoked` | INTEGER | 0 or 1; default 0 |

All token queries filter on `expires_at > :now AND revoked = 0`.

No periodic cleanup needed for single-user system — expired/revoked rows are harmless.

## VaultOAuthProvider

Implements `OAuthServerProvider` from `@modelcontextprotocol/sdk/server/auth/provider.js`.

### Constructor

```typescript
constructor(db: Database, ownerPassword: string, issuerUrl: URL)
```

Creates `SqliteClientsStore` internally. Stores password for comparison during authorize flow.

### `authorize(client, params, res)`

Two-step flow — the SDK's `authorizationHandler` calls this on both GET and POST:

1. **No password in body (initial visit):** Render a minimal HTML page with password field, client name, requested scopes, and all OAuth params as hidden fields. Form POSTs back to `/authorize`.
2. **Password in body (form submission):** Validate via constant-time comparison (`crypto.timingSafeEqual` on SHA-256 hashes of both values — normalizes length). On success: generate code (`crypto.randomUUID()`), store in `oauth_codes` with 10-minute expiry, redirect to `redirect_uri` with `code` and `state` params. On failure: re-render form with error message.

### `challengeForAuthorizationCode(client, code)`

Look up code in `oauth_codes`, return stored `code_challenge`. SDK uses this for PKCE S256 validation. Throws if code not found or expired.

### `exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource)`

Validate: code exists, not expired, matches client_id and redirect_uri. Delete code from DB (single-use). Generate access token (1hr) + refresh token (30 days) via `crypto.randomBytes(32).toString('hex')`. Store SHA-256 hashes in `oauth_tokens`. Return `OAuthTokens` with plaintext tokens.

### `exchangeRefreshToken(client, refreshToken, scopes, resource)`

Validate: refresh token exists (by hash), not expired, not revoked, matches client_id. Revoke old refresh token. Issue new access token + new refresh token (token rotation). Return `OAuthTokens`.

### `verifyAccessToken(token)`

Hash incoming token, look up in `oauth_tokens` where `type = 'access'`, not expired, not revoked. Return `AuthInfo { token, clientId, scopes, expiresAt }`.

### `revokeToken(client, request)`

Hash the token. Mark `revoked = 1`. If revoking a refresh token, also revoke all access tokens for that client (cascade revocation).

## SqliteClientsStore

Implements `OAuthRegisteredClientsStore` from `@modelcontextprotocol/sdk/server/auth/clients.js`.

### `getClient(clientId)`

Look up by PK. Reconstruct `OAuthClientInformationFull` from stored columns + parsed `metadata` JSON. Return `undefined` if not found.

### `registerClient(client)`

The SDK's type signature is `Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>` — the handler generates the `client_secret` but the *store* must generate `client_id` (UUID) and `client_id_issued_at` (now). Store client_secret as-is and metadata as JSON blob. Return full `OAuthClientInformationFull`.

## Integration with HTTP Transport

### `createHttpApp` signature change

```typescript
createHttpApp(serverFactory, authConfig?: { db: Database, ownerPassword: string, issuerUrl: URL })
```

When `authConfig` is provided:

1. Create `VaultOAuthProvider` instance
2. Install `mcpAuthRouter({ provider, issuerUrl, authorizationOptions: { rateLimit: { windowMs: 60000, max: 5 } } })`
3. Wrap all `/mcp` route handlers with `requireBearerAuth({ verifier: provider })`

When `authConfig` is undefined (shouldn't happen for HTTP, but defensive): MCP routes remain unprotected (preserves existing behavior for tests).

### `HEAD /mcp`

Remains unauthenticated. Returns `MCP-Protocol-Version` header for protocol discovery. Clients need this before they've completed the OAuth flow.

### `startHttpTransport` signature change

```typescript
startHttpTransport(serverFactory, port, authConfig?: { db: Database, ownerPassword: string, issuerUrl: URL })
```

Passes `authConfig` through to `createHttpApp`.

## Entry Point Changes (`src/index.ts`)

When `args.transport === 'http' || args.transport === 'both'`:

1. **Validate `OAUTH_OWNER_PASSWORD`** — must be set and non-empty. Throw with clear message if missing.
2. **Validate `OAUTH_ISSUER_URL`** — must be set, parse as `URL`, verify protocol is `https:` (allow `http:` only for `localhost` / `127.0.0.1`). Throw with clear message if malformed or missing. Validation happens at startup, not mid-flow.
3. **Call `createAuthSchema(db)`** — idempotent, creates auth tables if they don't exist.
4. **Pass auth config** to `startHttpTransport(serverFactory, port, { db, ownerPassword, issuerUrl })`.

Stdio transport path unchanged — no env var requirements, no auth schema creation.

## Environment Variables

Added to `.env.example`:

```
# OAuth 2.1 (required for HTTP transport)
OAUTH_OWNER_PASSWORD=your-password-here
OAUTH_ISSUER_URL=https://your-tunnel.example.com
```

## Testing Strategy

### Unit Tests (`tests/auth/`)

**`schema.test.ts`**
- `createAuthSchema` is idempotent (run twice, no error)
- All three tables exist with correct columns

**`store.test.ts`** — `SqliteClientsStore`
- Register client stores metadata and secret, generates client_id
- Get registered client returns reconstructed `OAuthClientInformationFull`
- Get unknown client returns `undefined`

**`provider.test.ts`** — `VaultOAuthProvider`
- `authorize`: renders HTML on GET; rejects wrong password; accepts correct password and redirects with code and state
- `challengeForAuthorizationCode`: returns stored challenge; throws on unknown/expired code
- `exchangeAuthorizationCode`: returns tokens with correct lifetimes; deletes code (single-use); rejects expired/mismatched
- `exchangeRefreshToken`: returns new pair; rotates refresh token; rejects revoked/expired
- `verifyAccessToken`: returns AuthInfo; rejects expired/revoked/unknown
- `revokeToken`: marks revoked; cascades from refresh to access tokens

### Integration Tests (`tests/transport/`)

**Updates to `http.test.ts`**
- Unauthenticated POST to `/mcp` returns 401
- `HEAD /mcp` accessible without auth
- `/.well-known/oauth-authorization-server` returns valid metadata JSON

**Full OAuth flow test**
- Register client via DCR → authorize with password → exchange code for tokens → authenticated `/mcp` POST succeeds → refresh token exchange → revoke token → subsequent request fails

### Env Var Validation Tests

- Missing `OAUTH_OWNER_PASSWORD` with HTTP transport → startup error
- Missing `OAUTH_ISSUER_URL` with HTTP transport → startup error
- Malformed `OAUTH_ISSUER_URL` (not HTTPS) → startup error
- `http://localhost` allowed as issuer URL
- Stdio transport starts without auth env vars

All tests use in-memory SQLite (`:memory:`) and supertest. No real Cloudflare tunnel needed.

## Dependencies

No new npm packages required. Everything is covered by:
- `@modelcontextprotocol/sdk` — OAuth router, handlers, middleware, types
- `express` — already installed
- `better-sqlite3` — already installed
- `crypto` — Node.js built-in (randomBytes, randomUUID, createHash, timingSafeEqual)

## Out of Scope

- Static bearer token auth (deferred — add when Fireworks integration is needed)
- Scoped permissions (single-user system)
- Token cleanup/garbage collection (single-user; expired rows are harmless)
- TLS termination (handled by Cloudflare tunnel)
- CORS configuration (not needed for server-to-server MCP)
- Multiple user accounts
