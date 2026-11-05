# `@spy4x/server`

Server-side primitives and adapters for Hono and Fresh apps.

## Install

```bash
deno add jsr:@spy4x/server
```

Runs on: server (Deno).

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/server/http/bounded-body`](http/bounded-body.ts): Bounded request-body reading for HTTP servers.
- [`@spy4x/server/http/cors`](http/cors.ts): CORS origin allow-listing for browser-facing APIs.
- [`@spy4x/server/http/bearer-auth`](http/bearer-auth.ts): Bearer token verification.
- [`@spy4x/server/http/same-origin`](http/same-origin.ts): Cross-site request forgery guard for cookie-authenticated APIs.
- [`@spy4x/server/http/security-headers`](http/security-headers.ts): Security headers for a same-origin single-page app.
- [`@spy4x/server/http/health`](http/health.ts): A health endpoint over named checks.
- [`@spy4x/server/http/trusted-proxy`](http/trusted-proxy.ts): Trust the forwarded-client headers only from the proxies in front of the app.
- [`@spy4x/server/export`](export.ts): Versioned data-export envelopes and download responses.
- [`@spy4x/server/static`](static.ts): Static-file serving for a single root directory.
- [`@spy4x/server/healthcheck`](healthcheck.ts): Loopback healthcheck for containers with no shell and no HTTP client.
- [`@spy4x/server/storage`](storage/index.ts): A `FileStorage` port with a local-disk and an S3 provider, plus a bucket-bound wrapper and the env-driven constructors that pick and build one.
- [`@spy4x/server/images`](images/mod.ts): Turns an uploaded photo into images a public page can show.
- [`@spy4x/server/auth`](auth/mod.ts): The sign-in account model and its store.
- [`@spy4x/server/auth/postgres`](auth/postgres.ts): The Postgres `AuthStore` and `SessionStore`, and the tables they need.
- [`@spy4x/server/auth/memory-store`](auth/memory-store.ts): `MemoryAuthStore`.
- [`@spy4x/server/auth/password`](auth/password.ts): Sign-in with an email address and a password, built on `AuthStore` and `SessionManager`.
- [`@spy4x/server/auth/email-code`](auth/email-code.ts): Sign-in with a one-time code sent by email.
- [`@spy4x/server/auth/oauth`](auth/oauth.ts): Sign-in with an OAuth2 / OpenID Connect provider (Google, or any provider the app configures).
- [`@spy4x/server/auth/oauth-google`](auth/oauth-google.ts): Google's `OAuthProviderConfig` for `createOAuthSignIn` from `@spy4x/server/auth/oauth`.
- [`@spy4x/server/auth/oauth-github`](auth/oauth-github.ts): GitHub's `OAuthProviderConfig` for `createOAuthSignIn` from `@spy4x/server/auth/oauth`.
- [`@spy4x/server/sign-in`](sign-in/mod.ts): The building blocks a sign-in method stands on.
- [`@spy4x/server/sign-in/password-hash`](sign-in/password-hash.ts): Prints the hash of a password, as `createPasswordHasher` makes it, for an app's config (such as the `ownerPassword.hash` of `@spy4x/server/mcp-oauth`).
- [`@spy4x/server/webauthn`](webauthn/mod.ts): Passkeys (WebAuthn level 3) for a relying party.
- [`@spy4x/server/config`](config/index.ts): Environment to typed config, over an injected `EnvReader`.
- [`@spy4x/server/config/env`](config/env.ts): Reading environment values without touching the process environment at import time.
- [`@spy4x/server/request-log`](request-log/log.ts): Request-logging middleware for Hono.
- [`@spy4x/server/request-log/base-middleware`](request-log/base-middleware.ts): The middleware every Hono API passes first.
- [`@spy4x/server/kv`](kv/mod.ts): A Redis-backed key-value store, scoped to a caller-supplied key prefix.
- [`@spy4x/server/outbox`](outbox/mod.ts): Transactional outbox drain.
- [`@spy4x/server/idempotency`](idempotency/mod.ts): Commands that are safe to send twice.
- [`@spy4x/server/lockout`](lockout/mod.ts): An escalating lockout for any secret a person can guess.
- [`@spy4x/server/lockout/memory-store`](lockout/memory-store.ts): The in-memory `LockoutStore`, held to the same contract as the Postgres one.
- [`@spy4x/server/lockout/postgres`](lockout/postgres.ts): The Postgres `LockoutStore`, over a table and columns the caller names.
- [`@spy4x/server/mcp-oauth`](mcp-oauth/mod.ts): Single-user OAuth 2.1 for remote MCP connectors.
- [`@spy4x/server/mcp-oauth/memory-store`](mcp-oauth/memory-store.ts): The in-memory `OAuthStore`.
- [`@spy4x/server/mcp-oauth/kv-store`](mcp-oauth/kv-store.ts): The Deno KV `OAuthStore`.
- [`@spy4x/server/subscribers`](subscribers/mod.ts): Double opt-in mailing lists.
- [`@spy4x/server/subscribers/file`](subscribers/file.ts): The mailing-list store in a JSON file, compatible with the files antonshubin.com wrote.
- [`@spy4x/server/subscribers/memory`](subscribers/memory.ts): The in-memory subscriber store and send log, held to the shared contracts.
- [`@spy4x/server/subscribers/postgres`](subscribers/postgres.ts): The Postgres subscriber store and send log, with the schema to migrate.
- [`@spy4x/server/crypto`](crypto.ts): AES-256-GCM at-rest encryption for secrets (OAuth tokens, provider API keys).
- [`@spy4x/server/user-secrets`](user-secrets.ts): BYOK (bring-your-own-key) secret store.
- [`@spy4x/server/quota`](quota.ts): Usage quota metering — a countable budget per principal over a long window, decremented by units of business work (one analysis, one export, one document).
- [`@spy4x/server/db`](db/index.ts): The Postgres and SQLite layers, plus the migration runner they share.
- [`@spy4x/server/db/migrate`](db/migrate.ts): The migration runner both adapters share.
- [`@spy4x/server/db/postgres`](db/postgres.ts): Postgres pool tuning.
- [`@spy4x/server/db/notify`](db/notify.ts): Postgres `LISTEN`/`NOTIFY` with JSON payloads.
- [`@spy4x/server/db/testing`](db/require-connection.ts): The integration tier's Postgres settings, read so that a missing one fails the test instead of skipping it.
- [`@spy4x/server/db/sqlite`](db/sqlite.ts): The SQLite adapter.
- [`@spy4x/server/env-age64`](env-age64/mod.ts): Age64 env-file encryption.
- [`@spy4x/server/env-age64/cli`](env-age64/cli.ts): Runnable CLI for the module, meant to be a project's whole `env:encrypt`/`env:decrypt` task.
