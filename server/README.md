# @ts-libs/server

Server-side primitives for Hono and Fresh apps: bounded request bodies, CORS origin allow-listing,
export envelopes, static-file serving and a distroless healthcheck. Zero dependencies except `hono`,
which is already pinned in the root import map and used only for the `hono/cors` resolver type.

## Subpaths

| Export                              | What it is                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `@ts-libs/server/http/bounded-body` | Byte-capped, timeout-bounded request body reading; `PayloadTooLargeError`           |
| `@ts-libs/server/http/cors`         | Exact-match origin allowlist and the `hono/cors` origin resolver                    |
| `@ts-libs/server/http/redact`       | Provider-error redaction: class name and scope to the log, a constant to the client |

## `server/http/bounded-body`

`readBoundedBody`, `readBoundedText`, `parseBoundedFormData`, `readContentLength`,
`PayloadTooLargeError`.

Every function takes `{ maxBytes, timeoutMs? }`. The cap is enforced on the stream, a declared
`content-length` over the cap is rejected without reading the body, and the reader is cancelled on
any failure — including a stalled body whose deadline passes.

**Canonical home pending.** This is a temporary duplicate of `net/bounded-body.ts` (issue #1). When
that lands, this module collapses to `export * from "@ts-libs/net/bounded-body"` plus
`parseBoundedFormData`. `PayloadTooLargeError` must remain a single class, so callers keep catching
the same identity.

## `server/http/cors`

`resolveAllowedOrigin`, `createCorsOriginResolver`, `CORS_ALLOW_METHODS`, `CORS_ALLOW_HEADERS`,
`DEV_ORIGIN_HOSTS`.

The allowlist is configuration (`{ allowedOrigins, devHosts? }`), not a constant baked to one
product. Matching is exact on the serialised origin, and the value must round-trip through the WHATWG
`URL` parser unchanged, which refuses a path, query, fragment, userinfo or trailing slash in one
check. `createCorsOriginResolver` throws on an empty allowlist rather than returning a resolver that
accepts everything.

## `server/http/redact`

`ProviderScope`, `genericProviderMessage`, `logProviderError`.

`logProviderError` writes one fixed-shape line — `${scope}_provider_error ${errorName}` — and never
the message, stack, cause or request id. The client-facing message is a constant per scope, so no
provider text can reach a response body.

### Fixes applied at extraction time

| Source                                   | Bug                                                               | Pinned by                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `warthunder-stats/.../body.ts:49`        | `body.buffer` ignored `byteOffset`/`byteLength` (off by the view) | `readBoundedText decodes a multi-byte body at the cap`                        |
| `warthunder-stats/.../body.ts:53`        | a rejecting `reader.cancel()` replaced the real read error        | `readBoundedBody reports the read error even when cancel rejects`             |
| `warthunder-stats/.../body.ts:60-66`     | an over-cap `content-length` was only checked after streaming     | `readBoundedBody rejects an oversized declared content-length before reading` |
| `warthunder-stats/.../body.ts:68`        | the rejected body was left uncancelled                            | `readBoundedBody cancels an over-cap declared body without reading it`        |
| `offer-lens/libs/scraper/mod.ts:184-186` | reader never cancelled when the timeout won the `Promise.race`    | `readBoundedBody rejects a stalled body when the deadline fires`              |
