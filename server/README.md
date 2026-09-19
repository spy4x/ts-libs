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
| `@ts-libs/server/export`            | Versioned export envelope and `Content-Disposition` download response               |
| `@ts-libs/server/export-client`     | Browser-only: save a response body as a file (DOM, so never imported server-side)   |
| `@ts-libs/server/static`            | Static-file serving with a MIME table and path-traversal protection                 |
| `@ts-libs/server/healthcheck`       | Loopback TCP probe, exit 0/1, for distroless images                                 |

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

| Source                                       | Bug                                                                                                                                 | Pinned by                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `warthunder-stats/.../body.ts:49`            | `body.buffer` ignored `byteOffset`/`byteLength` (off by the view)                                                                   | `readBoundedText decodes a multi-byte body at the cap`                        |
| `warthunder-stats/.../body.ts:53`            | a rejecting `reader.cancel()` replaced the real read error                                                                          | `readBoundedBody reports the read error even when cancel rejects`             |
| `warthunder-stats/.../body.ts:60-66`         | an over-cap `content-length` was only checked after streaming                                                                       | `readBoundedBody rejects an oversized declared content-length before reading` |
| `warthunder-stats/.../body.ts:68`            | the rejected body was left uncancelled                                                                                              | `readBoundedBody cancels an over-cap declared body without reading it`        |
| `offer-lens/libs/scraper/mod.ts:184-186`     | reader never cancelled when the timeout won the `Promise.race`                                                                      | `readBoundedBody rejects a stalled body when the deadline fires`              |
| =======                                      |                                                                                                                                     |                                                                               |
| Source                                       | Bug                                                                                                                                 | Pinned by                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `warthunder-stats/.../body.ts:49-51`         | `body.buffer` ignored the view's `byteOffset`/`byteLength`; the `as ArrayBuffer` cast hid it                                        | `parseBoundedFormData respects a non-zero byteOffset on the read buffer`      |
| `warthunder-stats/.../body.ts:11-13`         | an over-cap `content-length` was rejected without cancelling the request body                                                       | `readBoundedBody cancels an over-cap declared body without reading it`        |
| `warthunder-stats/.../body.ts:28`            | `await reader.cancel()` in the `catch` was relied on not to reject, while the sibling call was wrapped                              | `readBoundedBody reports the read error even when cancel rejects`             |
| `offer-lens/libs/scraper/mod.ts:184-186`     | when the deadline won the `Promise.race` the reader was only cancelled "best effort", leaving a pending `read()` that never settles | `readBoundedBody rejects a stalled body when the deadline fires`              |
| `offer-lens/libs/scraper/mod.ts:206`         | the oversized `content-length` early-out was absent, so a body that declares 4 GiB was streamed before being rejected               | `readBoundedBody rejects an oversized declared content-length before reading` |
| `offer-lens/apps/api/services/cors.ts:53-60` | an `https://` host missing from the allowlist fell through to the dev-host check                                                    | `cors: https dev origins are refused`                                         |

## `server/export`

`buildExportEnvelope`, `EXPORT_VERSION`, `exportFileName`, `formatLocalDate`,
`exportDownloadHeaders`, `exportDownloadResponse`.

Repository-agnostic: the caller supplies the user value and one `{ name, load }` per collection. The
filename uses the **local** calendar day, not `toISOString().slice(0, 10)`, which named an export for
a day the user was not on.

## `server/export-client`

`downloadResponseAsFile` plus the injected `DownloadOptions`. Browser-only (`document`, object URL),
so it is a separate subpath — a server import of `@ts-libs/server/export` never pulls a DOM type.

## `server/static`

`serveStatic`, `resolveStaticPath`, `isPathInsideRoot`, `contentTypeFor`, `denoStaticFs`.

The request path is percent-decoded **once**, then every segment is checked: `..`, a backslash, an
absolute path, a NUL byte and an encoded separator are all refused **before any filesystem call**. The
adapter then compares the realpath of the resolved file against the realpath of the root, because only
the realpath can reveal a symlink that points outside. An SPA fallback is one flag, not a list of
route paths.

## `server/healthcheck`

`probeLoopback`, `healthcheckExitCode`, `runHealthcheck`, `resolveHealthcheckPort`, `denoConnector`,
`DEFAULT_TIMEOUT_MS`, `DEFAULT_PORT`.

Lives here rather than in `ops/` on purpose: `ops/` is issue #18's package and would need its own
`deno.json`, so this avoids two writers of one config for 60 LOC. The probe is separated from the exit
so the decision is a return value a test can assert with `--allow-read --allow-env` and no socket.
