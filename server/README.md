# @ts-libs/server

Server-side primitives for Hono and Fresh apps: bounded request bodies, CORS origin allow-listing,
export envelopes, static-file serving and a distroless healthcheck. Zero dependencies except `hono`,
which is already pinned in the root import map and used only for the `hono/cors` resolver type.

## Subpaths

| Export                              | What it is                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `@ts-libs/server/http/bounded-body` | Byte-capped, stall-budgeted request body reading; canonical `PayloadTooLargeError`  |
| `@ts-libs/server/http/cors`         | Exact-match origin allowlist and the `hono/cors` origin resolver                    |
| `@ts-libs/server/http/redact`       | Provider-error redaction: class name and scope to the log, a constant to the client |
| `@ts-libs/server/export`            | Versioned export envelope and `Content-Disposition` download response               |
| `@ts-libs/server/export-client`     | Browser-only: save a response body as a file (DOM, so never imported server-side)   |
| `@ts-libs/server/static`            | Static-file serving with a MIME table and path-traversal protection                 |
| `@ts-libs/server/healthcheck`       | Loopback TCP probe, exit 0/1, for distroless images                                 |

**Merge order:** the three issues that added these files (`#28`, `#30`, `#35`) were cut from one
`main` and each carries the earlier ones, so whoever merges second rebases with a **union** on
`server/deno.json` exports and this README — never by dropping another package's entries.
`server/http/bounded-body.ts` is the exception: `#28`/`#30` carried a byte-identical copy of
`net/bounded-body.ts` (`sha256 5fc55e75`) and that copy has since collapsed into the canonical
module, so this file no longer matches the pre-collapse branches by design.

**Verification beyond `deno task check`.** `deno task check` is green with an `exports` entry pointing
at a file that does not exist, so every branch that touches `server/deno.json` must also run:

```bash
deno publish --dry-run --allow-dirty                          # exit 0
CI=true DENO_DIR=$(mktemp -d) deno publish --dry-run --allow-dirty   # exit 0, cold
```

That is the check that catches a dangling target (`TS2307`, exit 1) — the failure mode that blocked
the sibling `time/` package. Every entry in this package's `exports` must resolve inside _this_ tree;
`#31` (`server/storage`) owns `./storage` and must not be pre-declared here.

## `server/http/bounded-body`

`readBoundedBody`, `readBoundedText`, `parseBoundedFormData`, `readContentLength`,
`PayloadTooLargeError`, and the types `ReadBoundedBodyOptions` and `BodySource`.

**Canonical home: `net/bounded-body.ts`** (`@ts-libs/net/bounded-body`). This module is a named
re-export of it: `PayloadTooLargeError`, `readBoundedBody`, `readBoundedText` and
`readContentLength` are the canonical symbols, so `PayloadTooLargeError` is one class object behind
both specifiers and a single `catch` covers either import. The re-export is named rather than
`export *`, so `BodyReadErrorCode`, `BodyReadTimeoutError`, `readBoundedJson` and the default
constants are not republished as if this package had promised them. `parseBoundedFormData` stays
here — it is the only server-specific entry point, and it is built on the canonical reader. The
cap is enforced on the stream, a declared `content-length` over the cap is rejected without
reading the body, and the reader is cancelled on any failure. `maxBytes` is optional and defaults
to 5 MiB; `timeoutMs` is a **per-chunk stall budget, not a single overall deadline** — a
slow-but-live upload is never cut off by its own total duration, only by a gap between chunks. A
stall rejects with the canonical `BodyReadTimeoutError`, importable from
`@ts-libs/net/bounded-body`, rather than the bare `Error` this module threw before the collapse.

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
| `warthunder-stats/.../body.ts:49-51`         | `body.buffer` ignored the view's `byteOffset`/`byteLength` — the `as ArrayBuffer` cast hid it                                       | `parseBoundedFormData respects a non-zero byteOffset on the read buffer`      |
| `warthunder-stats/.../body.ts:11-13`         | an over-cap `content-length` was rejected without cancelling the request body, and the check did not pin the position of the read   | `readBoundedBody leaves an unread rejected body to the server to drain`       |
| `warthunder-stats/.../body.ts:23-24`         | the cap was enforced by a `NaN`-comparing `Number(...)` check instead of an explicit header reader                                  | `readContentLength reads a bare decimal length and ignores anything else`     |
| `warthunder-stats/.../body.ts:28`            | `await reader.cancel()` in the `catch` was relied on not to reject, while the sibling call was wrapped                              | `readBoundedBody reports the read error even when cancel rejects`             |
| `offer-lens/libs/scraper/mod.ts:184-186`     | when the deadline won the `Promise.race` the reader was only cancelled "best effort", leaving a pending `read()` that never settles | `readBoundedBody rejects a stalled body once the stall budget expires`        |
| `offer-lens/libs/scraper/mod.ts:206`         | the oversized `content-length` early-out was absent, so a body declaring 4 GiB was streamed before being rejected                   | `readBoundedBody rejects an oversized declared content-length before reading` |
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
`LOOPBACK_HOSTS`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_PORT`.

`hostname` must be a `LOOPBACK_HOSTS` entry, so a probe cannot be aimed at a public bind; `timeoutMs`
must be a non-negative integer; and `HEALTHCHECK_PORT`/`PORT` must be bare decimal digits
(`0x1f90`, `1e3`, `+8080` are refused rather than parsed), the same rule this package applies to
`content-length`.

Lives here rather than in `ops/` on purpose: `ops/` is issue #18's package and would need its own
`deno.json`, so this avoids two writers of one config for 60 LOC. The probe is separated from the exit
so the decision is a return value a test can assert with `--allow-read --allow-env` and no socket.

Two rows changed meaning when this module collapsed into the canonical reader: the canonical one
rejects an over-cap `content-length` before taking a reader, so there is no reader to cancel and an
unread request body is left to the server to drain, and a stall now surfaces as
`BodyReadTimeoutError` rather than a bare `Error`.
