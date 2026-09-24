# `@spy4x/server`

Server-side primitives and adapters for Hono and Fresh apps. Two groups today:

- **HTTP** — bounded request bodies, CORS origin allow-listing, bearer-token verification, export
  envelopes, static-file serving and a distroless healthcheck. Zero runtime dependencies: `hono` is
  pinned in the root import map, but `cors.ts` imports nothing — only `cors.test.ts` imports the
  `hono/cors` resolver type, for its own assertions.
- **Storage** — the `FileStorage` port with a local-filesystem provider, an S3-compatible provider
  and a bucket-binding wrapper. Zero dependencies.

## Subpaths

| Export                            | What it is                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `@spy4x/server/http/bounded-body` | Byte-capped, stall-budgeted request body reading; canonical `PayloadTooLargeError`   |
| `@spy4x/server/http/cors`         | Exact-match origin allowlist and the `hono/cors` origin resolver                     |
| `@spy4x/server/http/bearer-auth`  | Bearer token extraction and constant-time verification (moved from `mcp/auth.ts`)    |
| `@spy4x/server/export`            | Versioned export envelope and `Content-Disposition` download response                |
| `@spy4x/server/static`            | Static-file serving with a MIME table and path-traversal protection                  |
| `@spy4x/server/healthcheck`       | Loopback TCP probe, exit 0/1, for distroless images                                  |
| `@spy4x/server/storage`           | The `FileStorage` port, the local and S3 providers, bucket binding, SigV4 presigning |
| `@spy4x/server/auth`              | Sign-in account model and `AuthStore`: see the `server/auth` section below           |
| `@spy4x/server/auth/postgres`     | The Postgres `AuthStore` and `SessionStore`, and the `AUTH_POSTGRES_SCHEMA` tables   |
| `@spy4x/server/auth/memory-store` | The in-memory `AuthStore`, held to the same contract as the Postgres one, for tests  |
| `@spy4x/server/auth/password`     | Password sign-up, sign-in, change and reset: see `server/auth/password` below        |
| `@spy4x/server/auth/email-code`   | Sign-in with a one-time code sent by email: see `server/auth/email-code` below       |
| `@spy4x/server/auth/oauth`        | OAuth2 sign-in with PKCE, matched by the provider's `sub`: see `server/auth/oauth`   |
| `@spy4x/server/auth/oauth-google` | Google's provider configuration for `@spy4x/server/auth/oauth`                       |
| `@spy4x/server/sign-in`           | Sessions, the session cookie, Hono auth guards, peppered password hashing, TOTP      |
| `@spy4x/server/crypto`            | AES-256-GCM cipher bound to its row, hex key, capped `maskKey` hint                  |
| `@spy4x/server/user-secrets`      | BYOK store over an injected port: guarded base URL, encrypt, mask, upsert            |
| `@spy4x/server/quota`             | Usage metering with an atomic reserve and 429/503 — not a rate limiter               |
| `@spy4x/server/db`                | Barrel: Postgres and SQLite adapters plus the migration runner they share            |
| `@spy4x/server/db/migrate`        | Migration runner: discovers, orders and applies `.sql` files, one port for both      |
| `@spy4x/server/db/postgres`       | Postgres pool with sane connect/idle/statement timeout defaults                      |
| `@spy4x/server/db/sqlite`         | SQLite adapter behind an injectable driver port; ships no driver                     |
| `@spy4x/server/request-log`       | Hono request-logging middleware, method/path/status/elapsed only, injected writer    |
| `@spy4x/server/config`            | `EnvReader` + `loadConfig`: one arktype schema validated against the environment     |
| `@spy4x/server/kv`                | A Redis-backed key-value store, keys scoped under a caller-supplied prefix           |
| `@spy4x/server/outbox`            | Transactional outbox drain: claim, publish, retry, over a generic SQL table          |

**Verification beyond `deno task check`.** `deno task check` is green with an `exports` entry pointing
at a file that does not exist, so every branch that touches `server/deno.json` must also run:

```bash
deno task publish:dry            # warm, exit 0
deno task check:cold publish:dry # cold, per AGENTS.md — CI does not run this; run it yourself
```

That is the check that catches a dangling target (`TS2307`, exit 1) — the failure mode that blocked
the sibling `time/` package. Every entry in this package's `exports` must resolve inside _this_ tree;
`#31` (`server/storage`) owns `./storage` and must not be pre-declared here.

## `server/http/bounded-body`

`readBoundedBody`, `readBoundedText`, `parseBoundedFormData`, `readContentLength`,
`PayloadTooLargeError`, and the types `ReadBoundedBodyOptions` and `BodySource`.

**Canonical home: `net/bounded-body.ts`** (`@spy4x/net/bounded-body`). This module is a named
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
`@spy4x/net/bounded-body`, rather than the bare `Error` this module threw before the collapse.

## `server/http/cors`

`resolveAllowedOrigin`, `createCorsOriginResolver`, `CORS_ALLOW_METHODS`, `CORS_ALLOW_HEADERS`,
`DEV_ORIGIN_HOSTS`.

The allowlist is configuration (`{ allowedOrigins, devHosts? }`), not a constant baked to one
product. Matching is exact on the serialised origin, and the value must round-trip through the WHATWG
`URL` parser unchanged, which refuses a path, query, fragment, userinfo or trailing slash in one
check. `createCorsOriginResolver` throws on an empty allowlist rather than returning a resolver that
accepts everything.

## `server/http/bearer-auth`

`bearerTokenFromHeaders`, `bearerTokenFromEnv`, `constantTimeEquals`, `createTokenVerifier`,
`redactor`, `formatLogLine`, `AUTHORIZATION_HEADER`, `REDACTED_TOKEN`, and the `TokenVerifier`
interface.

Moved here from `mcp/auth.ts` when `mcp/` was removed (`#64`): a generic "extract and verify a
bearer token, never in the environment at module scope, never compared with `===`" helper, with
nothing MCP-specific about it. Both sides of the comparison are SHA-256 digested before
`timingSafeEqual`, so neither the presented token's length nor a shared prefix is observable by
timing. `redactor`/`formatLogLine` strip every configured secret from a log line, so a raw
`Authorization` header cannot reach a log by accident.

## Fixes applied at extraction time (`server/http/bounded-body`, `server/http/cors`)

| Source                                       | Bug                                                                                                                                 | Pinned by                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `warthunder-stats/.../body.ts:49-51`         | `body.buffer` ignored the view's `byteOffset`/`byteLength` — the `as ArrayBuffer` cast hid it                                       | `parseBoundedFormData respects a non-zero byteOffset on the read buffer`      |
| `warthunder-stats/.../body.ts:11-13`         | an over-cap `content-length` was rejected without cancelling the request body, and the check did not pin the position of the read   | `readBoundedBody leaves an unread rejected body to the server to drain`       |
| `warthunder-stats/.../body.ts:23-24`         | the cap was enforced by a `NaN`-comparing `Number(...)` check instead of an explicit header reader                                  | `readContentLength reads a bare decimal length and ignores anything else`     |
| `warthunder-stats/.../body.ts:28`            | `await reader.cancel()` in the `catch` was relied on not to reject, while the sibling call was wrapped                              | `readBoundedBody reports the read error even when cancel rejects`             |
| `offer-lens/libs/scraper/mod.ts:184-186`     | when the deadline won the `Promise.race` the reader was only cancelled "best effort", leaving a pending `read()` that never settles | `readBoundedBody rejects a stalled body once the stall budget expires`        |
| `offer-lens/libs/scraper/mod.ts:206`         | the oversized `content-length` early-out was absent, so a body declaring 4 GiB was streamed before being rejected                   | `readBoundedBody rejects an oversized declared content-length before reading` |
| `offer-lens/apps/api/services/cors.ts:53-60` | an `https://` host missing from the allowlist fell through to the dev-host check                                                    | `cors: https dev origins are refused`                                         |

Two rows changed meaning when `server/http/bounded-body.ts` collapsed into the canonical
reader (`net/bounded-body.ts`): the canonical one rejects an over-cap `content-length` before
taking a reader, so there is no reader to cancel and an unread request body is left to the
server to drain, and a stall now surfaces as `BodyReadTimeoutError` rather than a bare `Error`.

## `server/export`

`buildExportEnvelope`, `EXPORT_VERSION`, `exportFileName`, `formatLocalDate`,
`exportDownloadHeaders`, `exportDownloadResponse`.

Repository-agnostic: the caller supplies the user value and one `{ name, load }` per collection. The
filename uses the **local** calendar day, not `toISOString().slice(0, 10)`, which named an export for
a day the user was not on.

## `server/static`

`serveStatic`, `resolveStaticPath`, `isPathInsideRoot`, `contentTypeFor`, `denoStaticFs`.

The request path is percent-decoded **once**, then every segment is checked: `..`, a backslash, an
absolute path, a NUL byte and an encoded separator are all refused **before any filesystem call**. The
adapter then compares the realpath of the resolved file against the realpath of the root, because only
the realpath can reveal a symlink that points outside. An SPA fallback is one flag, not a list of
route paths.

A file is streamed, not read whole: `StaticFs.open` returns the file's size and a `ReadableStream`, so
serving a large file costs the same per-request memory as serving a small one. `Content-Length` comes
from that size, never from a buffer. For a `GET`, the handle is released the first time the body is
fully read, is cancelled by the client, or fails on a read — but a `GET` response whose body is never
read and never cancelled still holds the handle until garbage collection, which is exactly what a
framework does to a `HEAD` response it builds fresh and discards unread. Pass `method: "HEAD"` and the
response carries the same headers with no body, closed before `serveStatic` returns. Range and
conditional requests are not implemented; a request for either is served the same as a plain `GET`.

## `server/healthcheck`

`probeLoopback`, `healthcheckExitCode`, `runHealthcheck`, `resolveHealthcheckPort`, `denoConnector`,
`LOOPBACK_HOSTS`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_PORT`.

The probe connects to the loopback port and closes the socket again: `{ healthy: true }` when the
connect succeeds, `{ healthy: false, reason: "connect_failed" }` when it is refused or misses its
deadline. An earlier version also wrote one byte after connecting and waited for it to be echoed
back, and reported a real, running web server as down — a web server answers HTTP or nothing, it
never echoes a raw TCP byte, so the echo step timed out against every live server it was pointed at.
That step, `ProbeConnection.write`/`.read` and the three failure reasons `write_failed`, `no_echo`
and `read_timeout` are removed here as a breaking change: this package is `0.1.0` and has never been
published, so there is no consumer to carry the old shape forward. A real HTTP request against the
server would tell more — a server that accepts connections but never answers one still reads healthy
under connect-and-close — and is tracked as a follow-up (#58), not built in this change.

`hostname` must be a `LOOPBACK_HOSTS` entry, so a probe cannot be aimed at a public bind; `timeoutMs`
must be a non-negative integer; and `HEALTHCHECK_PORT`/`PORT` must be bare decimal digits
(`0x1f90`, `1e3`, `+8080` are refused rather than parsed), the same rule this package applies to
`content-length`.

Lives here rather than in a deploy-tooling package: `ops/` used to be that package and would have
needed its own `deno.json` for 60 LOC, and `ops/` was later removed from ts-libs entirely (#67). The
probe is separated from the exit so the decision is a return value a test can assert with
`--allow-read --allow-env` and no socket.

## `server/storage`

## The port

`FileStorage` is exported **as a type**, not just implemented here: writing your
own provider is the point of a port, and nothing in the package requires a
subclass of a shipped class.

| Method                         | Contract                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getUploadURL(bucket, path)`   | Presigned PUT URL. Private by default; `{ acl: "public-read" }` is the only way to change that.                                                     |
| `getDownloadURL(bucket, path)` | Presigned GET URL. Never carries an ACL, even if one is passed.                                                                                     |
| `upload(bucket, path, body)`   | `Uint8Array` or `string`. **Byte-exact** — a provider that decodes the body to text violates the port.                                              |
| `download(bucket, from, to)`   | Streams to the local file `to`, returns the number of bytes written. `to` is the caller's path, refused if it carries a `..` segment or a NUL byte. |
| `doesExist(bucket, path)`      | `false` for a missing object; **throws** for every other failure, so a denied or unreachable probe never reads as "absent".                         |

`bucket` and `path` are validated before use: a bucket must be a legal
lowercase S3 name, and a path that is absolute, carries a scheme, a backslash or
a `..` segment is rejected with a `StorageError` rather than normalised. A
crafted key cannot leave its bucket in either provider.

`StorageError` carries a machine-readable `code` (`invalid_bucket`,
`invalid_path`, `invalid_acl`, `invalid_expiry`, `invalid_config`,
`request_failed`), the `operation`, and any HTTP `status`, so a caller branches
on values instead of message text.

## Providers

| Provider       | Runtime dependency | Addressing                                                                  |
| -------------- | ------------------ | --------------------------------------------------------------------------- |
| `LocalStorage` | none               | `<basePath>/<bucket>/<object>`, default `./file-storage`; dev only          |
| `S3Storage`    | none               | Virtual-hosted by default; path-style for a loopback endpoint such as MinIO |

Neither provider adds a dependency. SigV4 presigning is implemented over Web
Crypto, and the only network calls are the data path (`upload`, `download`,
`doesExist`), which is why presigning is pure, deterministic and testable.

`LocalStorage.getUploadURL`/`getDownloadURL` return `file:` URLs. A file URL is
not an authorisation, and a browser cannot PUT to one, so neither URL is a
direct-upload or a share target — they exist to satisfy the port for local
development. Use `upload`/`download` with a local provider.

### Provider selection

```ts
import { createStorage } from "@spy4x/server/storage"

const storage = await createStorage() // reads Deno.env, returns undefined if unconfigured
await storage?.upload("media/photo.png", bytes)
```

`loadStorageProvider("s3" | "local", s3Config?)` keeps the source's dynamic
`import()`: a deployment that selects `local` never evaluates or fetches the S3
provider. The key is an **argument**, not a module-scope `$env` read, so
importing the package has no environment dependency and cannot fail on a missing
variable. `createStorage()` is the only function that reads real environment
variables, and it uses the same `parseStorageEnv(record)` helper that a test
drives with a literal object.

### Injecting configuration

Every provider takes its configuration as a constructor argument, so a caller
that does not want the environment path builds one directly:

```ts
const provider = new S3Storage({
  region: "eu-central-1",
  accessKeyId: Deno.env.get("S3_ACCESS_KEY_ID")!,
  secretAccessKey: Deno.env.get("S3_SECRET_ACCESS_KEY")!,
  endpoint: "http://127.0.0.1:9000",
  forcePathStyle: true,
  clock: () => new Date(), // injected: tests pin it for a fixed signature
  fetch: myFetch, // injected: tests never open a socket
  fs: createMemoryObjectFs(), // injected: tests never write to disk
})
const storage = createBucketStorage({ bucket: "examplebucket", provider })
```

`clock`, `fetch` and `fs` each default to the real thing and exist so a
signature, a transfer and a filesystem write can all be pinned in a test. A
provider that could not be tested this way would be a design defect.

## Environment

| Variable                  | Required       | Meaning                                                                          |
| ------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `FILE_STORAGE_PROVIDER`   | yes, to enable | `local` or `s3`. Unset or empty → `createStorage()` returns `undefined`.         |
| `FILE_STORAGE_BUCKET`     | yes            | Bucket to bind. Not defaulted: a wrong bucket must not be guessed.               |
| `FILE_STORAGE_LOCAL_PATH` | no             | Local base directory. Defaults to `./file-storage`.                              |
| `S3_REGION`               | for `s3`       | e.g. `eu-central-1`.                                                             |
| `S3_ENDPOINT`             | no             | Custom endpoint, e.g. `http://127.0.0.1:9000`. Default: derived from the region. |
| `S3_ACCESS_KEY_ID`        | for `s3`       | Access key.                                                                      |
| `S3_SECRET_ACCESS_KEY`    | for `s3`       | Secret key.                                                                      |
| `S3_SESSION_TOKEN`        | no             | Session token, signed into the presign when set.                                 |
| `S3_FORCE_PATH_STYLE`     | no             | `true`/`false`/`1`/`0`. Default: auto (loopback → path-style).                   |
| `S3_PRESIGN_EXPIRES_IN`   | no             | Whole seconds, 1–604800. Default 3600.                                           |

Placeholders only — `AKIAIOSFODNN7EXAMPLE`, `http://127.0.0.1:9000`. Never a real
bucket, key or endpoint. A required variable that is missing or empty throws at
parse time instead of falling back to a default: an unset variable and a typo
both look like an empty string, and a silent default hides the typo.

## The ACL default

The source presigned every upload with `ACL: 'public-read'`, so every object
uploaded through a returned URL became world-readable. The default here is **no
ACL at all**: the canonical request contains no `x-amz-acl` parameter, the
object inherits the bucket's private default, and `X-Amz-SignedHeaders` is
`host` alone. Both are asserted in `storage.test.ts`.

`public-read` remains available as a deliberate, per-call opt-in:

```ts
await storage.getUploadURL("public/hero.png", { acl: "public-read" })
```

The opt-in is signed, so it cannot be added or stripped by whoever holds the
URL, and an ACL outside the canned set is rejected. `getDownloadURL` ignores
`acl` entirely — a download must never need one, whatever a caller passes.

## Filesystem port

`ObjectFs` (`readObject`, `writeObject`, `existsObject`) is the filesystem
dependency of both providers, and is what lets the local provider be exercised
without disk access. `createDenoObjectFs()` is the real adapter and
`createMemoryObjectFs()` is exported for callers that want the same substitute in
their own tests.

`writeObject` returns the byte count it wrote and accepts a `Uint8Array` or a
`ReadableStream<Uint8Array>`, which is how `download` streams a response body
straight to disk without buffering the whole object.

The write path is split so its logic is reachable without disk access:
`writeToFile(path, data, open?)` owns the byte counting, the open flags contract
and the closer-on-error path, and takes `open` as an injectable opener.
`parentDirectory(filePath)` decides which directory must exist first and returns
`undefined` when none does — a bare filename like `"out.png"` creates no
directory at all.

Permission needs are documented per task, not assumed: reading needs
`--allow-read`, writing needs `--allow-write`, and the repository test task grants
neither `--allow-write` nor `--allow-net`. So the suite drives the local provider
through `createMemoryObjectFs()`, the S3 provider through an injected `fetch`,
`writeToFile` through an injected opener, and the whole `Deno` surface through an
injected `DenoFsHost`.

**Disclosed, measured gap.** `server/storage/fs.ts` is the one module below full
statement coverage: **93.75% (75/80)**, with every other module at 100%
(`env`, `errors`, `index`, `local`, `memory-fs`, `paths`, `s3`, `sigv4`). The
five uncovered statements are all platform calls behind `--allow-write`:
`Deno.open(path, { create: true, write: true, truncate: true })` and the
`denoFsHost.open` binding that reaches it. Nothing in that module's own logic is
uncovered: the stat-to-boolean branch, both write branches, the byte count, the
closer-on-error path (buffer _and_ stream) and the directory decision all have
direct tests.

`Deno.makeTempDir` does **not** make that gap closable here. On this box it fails
under the task's exact grants, and under no grants at all:

```
$ deno test --no-prompt --allow-read --allow-env /tmp/mtd.test.ts
makeTempDir FAILED: NotCapable Requires write access to <TMP>, run again with the --allow-write flag
$ deno test --no-prompt /tmp/mtd.test.ts
makeTempDir FAILED: NotCapable Requires write access to <TMP>, run again with the --allow-write flag
```

Deno 2.9.7, reproduced in a pristine worktree with no workspace config, so it is
not this repo's `deno.jsonc`. If it succeeds under a `DENO_DIR`-less default on
another box, the tests still must not depend on it: the CI gate runs
`deno task test`, and a test that needs a permission the task does not grant
fails there. No unit-tier test in this package uses `Deno.makeTempDir`, for the
reason above — that gap stands. The integration tier is a different grant:
`server/storage/local.integration.test.ts` and the `S3Storage.download` case in
`server/storage/s3.integration.test.ts` do write to a real folder, obtained from
`createScratchFolder` (`@integration-testing`) rather than `Deno.makeTempDir`,
inside the tier's narrower `--allow-write=.volumes`.

**`download`'s `toPath` is validated, and it is the caller's file.** It is not
derived from an object key, so it is not confined to a bucket — a relative
destination resolves against the process working directory, which is the
caller's own choice. What is refused is a `..` segment or a NUL byte, so a
filename that can climb cannot redirect the write. Beyond that, the destination
is the caller's responsibility and this is not a sandbox.

**`parentDirectory` is not a sanitiser.** It preserves a `..` segment
(`"../../evil/x.png"` → `"../../evil"`) and a percent-encoded one, because keys
are validated upstream: every path that reaches it came from a bucket-and-key
pair `paths.ts` already rejected `..` and absolute paths for. Feeding it an
unvalidated string yields an unvalidated path, by contract.

## Not ported

- **`imagesUtils.ts` (`cwebp` conversion) — deliberately excluded.** It shells
  out to `cwebp`, an unversioned external binary, and image conversion is a
  separate concern owned by the media wrappers. A storage package that depends on
  a codec binary would make every consumer carry it.
- **`deleteExpiredSessions` — deliberately excluded.** It is a session-cleanup
  SQL statement on the auth adapter, not a `FileStorage` operation: it takes no
  bucket, no path and no bytes, and it belongs with the auth data layer. Porting
  it here would put a domain query in a storage port. It mixed raw `snake_case`
  identifiers (`user_id`, `expires_at`) into a client configured with a camel-case
  transform; with the function out of scope there is no mixed convention here, and
  the package reads no database at all.

## `server/auth`

The sign-in account model and its store (#57): a minimal user, the keys a user signs in with, and
guess-counted challenges. The sign-in providers (password, a one-time code by email, OAuth2 and
OpenID Connect) are built on it; sessions, the cookie and password hashing come from
`server/sign-in`.

| Export                            | What it is                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `@spy4x/server/auth`              | `AuthUser`, `AuthKey`, `normalizeEmail`, `ChallengeOutcome`, the `AuthStore` |
| `@spy4x/server/auth/postgres`     | `AUTH_POSTGRES_SCHEMA`, `createPostgresAuthStore`, the session store         |
| `@spy4x/server/auth/memory-store` | `MemoryAuthStore`: the same rules in memory, for unit tests                  |

`@spy4x/server/auth` also exports `ProviderDeps` and `SignInResult`, the shape every provider
takes and returns: the store, the `SessionManager`, an optional clock and an optional
`secondFactorFor(user)`. When the app leaves `secondFactorFor` out, a provider creates the session
with `SecondFactorStatus.NotRequired`. The providers themselves are separate entry points, each with
its own section below.

```ts
import { createSqlFromEnv } from "@spy4x/server/db"
import { SessionManager } from "@spy4x/server/sign-in"
import type { AuthSessionRecord } from "@spy4x/server/auth"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "@spy4x/server/auth/postgres"

const sql = createSqlFromEnv(Deno.env.toObject())
if (!sql) throw new Error("DB_HOST is not set")

// Once, as a migration: await sql.unsafe(AUTH_POSTGRES_SCHEMA)
const store = createPostgresAuthStore(sql)
const sessions = new SessionManager<AuthSessionRecord>({
  store: createPostgresSessionStore(sql),
  pepper: Deno.env.get("SESSION_PEPPER") ?? "",
  durationMinutes: 60 * 24 * 30,
})
```

### The model

**A user is an id.** `AuthUser` has an id, `createdAt` and `deletedAt`, nothing else. The app keeps
its profile in its own table keyed by that id.

**The stores join the caller's transaction.** Both stores take either the pool or a transaction
handle — the `tx` inside the app's own `sql.begin`. On a handle, a store write that needs several
statements runs in a savepoint of the app's transaction instead of a transaction of its own, so the
auth user, its key, its session and the app's profile row commit or roll back together:

```ts
await sql.begin(async (tx) => {
  const { user, key } = await createPostgresAuthStore(tx).createUserWithKey(newKey)
  await tx`INSERT INTO profiles (user_id, name) VALUES (${user.id}, ${name})`
  // Throwing here leaves no auth user, no key and no profile.
})
```

A write the store refuses (`AuthConflictError`) rolls back only its own savepoint: the app may catch
it and still commit the rest. A single-statement method runs on the handle as given, so a statement
Postgres rejects aborts the app's transaction, and the row locks a method takes last until the app
commits. The store tells a pool from a handle by shape (`begin` or `savepoint`), so no option is
needed; a `sql.reserve()` connection has neither and is refused with a `TypeError`.

**A key is one way of signing in.** `method` is a free string (`"password"`, `"email-code"`,
`"oauth:google"`), so a provider is added by configuration. `subject` identifies the person within
the method: the normalised address for password and email code, the provider's own user id for
OAuth. The store refuses a second key with the same `(method, subject)`.

**A key's address is proven or it is not.** `provenAt` is set once the person showed they receive
mail at `email` (a code they typed, or a provider that vouches for the address). At most one user
owns a proven address. Proving a key makes its user the owner and, in the same transaction, deletes
every other user's unproven key for that address, so someone who registered an address they do not
own loses it to the person who proves it. A key created already proven (a code the person typed
before signing up, or a provider that vouches for the address) claims the address the same way
before it is written, so another user's unproven key with the same method and subject that carries
the address does not block it. A key that carries a different address or none still answers
`AuthConflictError("key-exists")`, and so does one committed while the proven insert runs; that last
case succeeds when retried. Proving an address another user owns is refused with
`AuthConflictError("email-owned")`. Deleting a user's last proven key for an address releases the
address.

**Addresses are compared in one form.** `normalizeEmail` trims and lower-cases, and accepts only
what `@spy4x/email` will send to. The store refuses a key whose `email` is not already in that form.

**A challenge counts guesses.** `issueChallenge` stores the hash of a code for a
`(purpose, subject)`. Asking for a new code replaces the hash and the expiry but keeps the guess
counter while the earlier challenge is live, so a new code never buys more guesses.
`attemptChallenge` checks one guess and counts it in one statement: parallel guesses queue on the
row lock, only the first `maxAttempts` are compared, and a match consumes the challenge. Expired
rows are harmless; delete them whenever convenient.

### The tables

`AUTH_POSTGRES_SCHEMA` creates `auth_users`, `auth_keys`, `auth_email_owners`, `auth_sessions` and
`auth_challenges`. Run it once, as a migration, in the schema the store's client resolves to (set
`search_path` to place them in a schema of their own). The database enforces the rules itself:

- `UNIQUE (method, subject)` on `auth_keys`;
- the address is the primary key of `auth_email_owners`, and a proven key's address and user must
  match an owner row, so a key is never proven for an address someone else owns;
- every key references its user, and every session references a key of its own user with
  `ON DELETE CASCADE`: disconnecting a sign-in method ends the sessions it created.

Ids are Postgres `integer`s, so every id fits in a JavaScript number.

### What it does not do

- **It does not sign anyone in.** The providers decide when to create a user, add a key, prove it or
  issue a challenge. The store only keeps the rules that must hold whichever provider runs.
- **It does not limit how often a code is asked for.** A challenge that has used up its guesses
  stays locked until it expires, and every new code moves the expiry. Put
  `@spy4x/platform/rate-limit` in front of the route that sends codes.
- **It does not stop an unproven key for an owned address.** A provider that signs people up checks
  `findUserIdByProvenEmail` first. The owner's next proof or proven insert deletes such a key.
- **It does not release addresses when a user is soft-deleted.** `deletedAt` stops sign-in; the app
  deletes the user's keys (or the user row) to release the addresses.
- **It does not delete a user who has no keys left.** A user whose last key was evicted or deleted
  keeps their user row; the app treats a user with no keys as unable to sign in.
- **It does not have an anonymous provider.** Guest accounts were not rebuilt.

## `server/auth/password`

`createPasswordSignIn`, `PasswordSignInError`, `PasswordSignInFailure`, `PASSWORD_METHOD`,
`PASSWORD_RESET_PURPOSE`, `DEFAULT_MIN_PASSWORD_LENGTH`, `DEFAULT_RESET_TTL_MINUTES`,
`DEFAULT_MAX_RESET_ATTEMPTS`, and the input and option interfaces.

Sign-up, sign-in, password change and password reset with an address and a password, on the
`server/auth` store and the `server/sign-in` session manager and hasher (#57). Written from #57's
rules, not moved from the earlier `email-password.ts`. Every refusal is thrown as a
`PasswordSignInError` whose `reason` names it.

```ts
import { createPasswordHasher } from "@spy4x/server/sign-in"
import { createPasswordSignIn } from "@spy4x/server/auth/password"

const passwords = createPasswordSignIn({
  store,
  sessions,
  hasher: createPasswordHasher({ pepper: Deno.env.get("PASSWORD_PEPPER") ?? "" }),
})

const { session } = await passwords.signIn({ email, password })
const reset = await passwords.requestReset({ email }) // the app mails reset.code to reset.email
```

### What it does

**Sign-in costs the same whether or not the account exists.** A dummy hash is made once, when the
provider is created, with the same hasher. Every `signIn` runs exactly one `verify`: against the
key's hash, or against the dummy one when there is no key or the address is malformed. A wrong
password, a missing account, a malformed address and a deleted user all answer
`invalid-credentials`. A legacy or lower-iteration hash still verifies faster than the dummy until
its first successful sign-in, which rehashes it.

**Sign-up does not prove the address.** The key starts unproven, with `email` equal to its subject,
the normalised address. Sign-up is refused as `email-taken` when another user owns the address or a
password key for it already exists. To prove it, send the signed-in user a code with the email-code
provider's `requestCode` and pass it to its `proveAddress` (see `server/auth/email-code`): the key
becomes proven and the user keeps their id and password.

**Sign in by a username with `normalizeSubject`.** The option turns the `email` field of
`signUp` and `signIn` into the key's subject, or refuses it by returning null; it defaults to
`normalizeEmail`, so an address-based provider behaves exactly as before. A custom subject gets the
same dummy-hash verification and rehash as an address. A refused subject answers `invalid-email` at
sign-up and `invalid-credentials` at sign-in, and a subject in use answers `email-taken`. The key
is written with `email: null`, so it never owns, proves or evicts an address, even when the
username looks like one. `requestReset` and `completeReset` throw a plain `Error` in this mode,
because they mail the subject; `changePassword` works as usual.

Use one normaliser per store. Username keys and address keys share the `password` method and so one
subject namespace: a username shaped like an address (`ann@example.com` taken as a username) blocks
that address's password sign-up (`email-taken`) and reset (`conflict`) for good, because the username
key carries no `email` and proving the address never evicts it. The normaliser must not throw: a
throw rejects `signIn` before its one hash verification, so that subject answers faster than a wrong
password.

```ts
const passwords = createPasswordSignIn({
  store,
  sessions,
  hasher,
  normalizeSubject: (raw) => {
    if (typeof raw !== "string") return null
    const username = raw.trim().toLowerCase()
    return [...username].length >= 1 && [...username].length <= 50 ? username : null
  },
})
await passwords.signIn({ email: username, password })
```

**Create before revoke.** `changePassword` (which checks the current password) and `completeReset`
store the new secret, then create the new session, and only then sign out the user's other sessions.
A failure part-way never leaves the person signed out while the old password still works. The
caller replaces its cookie with the returned session's.

**A reset hands the address to whoever receives the code.** `requestReset` issues a code for every
valid address, whether or not an account uses it, and returns it for the app to deliver: 32 random
bytes, of which only the SHA-256 is stored, valid 30 minutes and for 5 guesses by default.
`completeReset` checks the new password before it spends a guess, then, on a matching code, takes
one of three branches:

1. The password key's own user owns the address: the key is kept, proven if it was not, and given
   the new secret.
2. Another user owns the address: a proven password key is added to that owner, and the proven
   insert deletes the unproven claim in the same write.
3. Nobody owns the address: a new user is created with a proven password key, which deletes the
   unproven claim the same way.

So the `user` a reset returns can differ from the one that held the key. A matching code with no
password key for the address, or whose account is deleted, answers `no-account`, which only the
person who received the code learns. A write that raced the reset answers `conflict`; the code is
used by then, so the person asks for a new one.

### What it does not do

- **It does not send mail.** `requestReset` returns the code; the app sends it.
- **It does not limit guesses per account or per client.** A reset code allows its own few guesses,
  but nothing limits how often codes are asked for or passwords tried. Put
  `@spy4x/platform/rate-limit` in front of every route that calls this provider.
- **It does not hide an address in use at sign-up.** `email-taken` tells the caller; a reset is the
  way in for the address's owner.
- **It cannot tell a squatter from a person who never proved their own sign-up.** Both lose an
  unproven account to a reset by branch 2 or 3, and to a code sign-in with `verifyCode`. Prove the
  address after sign-up with the email-code provider's `proveAddress` to keep it.

## `server/auth/email-code`

`createEmailCodeSignIn`, `EmailCodeError`, `EmailCodeErrorReason`, `EMAIL_CODE_METHOD`,
`EMAIL_CODE_PURPOSE`, `EMAIL_CODE_BYTES`, `DEFAULT_CODE_TTL_MINUTES`, `DEFAULT_CODE_MAX_ATTEMPTS`,
`EmailCodeSignIn`, `EmailCodeSignInDeps`.

Sign-in with a one-time code sent by email (#57). `requestCode(email)` issues a guess-counted
challenge and hands the raw code to the app's `sendCode`; `verifyCode(email, code)` checks one guess
and, on a match, signs the person in and creates a session; `proveAddress(userId, email, code)`
checks one guess and proves the address for a user who is already signed in. Refusals are `EmailCodeError`s with a
fixed message per `reason`, which never echoes the input.

```ts
import { createEmailCodeSignIn } from "@spy4x/server/auth/email-code"

const codes = createEmailCodeSignIn({
  store,
  sessions,
  sendCode: (email, code) => mailer.send(email, `Your sign-in code: ${code}`),
})

await codes.requestCode(email)
const { session } = await codes.verifyCode(email, typedCode)

// A signed-in user proves their own address; userId comes from the validated session.
await codes.proveAddress(userId, email, typedCode)
```

### What it does

**A code login never deletes the login method.** A matched code signs in, in this order:

1. The email-code key for the address, proven again with `proveKey`, when its user owns the address.
   Every repeat login takes this path, so the same person keeps one key and one account.
2. Otherwise the user who owns the proven address, through a new proven email-code key.
3. Otherwise a new user with a proven email-code key.

An email-code key whose user does not own the address is an unproven claim made without receiving
mail there. It is never proven for its user, because that would sign the mailbox owner in to the
account of whoever registered it; the proven write of path 2 or 3 deletes it instead.

**A signed-in user proves an address without changing accounts.** `proveAddress(userId, email,
code)` checks the code exactly as `verifyCode` does, then proves every key of that user that carries
the address with `proveKey`, or adds a proven email-code key when none does. It creates no user and
no session. This is the step a password sign-up needs: the unproven password key becomes proven, the
user owns the address, and a later password sign-in, code sign-in or reset lands in the same user.
Without it, `verifyCode` for that address creates a new user and evicts the unproven key.

- The code is the same one `requestCode` sends, under the same challenge: it is bound to the
  address, not to a user. The session proves who asks and the code proves the mailbox, and a code
  works once, so it only ever serves the person who received it. Binding it to a user as well would
  add nothing: a person who hands their code to someone else has already handed over a sign-in by
  `verifyCode`.
- Another user owning the address is refused with the store's `AuthConflictError("email-owned")`,
  checked only after the code matched, so the answer never tells someone without the code that the
  address is taken. Every other user's unproven claim to the address is deleted.
- An address the user already owns is a success that writes nothing.
- A soft-deleted user answers `account-deleted` and an unknown id throws a `RangeError`, both before
  a guess is spent.
- The returned keys carry `secret`, a password hash for a password key. Keep them on the server and
  never put them in a response body. Several keys are proven with one `proveKey` each, not in one
  transaction; a retry with a new code finishes a run that failed part-way.

The route that calls `proveAddress` must:

1. **Take `userId` from the validated session, never from the request.** A user id from the body
   would let anyone prove an address onto any account.
2. **Be a state-changing `POST` protected against cross-site submission.** The session cookie of
   `@spy4x/server/sign-in` is `SameSite=Lax`, which keeps it off a cross-site `POST`, so a
   POST-only route is covered. An app that authenticates with a bearer token instead needs its own
   check.
3. **Show which account is signed in before asking for the code.** Someone can sign a victim in to
   the attacker's own account (login CSRF); a victim who then types a code would prove their
   address onto the attacker's account.
4. **Pass the address it means to verify.** An `email` taken from the form lets a signed-in user
   attach any address they receive mail at as a new sign-in method. An app that means "verify the
   address on file" passes the address of the user's key instead.

**Asking again never buys more guesses.** A new code replaces a live one and keeps its guess counter.
A code is 6 random bytes (8 base64url characters, case-sensitive), valid 10 minutes and for 5
guesses by default; surrounding whitespace in the typed code is ignored. The stored hash binds the
address, so one digest never stands for the same code at two addresses.

**A deleted owner is refused before any key is written.** When the address's owner is
soft-deleted, `verifyCode` answers `account-deleted` and adds or proves no key, whichever method the
owner signed in with.

**The same answer with or without an account.** `requestCode` issues a code for every address
`normalizeEmail` accepts and refuses nothing else. `sendCode` receives the normalised address; if it
rejects, the rejection reaches the caller and the code is already issued.

### What it does not do

- **It does not rate-limit, and that is the caller's job.** It limits guesses per code, not how often
  a code is asked for, and every new code moves the expiry of a locked challenge. Put
  `createRateLimitMiddleware` from `@spy4x/platform/rate-limit` in front of the `requestCode` route
  with two limiters, one keyed by the normalised address and one by `clientIp`, and in front of the
  `verifyCode` and `proveAddress` routes keyed by `clientIp`. The guess counter is per address and
  shared by `verifyCode` and `proveAddress`. No limiter is built in: the client address exists only in
  the HTTP layer, and a built-in one would force a choice of store into the provider.
- **It does not retry a race.** When another sign-in for the same address writes between the lookup
  and the write, `verifyCode` throws the store's `AuthConflictError`; the code is used by then, and a
  new code succeeds. The same error is thrown on every verification when an email-code key for the
  address that the owner does not hold carries no `email`, because the proven write cannot evict
  it. This provider never writes such a key.
- **It does not write the mail.** Sender, text and transport are the app's, inside `sendCode`.

## `server/auth/oauth`

`createOAuthSignIn`, `OAuthSignInError`, `OAuthFailure`, `OAuthOutcome`, `OAuthProviderConfig`,
`OAuthProfile`, `pkceChallenge`, `MAX_PENDING_OAUTH_FLOWS`, and the option, input and result
interfaces. Google's configuration is `@spy4x/server/auth/oauth-google`:
`createGoogleOAuthProvider`, `readGoogleProfile` and Google's endpoint and default-scope constants.

OAuth2 sign-in with any provider that has a user-info endpoint (#57). The provider is configuration,
not an enum: an `id` (lower-case letters, digits and `-`, 1 to 58 characters), the client
credentials, three `https:` endpoints, scopes, and a `profile(body)` function that reads the
user-info answer. Refusals are `OAuthSignInError`s with a `reason`.

```ts
import { createOAuthSignIn } from "@spy4x/server/auth/oauth"
import { createGoogleOAuthProvider } from "@spy4x/server/auth/oauth-google"

const google = createOAuthSignIn({
  store,
  sessions,
  redirectUri: "https://app.example.com/auth/google/callback",
  provider: createGoogleOAuthProvider({
    clientId: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
  }),
})

const { url, state } = await google.authorizationUrl() // keep `state` in an HttpOnly cookie
// …in the callback route:
const result = await google.handleCallback({ query: callbackUrl.searchParams, browserState })
```

### What it does

**A person is matched by the provider's `sub`, never by email.** The key's method is
`oauth:<provider id>` and its subject is the `sub`. `handleCallback` resolves the person in this
order, and reports which in `result.outcome`:

1. A key with this `sub` exists: its user signs in (`SignedIn`), whatever the address says now.
2. The provider vouches for the address (`emailVerified`) and a user owns it proven: a proven key is
   added to that user (`Linked`). This is the only way an address links accounts.
3. The provider vouches for the address and nobody owns it: a new user with a proven key
   (`SignedUp`), which deletes every other user's unproven claim to the address.
4. Otherwise: a new user whose key carries no address and is unproven (`SignedUp`).

An address the provider does not vouch for is not stored on the key at all; the app still sees it
in `result.profile`. A deleted user is refused as `user-deleted`, both on sign-in and as a link
target. When a parallel callback or a proof changes what the resolution read, it reads again once; a
second conflict is thrown. `readGoogleProfile` counts only the boolean `email_verified: true`, with
an address present, as vouched for.

**PKCE and a single-use, expiring `state`.** `authorizationUrl()` makes a 256-bit `state` and a
256-bit verifier and sends the S256 challenge. The flow lives 600 seconds by default
(`flowTtlSeconds`). `handleCallback` needs `browserState`, the `state` the app kept in the browser
that started the flow, and compares it with the query's in constant time, so a flow cannot be
completed in another browser. As soon as the callback names a `state`, its flow is removed: before
the browser check, the expiry check and both provider requests, so a failed callback cannot be
retried with the same `state`.

**`disconnect(userId, keyId)` deletes one key.** Only when the key exists, belongs to `userId`, and
has this provider's method; any other id returns `false` and deletes nothing. On the Postgres store
the key's sessions end with it, through the cascade.

**The provider requests are bounded.** Endpoints must be `https:`. The client secret goes in the
token request's form body. Each request has a 10-second limit by default (`timeoutMs`), and a token
answer whose `token_type` is present and not `bearer` is refused. The redirect URI is sent exactly
as given, because providers compare it character by character.

### What it does not do

- **It does not share pending flows between processes.** They live in memory inside the object
  `createOAuthSignIn` returns, at most `MAX_PENDING_OAUTH_FLOWS` (10 000; expired flows are dropped
  first, then the oldest). A callback must reach the process that built its authorization URL, so an
  app with more than one process needs sticky routing for the callback. A pluggable flow store is
  tracked in #150, after 1.0.
- **It does not verify an ID token or send a `nonce`.** The profile comes from the user-info
  endpoint, called with the access token the token endpoint returned over TLS.
- **It does not update a key's address** when the provider later reports a different one.
- **It does not connect a provider to the signed-in user.** Only sign-in, sign-up and linking by a
  vouched-for address.
- **It does not refuse to disconnect a user's last key.** The app decides whether that is allowed.

## `server/crypto`

`CryptoService`, `CryptoError`, `CryptoErrorCode`, `SecretCipher`, `maskKey`, `isHexKey`,
`AES_ALGORITHM`, `AES_KEY_BYTES`, `KEY_BITS`, `IV_LENGTH`, `HEX_KEY_LENGTH`, `DEFAULT_MASK_VISIBLE`,
`MAX_MASK_VISIBLE`, `MASK_VISIBLE_DIVISOR`, `MASK_LENGTH`.

The scheme is `template/libs/server/crypto`'s, folded in unchanged: AES-256-GCM, the key derived as
`SHA-256(utf8(secret))`, a 12-byte IV per call, wire format standard base64 of `[IV][ciphertext+tag]`
— so a ciphertext written by that module stays readable. `CryptoService.fromHexKey` is the second
entry point: 64 hex characters are decoded and imported as the 32 raw key bytes, never hashed, so the
two constructors produce different keys for the same characters. AES-128 (32 hex characters) is
rejected with `CryptoErrorCode.InvalidHexKey`.

**Prefer `fromHexKey` with 32 random bytes** — `encodeHex(crypto.getRandomValues(new Uint8Array(32)))`
— over a passphrase. The passphrase path is one SHA-256 pass, which is a derivation and not a key
derivation function: it inherits whatever guessing resistance the passphrase has, and a passphrase
reused as, say, a password pepper weakens both. A random 32-byte key has none of those questions.

**The secret is not a property of the service.** It is read by the constructor, closed over by the
key derivation, and unreachable afterwards, so `JSON.stringify`, `Deno.inspect` (with `showHidden`
too), `Object.keys` and `structuredClone` of an instance show nothing. Logging a service object, or
an object holding one, cannot print the key.

**`encrypt(plaintext, context?)` binds a ciphertext to where it is stored.** The context is passed to
AES-GCM as additional authenticated data: it is not stored, cannot be recovered from the blob, and
the same string has to be supplied to `decrypt`. A wrong context fails exactly as a wrong key does,
with `CryptoErrorCode.DecryptionFailed`. Passing no context produces the byte-identical format the
template's module reads, so the format is unchanged for anything written before this existed.

**`maskKey` is a display hint, not a shortened key.** Every non-empty hint is `MASK_LENGTH` code
points wide whatever the key's length, and it shows at most `MAX_MASK_VISIBLE` trailing code points
and at most one per `MASK_VISIBLE_DIVISOR` code points of the key — so an eight-character key shows
two characters, and a 400-character one still shows four. The `visible` argument is a request that
those two ceilings override; a caller cannot widen a hint into something usable.

**Deliberately not added:** a key version byte and a stronger passphrase derivation. Both change the
stored format or the key, and both would break the promise that this module and
`template/libs/server/crypto` read each other's values. A deployment that wants a derivation with a
work factor should use `fromHexKey` with a key its own key management produced.

## `server/user-secrets`

`createUserSecretStore`, `UserSecretError`, `UserSecretErrorCode`, `UserSecretPort`,
`StoredUserSecret`, `SaveUserSecretInput`, `UserSecretSummary`, `UserSecretStoreOptions`,
`PROVIDER_PATTERN`, `MIN_API_KEY_LENGTH`, `MAX_API_KEY_LENGTH`, `MAX_PROVIDER_LENGTH`.

The BYOK pattern: validate → `cipher.encrypt` at rest → keep `maskKey`'s hint → upsert per
`(user, provider)` → delete, with persistence behind an injected `UserSecretPort` (no SQL, no driver)
and the cipher behind `SecretCipher`. `save` returns a summary, `list` returns summaries only — the
ciphertext has no field to travel in — and `openSecret` is the single call that yields a plaintext,
for the outbound provider request. The port's `upsert` contract is the source's
`ON CONFLICT (user_id, provider) DO UPDATE`: replace the secret and hint, force `isActive`, bump
`updatedAt`, preserve `createdAt`. Neither the cipher nor the mask is re-implemented here; both come
from `server/crypto.ts`.

**A base URL is an outbound destination, so it is checked like one.** A non-empty `baseUrl` must be
an absolute `http:`/`https:` URL with no user name or password and no control characters — the
store's own rules, which run first and always — and then passes `validatePublicUrl` from
`@spy4x/net/url-policy`, which resolves the host and refuses loopback, link-local (including the
cloud metadata address `169.254.169.254`), private and special-use destinations. The store keeps its
own constant `baseUrl is invalid` message for every rejection: the guard's message names the
resolver's failure and the address family it disliked, which is information about the installation's
network. The absolute-URL check is first on purpose, because the guard completes a missing scheme
with `https://` and would otherwise accept a half-written `api.example.com/v1`.

```ts
const store = createUserSecretStore({
  port,
  cipher: CryptoService.fromHexKey(hexKey),
  resolver: defaultResolver, // injected: a test without --allow-net supplies its own
  allowInternalBaseUrl: false, // the default; true only where localhost is a real endpoint
})
```

`allowInternalBaseUrl` exists because a self-hosted model server on `http://localhost:11434/v1` is a
real configuration. Only the literal `true` turns it on, so a config value that arrives as
`undefined` cannot flip the default. With it on there is no SSRF guard for this field at all — the
guard has no switch for "internal but not everything" — and only the store's own rules apply;
`https://user:pw@localhost/v1` is still refused.

**Checking at save time does not make the call safe.** A host name that resolves to a public address
today can resolve to `127.0.0.1` tomorrow, and a stored URL is checked once. The outbound request
has to go through `safeFetch` from `@spy4x/net/safe-fetch`, which re-checks at connect time and
follows redirects under the same policy. A store that validates and then calls `fetch` directly is
still vulnerable.

**Every row the port returns is checked against what was asked for.** `openSecret`, `list` and
`save`'s re-read refuse a row whose `userId` or `provider` differs, with
`UserSecretErrorCode.RowMismatch`, rather than decrypting it. The port is injected, so a mis-written
`WHERE` clause, a cache keyed on the provider alone or a test double that ignores its arguments all
produce somebody else's row, and the store does not rely on a check it cannot see.

**Every secret is bound to its row.** The store passes
`user-secret:v1:<len>:<userId>:<len>:<provider>` — length-prefixed, so no two pairs encode the same
way — as the cipher's context, which AES-GCM authenticates. A ciphertext copied into another user's
row, or into another provider's, no longer opens. **Values stored before this change cannot be
opened**, because they carry no bound context; no project uses this store yet, so there is nothing
to migrate.

## `server/quota`

`createQuotaMeter`, `quotaKey`, `sessionPoolKey`, `quotaStatusCode`, `resolveQuotaPrincipal`,
`SESSION_POOL_PRINCIPAL`, `QuotaError`, `QuotaErrorCode`, `QuotaDecision`, `QuotaPrincipalKind`,
`QuotaPolicy`, `QuotaPrincipal`, `QuotaState`, `QuotaStore`, `QuotaReservation`, `QuotaKey`,
`QuotaMeter`, `QuotaMeterOptions`.

A countable budget per principal, decremented by units of _business work_: `reserve` (before the
work, the only gate), `release` (a refund when the work did not happen), `record` (after the work,
may overshoot), `check` and `get` (read-only). `QuotaDecision` maps to 200/429/503 through
`quotaStatusCode`; `Unavailable` is the service condition (the metered resource is not configured)
and is deliberately not the source's `limit === 0` sentinel, because 0 is also a legitimate disabled
budget. State lives in the injected `QuotaStore`, so two processes share one budget and a restart
cannot reset usage. The policy and the recorded count parse through arktype; the failures map to
constant messages, because an arktype summary echoes the value.

**`check` is for display only.** It reads a counter and returns; between that answer and the work,
any number of other requests spend the same budget. With a limit of one and ten parallel callers,
all ten are told they may proceed. `reserve` is the gate, because the decision and the spend are one
store operation:

```ts
// The same options on both calls: a request that brought its own key reserved
// nothing, and refunding it would hand out a unit that was never taken.
const metering = { hasOwnKey: callerKey !== undefined }

const state = await meter.reserve(principal, 1, metering)
if (state.decision !== QuotaDecision.Allowed) return respond(quotaStatusCode(state.decision), state)
try {
  await doTheWork()
} catch (error) {
  // `reservedAt` keys the refund by the window the reservation was taken
  // from, not whatever window the clock is in when the refund runs.
  await meter.release(principal, 1, { ...metering, reservedAt: state.reservedAt })
  throw error
}
```

**A refund is not idempotent, and a `release` that threw must not be retried for a session
principal, or for any principal when `reservedAt` is given.** Releasing the same reservation twice
gives the units back twice; only a counter already at zero absorbs the second one, because a store
never goes below zero. For a session principal a release is two store calls — the principal's own
counter first, then the shared pool — so after one of them has failed the other has already been
refunded, and a retry gives that refund a second time. The caller cannot tell which of the two calls
failed, so it cannot tell which counter a retry would double-refund: if the own-counter call failed
nothing was refunded and a retry is exact; if the pool call failed the own counter was already
refunded and a retry refunds it again, over-crediting the caller's own counter (absorbed at zero once
it gets there). With `reservedAt`, `release` makes a third store call — a read of the current
window's state — after both refunds have landed; if that read throws, both counters were already
refunded, and a retry refunds both again, the pool included. The own counter is refunded first so
that a failure part-way through the refund pair leaves the pool holding a unit that nothing holds any
more: short rather than over-credited, and cleared when the window rolls — that ordering says nothing
about the third call, which runs after both refunds regardless of `reservedAt`.

A `release` keys by the window the clock is in when it runs, unless the caller passes `reservedAt` —
the clock reading `reserve` used, carried on the `QuotaState` `reserve` returned — in which case it
keys the refund by that reading instead. Without `reservedAt`, work that outlives a window boundary
is refunded against the new window, and the old one keeps the unit until it rolls: the unit moves
between windows and the total across the two is unchanged. Pass `reservedAt` through (the documented
pattern above does), keep a unit of work shorter than the window, or use a lifetime window, to avoid
this. A `reservedAt` that is not a non-negative integer throws `InvalidReservedAt`; one later than
`release`'s own clock reading is clamped to that reading rather than refused, because a wall clock
can step backward between the two calls (an NTP correction, a second host) and a value that only
looks like it is from the future is still a real reservation.

**A real store makes `reserve` one statement.** The in-memory store in the tests is atomic because
nothing is awaited between its read and its write; a SQL store buys the same property with a
conditional update, and anything that reads, awaits and then writes is not a correct implementation:

```sql
-- reserve(key, count, limit)
UPDATE quota SET used = used + $count
 WHERE principal = $principal AND window = $window AND used + $count <= $limit
 RETURNING used;                      -- a row means granted; no row means refused
-- refused: report the counter as it stands
SELECT used FROM quota WHERE principal = $principal AND window = $window;
-- release(key, count) — never below zero, or a refund would hand out budget
UPDATE quota SET used = GREATEST(used - $count, 0)
 WHERE principal = $principal AND window = $window
 RETURNING used;
```

An upsert-shaped store writes the same reservation as
`INSERT … ON CONFLICT (principal, window) DO UPDATE SET used = quota.used + $count WHERE quota.used + $count <= $limit`.

**Anonymous callers share one pool.** A session id is chosen by the caller, so a per-session counter
bounds nothing on its own — rotating the id gives a fresh budget every request.
`QuotaPolicy.sessions` is the one place that allows session principals at all, and it carries the
budget all of them share:

```ts
createQuotaMeter({
  policy: { limit: 3, sessions: { poolLimit: 200 } }, // omit `sessions` to refuse anonymous callers
  store,
  meteredResourceAvailable: true,
})
```

A session principal spends the pool first and then its own counter; the pool unit is given back both
when the own counter refuses and when the store throws instead of answering. The two counters are
not one atomic step, so for the length of one store round trip the pool can hold a unit no work
spent, which can refuse another session that would just have fit. Nothing can over-_spend_ in either
order, and the refund closes that window. What the refund cannot close is a process that dies
between the two calls: the pool then keeps the unit until the window rolls, and a lifetime window
never rolls. A budget that has to survive that needs reservations stored with an expiry, which this
port deliberately does not have. A session id must still be issued and verified by the server — a
signed cookie, a server-side session record. The pool bounds what an unverified id can cost; it does
not make the id trustworthy.

**This is not a rate limiter.** A quota counts business work in a long window, keyed by principal,
enforced at the costly action _after_ authentication; a rate limiter counts requests per second,
keyed by whatever is cheap and not attacker-controlled, and runs as middleware before routing. `429`
here means "this principal has spent their budget", never "you are going too fast". Request
smoothing is `platform/rate-limit` (issue #4), which does not live here.

### Fixes applied at extraction time (`server/crypto`, `server/user-secrets`, `server/quota`)

| Source                                         | Bug                                                                   | Pinned by                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `offer-lens/libs/encrypt/mod.ts:13-18`         | a 16-byte AES-128 key was accepted next to AES-256                    | `fromHexKey rejects a 32-hex-character AES-128 key`                                 |
| `offer-lens/libs/scraper/mod.ts:132`           | failures classified with `msg.includes("abort")`                      | `reports DecryptionFailed for any cipher rejection, classified by type not message` |
| `offer-lens/apps/api/routes/keys.ts:93,133`    | the provider name and a raw `err.message` were echoed into a response | `never echoes the apiKey in a validation message`                                   |
| `offer-lens/apps/api/services/auth.ts:157-164` | the per-user quota used a different limit from the session quota      | `check: a limit of 0 is a disabled budget, not an error` + the window tests         |

### Fixes applied after extraction (issue #60)

Found by an audit of the extracted code, not inherited from a source.

| Bug                                                                              | Pinned by                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| the cipher kept its key in an enumerable field, so logging the object printed it | `crypto: an instance shows no key material when printed, listed or copied`    |
| a hint could show almost the whole key, and always its length                    | `maskKey: shows at most a quarter of the key and never more than the maximum` |
| check-then-record let parallel callers overspend one budget                      | `reserve: ten parallel callers of a budget of three run the work three times` |
| a rotating session id never reached any limit                                    | `sessions: a rotating session id stops at the shared pool limit`              |
| a user could store an internal address as the outbound base URL                  | `refuses an internal base URL by default`                                     |
| a row was decrypted without checking whose it was                                | `refuses to open a row that belongs to another user`                          |
| a ciphertext copied into another row still opened                                | `does not open a real ciphertext that was copied into another row`            |

## `server/db`

Two adapters, one migration runner. `@spy4x/server/db` is the barrel; `db/migrate`,
`db/postgres` and `db/sqlite` are the subpaths. Nothing here ships a driver: `postgres` is pinned in
the root import map and the SQLite driver is the caller's own, passed through `SqliteDriver`.

### A deferred constraint's failure at implicit commit is not reported on a single statement

**Do not declare a `DEFERRABLE INITIALLY DEFERRED` constraint and write to it through anything but
`sql.begin`** (#134). The pinned driver, `postgres@3.4.7`, resolves a single statement's promise
from the server's `CommandComplete` message, which arrives _before_ the implicit commit that
actually checks a deferred constraint. When that commit then fails, the `ErrorResponse` it carries
arrives on a query the driver has already resolved and cleared, so it has nothing left to reject —
the promise reports success (`count: 1`, any `RETURNING` row returned) and the write is not there.
No exception is thrown and no `unhandledrejection` fires: this is not a caught-and-swallowed error,
the failure never reaches a handler at all.

This is not only the tagged-template path. `sql.unsafe(text, params)` — any call that passes a
non-empty parameter list — takes the same extended-protocol route and loses the failure the same
way; only a _parameterless_ `sql.unsafe(text)` (no second argument, or `sql.unsafe(text, [])`) is
safe, because the driver takes the simple-protocol path (which resolves after the server's own
commit) only when it is not asked to bind parameters (`postgres@3.4.7/src/index.js`, `unsafe`:
`simple: 'simple' in options ? options.simple : args.length === 0`). `sql.begin` is the one path
that is always safe, parameters or not — not because a statement _inside_ it resolves any
differently (it still resolves early, the same way a bare tagged-template statement does), but
because `sql.begin` sends an explicit `COMMIT` as its own statement and rejects its own returned
promise when that commit fails; a caller awaits `sql.begin`'s promise, not the inner statement's,
so the inner statement resolving on its own does not matter — use it for a write against a
deferred constraint instead of a bare statement, parameterised or not.

Nothing shipped in this repository declares a deferred constraint today, so no module here is
affected; it is documented and pinned because a caller of `@spy4x/server/db` might add one.
Reproduced and pinned to `postgres@3.4.7` by
`server/db/postgres.integration.test.ts`, which fails loudly — not silently skips — the day an
upstream fix changes this. Reported upstream:
[porsager/postgres#1117](https://github.com/porsager/postgres/issues/1117).

### A transaction handle stops working when its transaction ends

Both adapters hand a callback a handle scoped to the transaction — a `SqliteDb` on one side, a
`DbServiceBase` clone on the other — and both retire it when the transaction returns, on the
rollback path as well as the commit path. A service that stores it (`this.db = tx`) and writes
through it later gets `SqliteScopeEndedError` or `PostgresScopeEndedError` instead of a write that
lands in whatever transaction that connection is running next and disappears with that
transaction's rollback. The Postgres refusal is thrown rather than rejected, because the check sits
on the executor, which the driver also calls synchronously (`sql(table)`); a method declared `async`
turns it into the rejection its caller expects.

**What the Postgres guard promises.** A clone kept past `begin()` or past a nested `begin()` refuses,
with `PostgresScopeEndedError`, every call form a person would write through it: the tagged template,
the `sql(...)` helper forms, `unsafe`, `file`, `json`, `array`, `types` and `typed`, `savepoint`,
`notify`, `prepare`, `new`, the service's own nested `begin()`, and anything read off the handle at
any depth. A transaction handle has no `begin`, `reserve` or `listen` of its own; those throw a
`TypeError`, live and retired alike. The executor is a
`Proxy` and everything it hands out on a _read_ is itself a wrapper — functions and objects alike,
recursively — which is why the refusal covers helpers nobody listed. `prototype.constructor` was the
spelling that showed why a list is not enough, since every ordinary function carries a `prototype`
object whose `constructor` is that function. What a _call_ returns is handed back untouched, because
the driver recognises a fragment, a `json` or `array` value or a query object by its class, and a
wrapper would not be one.

**Two moments other than a call through the clone are checked too** (#108), because a call through
the clone is not the only way a statement reaches the transaction's connection.

A `postgres` query is lazy: nothing is sent when it is built, and `then`, `catch`, `finally`,
`execute` and `forEach` all reach the query's `handle()`, which is where the statement goes on the
connection. So a query built inside the callback and awaited after `begin()` has returned used to run
inside whatever transaction that connection held by then and vanish with its rollback — a forgotten
`await` is enough to write it. The guard now sits on the query's own `handle` as well: the first send
after the scope has ended is refused. Awaiting a query that already ran inside the callback sends
nothing and is not refused. `handle` is not documented driver API, which is why an integration test
awaits such a query and expects the error — a driver that renamed the method turns that test red
instead of reopening the route in silence.

`sql.savepoint(fn)` calls `fn` with a handle the driver built and passed in, so that handle never
went through the wrapper. The callback now receives a scoped handle instead, retired when the
savepoint returns.

**It is a guard against a mistake, not a security boundary.** The mistake is the one #96 describes: a
service stores the clone (`this.db = tx`) and writes through it after the transaction has returned,
or forgets an `await` on a query it built inside the callback. Code that goes looking for the
driver's internals is not making that mistake and could in any case import `postgres` and open a
connection of its own.

One known route remains, recorded on #108. The driver's own internals ride on a value a call
_returned_ — for example `new q.constructor(…, q.handler, …)`, since every query object holds the
transaction's execute function. Return values are deliberately not wrapped, so this one cannot be
closed by wrapping reads, and it is not the mistake the guard is for.

`SqliteDb.close()` goes through the same gate: it waits for an open transaction rather than closing
the connection under it, and a scoped handle cannot close a connection it never owned. Two `close()`
calls issued together share one close and both return, so a shutdown handler that fires twice is
still harmless.

### Migrations: one runner at a time, and no editing what has run

`runMigrations` does the whole run — create the history table, read the applied set, apply
everything — inside `MigrationDriver.withLock`. Locking one migration at a time would not help: the
race is between the two runners' _reads_ of the history, not between their writes.

| Adapter  | What the lock is                                                          | What it covers                                              |
| -------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Postgres | `pg_try_advisory_lock` on the connection `sql.reserve()` pins for the run | every runner that reaches that history table once it exists |
| SQLite   | a queue per handle and history table                                      | every runner sharing one `SqliteDb`, and no wider           |

The Postgres lock is held on the connection the migrations themselves run on, because a session lock
protects the session it was taken on and nothing else. Its key follows the table as the _server_
resolves the name — quoted, so a name with a capital letter is found rather than folded away — not
as the caller spelled it, so a driver given `schema: "app"` and a driver that reaches an existing
`app.migrations` through its search path lock each other out. A runner that dies releases it when its
connection closes, so there is no stale lock to clear by hand.

**The driver works on a client built with any column-name transform** (`postgres.camel`,
`postgres.pascal`, `postgres.kebab`, or a custom `transform.column.from`, including one that maps
two different columns to the same name) — `#137`. Every probe this driver runs (the lock check, the
schema resolution, the history-table existence check, the applied-migrations read) is read through
`.values()`, not by the name written in the query: the driver builds a `.values()` row as a plain
array in `SELECT` order and never keys it by a column's (possibly transformed) name at all
(`postgres@3.4.7/src/query.js`, `src/connection.js`), so no column-name transform can affect it,
however it rewrites — or collides — names. Before this, every one of these reads went by name,
which broke under `postgres.pascal` (it upper-cases a column's first letter regardless of case or
underscores; the lock probe read `undefined` where it expected `locked`, so a run never took the
lock and failed with `PostgresMigrationLockError` as though another runner held it, although none
did) and, separately, would have silently misread a history row under any transform that mapped two
of these columns to the same name. A row that is not shaped the way a query expects — a
`transform.row.from` that restructures it, rather than merely relabelling its columns — is refused
with `PostgresUnexpectedRowError` naming the query and what came back, instead of being read
positionally anyway and misreported as something else.

**The wait is bounded** (#109). A second runner retries `pg_try_advisory_lock` every
`lockRetryMs` (250 ms by default) and gives up after `lockWaitMs` — one minute by default — with
`PostgresMigrationLockError`, having applied nothing. Raise `lockWaitMs` when the slowest honest run
in the deployment is longer than that. When it is hit, find the holder: `SELECT * FROM pg_locks WHERE
locktype = 'advisory'` names the backend and `pg_stat_activity` says what it is running. A holder
that is genuinely still migrating needs a longer bound behind it; a holder that is stuck needs
dealing with, and killing its backend releases the lock with its session. `lockWaitMs` counts the
time spent waiting between attempts, not the round trips, which is what lets a test of the bound
inject a delay and finish at once. Before this, the lock was `pg_advisory_lock`, which waits for
ever: one stuck runner stopped every other instance from starting and the deployment hung with
nothing in the log.

**Two runs on one `PostgresMigrationDriver` object** are refused with
`PostgresMigrationRunInProgressError` rather than deadlocking. The object points itself at the
connection a run reserved, so the second run used to send its statements on the first run's
connection, both held a lock, and the process hung until it was killed. Two concurrent runs are two
driver objects, which is also what two application instances are.

**A client built with `fetch_types: false` works, not refused** (#156). `withLock` reserves a
connection with `sql.reserve()`, and on a pool with no idle connection yet — the ordinary case at the
start of a run — `postgres@3.4.7` has a bug that leaves that call unresolved forever: `ReadyForQuery`
only hands a freshly opened connection back to a pending `reserve()` through the branch that also
fetches the driver's array-type OIDs, and `fetch_types: false` skips that branch, so the connection is
never matched to the reserve call and the run hangs with no error and no log line — reported upstream
as [porsager/postgres#1219](https://github.com/porsager/postgres/issues/1219); a proposed fix is open
in [#1220](https://github.com/porsager/postgres/pull/1220) and in no release. `withReservedLock` works
around it with a plain query on the pool before `reserve()`, which always completes and leaves a
connection sitting idle, so the `reserve()` right after it takes the pool's synchronous already-idle
path instead of the one that hangs. One race is not closed by this: if the warm-up connection's ready
message arrives late or another caller on the pool takes it first, `reserve()` opens a second
connection that hits the same bug and stays stuck until its `max_lifetime` ends it (30 to 60 minutes
by default, or until the pool ends when `max_lifetime` is off), leaving the pool one connection short
meanwhile. See that method's doc comment in `postgres-migrate.ts` for the exact lines, and
`postgres-migrate.integration.test.ts`'s "against a client built with fetch_types: false" test for the
reproduction.

**A connection lost mid-run is not a catchable error**, and it cannot be made one from here. The
server releases the advisory lock when the session ends and the run does not continue, so nothing is
applied twice; what the caller sees is an uncaught `TypeError: Cannot read properties of null
(reading 'write')` raised from inside `postgres@3.4.7/src/connection.js:250` on a timer the driver
owns, not a rejected promise. Written down rather than dressed up.

**Every runner of one history table must share a `search_path` or pass the same `schema`.** The key
is resolved before the lock is taken, and on a first run there is no table to resolve, so each runner
answers with its own `current_schema()`. Two runners whose search paths start with different schemas,
both started before the table exists, take two keys; if the second one's existence probe then finds
the table the first has just created, they work on one table under two locks. That is a
misconfiguration rather than a race the library can settle, and it is the one case the resolved key
does not cover.

The SQLite queue is narrower, and the difference matters. It is held per `SqliteDb`, so two runners
given the same handle are serialised and two handles opened on the same file are not — measured,
that pair still ran a `.no_transaction` body twice, in one process as much as in two. SQLite has no
advisory locks and its own locks end with the transaction that took them, so nothing here spans a
run. What its single-writer lock does still give, between any two handles, is that a _transactional_
migration cannot be applied twice: the loser's whole transaction, migration and history row
together, rolls back. A `.no_transaction` migration has no such protection.

**A cross-process SQLite lock is deliberately not built** (#110). The design that would work is an
operating-system file lock on a sibling file (`<database>.migrate.lock`, `Deno.FsFile.lock()`), which
the kernel releases when the process dies and so has no stale-lock problem. It is not built because
it needs write permission next to the database, does not apply to `:memory:`, and no project this
library serves runs two processes against one SQLite file — a SQLite deployment here is one process
with Litestream behind it. The rule until one does: one handle per database in a process, and one
process running migrations at a time.

### Migrations: drift between the folder and the history

Every run hashes each migration file and compares it with the SHA-256 the history row carries, and
**the whole plan is checked before anything is applied**. A file edited after it was applied stops
the run with `MigrationEditedError`, instead of being skipped in silence and leaving the edit
unapplied everywhere. A row written before checksums existed carries `null` and is not checked,
because back-filling it from the file in front of the runner would record the current file as the one
that ran. The cost is that a run reads every migration from disk, not only the pending ones.

Three neighbouring kinds of drift used to pass without a word (#110):

| Drift                                   | Now                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------- |
| a new file sorts before an edited one   | nothing is applied; the plan is checked first, so the run is refused whole |
| an applied migration's file was deleted | reported in `MigrationReport.missing`, oldest row first                    |
| an applied migration's file was renamed | `MigrationRenamedError` instead of running its body a second time          |

A deleted file is reported rather than refused, because squashing old migrations away is legitimate
and there is no opt-out for a refusal yet; a caller that wants a run to stop on one checks the
`missing` list itself. A rename is recognised by checksum, and only against a history row that has no
file of its own — a pending file sharing its body with a migration whose file is still on disk is a
copy, not a rename, and two honestly identical bodies must still be allowed. A migration that really
is new and really does repeat a deleted one's body needs a body of its own; a comment naming what it
is for is enough.

The history table gains its `checksum` column on the next run whether it is new or already there, so
an existing deployment upgrades without a manual step.

### Purging

`purgeDatabase` refuses unless `ENV` names one of `SAFE_ENV_VALUES` — `dev`, `development`, `local`,
`test`, `ci`, compared trimmed and lower-cased — or the caller passes `--prod`. The list is frozen:
`readonly` is a compile-time claim, and a consumer that cast the array and pushed onto it would arm
the purge for that environment process-wide.

Like the migration driver, the table listing it purges from is read through `.values()`, not by the
`tablename` alias written in the query, so it survives any column-name transform the caller's client
carries — including a custom one that maps two different columns to the same name (`#137`).

## `server/sign-in`

The building blocks a sign-in method stands on, extracted from the template's API (#75). Entry point:
`sign-in/mod.ts`. Nothing here imports from `server/auth/`.

| File            | What it is                                                                          |
| --------------- | ----------------------------------------------------------------------------------- |
| `session.ts`    | `SessionManager` over an app-supplied `SessionStore`: create, validate, sign out    |
| `cookie.ts`     | `SessionCookie`: the signed `HttpOnly` session cookie and a readable user-id cookie |
| `middleware.ts` | `createAuth`: Hono `parseAuth`, the guards, `startSession` and `endSession`         |
| `password.ts`   | `createPasswordHasher`: PBKDF2-HMAC-SHA-256 with a pepper, parameters in the value  |
| `totp.ts`       | Authenticator-app codes: random secret, enrolment URI and QR code, `verifyTotp`     |

### What it does

**Sessions live in the app's database.** The app implements `SessionStore`: seven operations, and
an optional eighth, `clearPendingSecondFactors`. `SessionRecord` holds only what the session logic
reads (id, user id, token hash, status, second-factor state, expiry); an app's own columns ride along
through the type parameter. The store's writes (`extend`, `completeSecondFactor`,
`clearPendingSecondFactors`, the sign-outs, `expire`) must only touch a session whose status is
`Active`, each as a single conditional write, so a concurrent sign-out is never undone. The library
cannot check that; the interface's comments state it for whoever implements it.

**The cookie value is `<id>:<token>`.** The token is 32 random bytes; the store keeps only its
HMAC-SHA-256 under the pepper, and the comparison is constant-time. The value is parsed by one exact
pattern: a positive integer without leading zeros, a colon, 43 base64url characters, nothing else.
The cookie is also signed with its own secret, so a value the server never issued is refused before
the store is asked.

**Expiry and extension.** A session is refused from the millisecond its `expiresAt` is reached. When
a request finds less than a quarter of the lifetime left, the session is extended to a full lifetime
and `parseAuth` sends the cookie again. An expired, signed-out or unknown-status session is never
extended. There is no cache: every request reads the store, so a sign-out takes effect on the next
request. A store that caches must drop or update its entry on every write the interface names.

**Guards fail closed.** `isAuthenticated1FA` needs a valid session. `isAuthenticated2FA` also needs
the second factor settled: `Completed`, or `NotRequired` for a user whose `hasSecondFactor` is false.
A `Pending` session stays refused after the user removes their second factor until the app calls
`sessions.clearPendingSecondFactors(userId)`. Call it right after removing the TOTP secret, in the
same transaction when there is one: `createPostgresSessionStore(tx).clearPendingSecondFactors(userId)`
inside the caller's `sql.begin` commits or rolls back with the secret's removal. It turns every
active `Pending` session of that user into `NotRequired` in one write, and leaves `Completed`,
signed-out and expired sessions as they are. On a store that does not implement it, the manager
throws a `TypeError` rather than leaving those sessions locked out without a sign.
`isAuthorized(check)` applies the same two rules and then answers 403 unless `check` returns `true`.
A route that never passed through `parseAuth` is refused by every guard.

**Passwords.** New hashes are `pbkdf2-sha256$<iterations>$<32 hex salt>$<64 hex key>`: 600 000
iterations by default (the OWASP figure for PBKDF2-HMAC-SHA-256), a 16-byte random salt, a 32-byte
key, and HMAC-SHA-256 of the password under the pepper as the PBKDF2 input. `verify` reads the
iteration count from the stored value and reports `needsRehash` when it is below the configured one.
Hashes in the template's `<salt>:<key>` format still verify, always with `needsRehash`, so an existing
database keeps working; hash the password again after such a sign-in. A stored value in neither exact
format is a mismatch, never an exception. Passwords over 1024 UTF-8 bytes are refused before any key
derivation.

**Authenticator-app codes.** SHA-1, six digits, 30-second steps, one step of tolerance either side:
the configuration every mainstream app supports. `verifyTotp` returns the time step it accepted; store
it per user with a conditional write (only if greater than the stored one), and pass it back as
`lastAcceptedStep`. A code for that step or an earlier one is refused, so one code signs in once.

### What it does not do

- **It does not limit guesses.** Six digits across three accepted steps is one chance in about 333 000
  per guess, and a password is only as strong as its user made it. Put `@spy4x/platform/rate-limit`
  in front of every route that checks a password or a code, keyed per account as well as per address.
- **It does not hide whether an account exists.** When the account is missing, the app should still
  spend the time of one `verify` (against a hash made once at start-up) before answering.
- **It does not send mail, sign users up, or talk to identity providers.** Those methods are #57's,
  built on this set.
- **It does not know about roles, groups or users.** `loadUser` and `hasSecondFactor` come from the
  app, and so does the check given to `isAuthorized`.
- **It does not use the `__Host-` cookie prefix by default.** Pass `name: "__Host-sessionIdToken"`
  in production: Hono then enforces `Secure`, `Path=/` and no `Domain`, and a sibling subdomain can
  no longer plant or shadow the cookie. (`secure: false` and a `__Host-` name cannot be combined;
  Hono throws.)
- **It does not rotate the session when the second factor completes.** Without rotation, a
  `Pending` session cookie planted in a victim's browser becomes fully signed in when the victim
  enters their code. To rotate, end the `Pending` session (`sessions.signOut(cookieValue)`) and
  start a new one with `secondFactor: Completed` instead of calling `completeSecondFactor`.
- **It does not give a `Pending` session its own deadline.** `validate` extends a session that
  still owes its second factor like any other, so someone holding only the password can keep one
  alive by polling a route that needs one factor. Such a session never passes the second-factor
  guard, but the app should give the second-factor step a deadline of its own.

## `server/request-log`

`requestLog`, `RequestLogOptions`, `RequestLogWriter`.

Ported from `template/apps/api/middlewares/log.ts` (byte-identical in `financy`; `gb` was not
reachable from this extraction environment, so it is not part of the comparison). The original
imported the app's own `APIContext` type and its `log` service directly — a library cannot import
either — so both become constructor arguments here: `write` (defaults to `console.log`) replaces
the app's `log` service, and the original's hardcoded `/api/health` skip becomes the `skipPaths`
option, because which path is a health check is the app's decision, not this middleware's.

**What is logged, checked.** Every line carries only the HTTP method, the request pathname, and —
on the outgoing line — the response status and elapsed time. The pathname comes from Hono's own
`c.req.path`, which stops at the first `?`, so a token or password passed as a query parameter
never reaches a log line through this middleware; no header and no request or response body is
read at all. The original had the same property already (it built its path with
`getPath(c.req.raw)`, which has the same behaviour) — nothing was leaking, and
`log.test.ts` now asserts it directly (`never logs the query string`, `does not read or log any
request header`) instead of leaving it incidental.

**Arrows: `<--` on the way in, `-->` on the way out**, matching both the source and Hono's own
built-in `hono/logger`. `log.test.ts` pins the direction by name (`logs incoming then outgoing, in
the source's own arrow direction`) instead of only checking each line's other fields.

**The color table's reach: checked, not assumed.** `c.res.status` is read as a plain property,
never checked against `instanceof Response`, so two paths reach the color table's edges without
needing a status the `Response` constructor itself would refuse: a handler that returns
`Response.error()` produces the network-error status `0` (checked: `app.get("/err", () =>
Response.error())` logs `<-- GET /err` then `--> GET /err 0 0ms`), and a handler that bypasses
Hono's own return type and hands back a plain object is logged by whatever `.status` that object
carries — `700`, in a check that returned `{ status: 700 } as unknown as Response`. Both are
asserted in `log.test.ts`. The color table carries entries for classes `0` and `7` for exactly this
reason, and falls back to the plain, uncolored status number for any class it does not carry, so
nothing here throws or prints the literal text `undefined` regardless of what a handler returns.

**Decisions.** `hono/utils/color` is not the internal it looks like: `./utils/*` is part of the
published `hono` package's own `exports` map (checked against the pinned `hono@4.13.8`'s
`package.json`), so this middleware is layered on hono's public surface, not reaching past it —
consistent with hono staying a kept dependency. This port reads Hono's own public `c.req.path`, not
`getPath(c.req.raw)`, so it imports `hono/utils/color` only — never `hono/utils/url`. Color output
is ported as-is (same classes, same codes) rather than dropped, since `getColorEnabled()` already
turns it off for a non-TTY or `NO_COLOR` environment, so nothing new needs deciding to keep it.

## `server/config`

`EnvReader`, `MissingEnvError`, `systemEnv`, `createEnvReader`, `readEnvVar`, `loadConfig`,
`ConfigError`, `stringBoolean`.

Six apps carry their own version of "read the environment into a config object" today — a class
whose fields are one `getEnvVar("NAME")` call apiece (`template/apps/api/services/config.ts`;
`financy`'s carries the same shape plus three Telegram-specific fields of its own — not identical,
just the same pattern), a type-cast (`as "dev" | "prod"`) standing in for a real check, and
`Number(getEnvVar(...))` silently accepting `NaN` for a malformed number. `loadConfig` replaces the
per-field calls with one arktype schema, validated once at start-up: every field is named once, its
shape is checked once, and a bad or missing value fails loudly instead of turning into `NaN` or an
unchecked cast three requests later.

`EnvReader`/`systemEnv`/`createEnvReader` are moved from this repository's own `ops/env.ts`, removed
from the tree in #67 (`git log --all --oneline -- ops/env.ts`), trimmed to the environment-reading
primitive — `absPath`, `substituteEnvVars` and `rewriteEnvValues` were `ops`-specific
deploy-templating helpers, not part of "environment to typed config", and are not ported.
`readEnvVar` is the small single-variable helper for the one value a caller needs before the rest of
its configuration can even be assembled (`ENV`, deciding which schema to validate against, for
example); `loadConfig` is the entry point for everything else.

**Bug fixed at extraction time.** The source's `systemEnv.get` returned a real blank environment
variable unchanged, while `createEnvReader` — the only path the source's own tests exercised —
folded a blank value to `undefined`. A variable that was genuinely blank in production therefore
behaved differently from the identical case under test. Both readers now normalise a blank value to
`undefined` at the same boundary, so "an empty string counts as missing" is one rule instead of two
inconsistent ones. This is also this module's answer to what an empty string means: a placeholder
that expanded to nothing (`${VAR}` with no value, a blank `.env` line) is indistinguishable from a
real empty string once it reaches the process environment, and treating it as present would let a
broken deploy script configure a service with `""` instead of failing at start-up.

**Scope: a flat schema.** `loadConfig(schema, env = systemEnv)` reads exactly the top-level keys an
arktype object schema declares — `type({ AUTH_PEPPER: "string", PORT: "string.integer.parse" })`
— as environment variable names, one level deep. It finds those keys through arktype's own
documented `Type.props` (`required`/`optional`/defaulted, each `{ key, kind, ... }` —
`arktype/out/variants/object.ts`'s object-type interface): `.props` stays correct through
`.describe()` and `.configure()`, and throws arktype's own `ParseError` on a union or a piped root,
which `loadConfig` wraps as `TypeError`. A schema whose `.props` comes back empty (an
index-signature-only schema such as `type({ "[/^APP_/]": "string" })`, which validates but names no
field) is refused the same way, rather than silently reading nothing. A nested object in the schema
is not read from nested environment variables — there is no such thing here.

**Numbers and booleans are strings until a morph says otherwise.** Every environment variable
arrives as `string | undefined`. arktype's own `"string.integer.parse"` and `"string.numeric.parse"`
cover the numeric cases. There is no built-in string-to-boolean morph, so this module exports
`stringBoolean`: exactly `"true"` or `"false"`, nothing else — a format that also accepted `"1"`,
`"yes"` or `"on"` is a format that will one day be typo'd into a fourth spelling that silently reads
as false instead of failing.

**A key is read only when it is not blank**, so `raw[name] = value` is skipped entirely rather than
set to `undefined`: arktype's own `exactOptionalPropertyTypes` distinguishes an object key that is
absent from one explicitly set to `undefined`, and would otherwise reject a genuinely-unset optional
variable as "must be a string, was undefined" instead of accepting its absence. The same omission is
also what lets a defaulted key (`PORT: "string.integer.parse = '3000'"` — required, not optional;
arktype's default syntax is its own way of saying "may be absent") fall back to its schema default
when the variable is absent.

**The failure never carries a value — for an arktype rejection.** arktype's own rejection text
echoes the offending input (`must be a well-formed integer string (was "admin")`), which is exactly
the kind of text a container orchestrator's log capture was never meant to hold a secret in.
`ConfigError.variables` lists only the top-level environment-variable names that failed, sorted;
nothing here reads arktype's `.message`, `.summary` or `.actual` for a value that reached
validation. That top-level restriction is deliberate: a failure inside a _parsed_ value — a JSON map
whose entries are checked one by one, say — puts the value's own keys deeper in arktype's path
(`API_TOKENS["sk_live_…"]`), so only `issue.path`'s first segment is used, and only when it is one
of the schema's own declared keys. A hand-set `ctx.reject({ path: [...] })` inside a `.narrow()`
could otherwise put anything at all in that first segment; the same restriction closes that route
too.

**A root-level check is reported by its own `expected` text, printed verbatim.** A cross-field rule
written with `.narrow()` (financy's "`TELEGRAM_WEBHOOK_URL` is required outside dev", checked across
two fields) fails at no single key, so arktype reports it at the root path, mapped here to the
issue's own `expected` text — never `actual`, which is the whole rejected object. Write it as a rule
(`TELEGRAM_WEBHOOK_URL is required outside dev`), never built from the value:
``ctx.mustBe(`shorter than ${value}`)`` would print the value. Reading `expected` is guarded: it is
a getter that throws for a rejection built with arktype's other documented style,
`ctx.reject({ message })` or `ctx.reject({ problem })`, so a thrown or empty `expected` falls back
to a fixed `(cross-field check)` label instead of crashing `loadConfig`.

**A morph that throws is not an arktype rejection, and cannot be scrubbed the same way.** A morph
written as a `.pipe` callback that throws its own `Error` (`bad ${value}`, say) escapes arktype's
own error path entirely — the thrown error's message can carry the value, and nothing here wrote
that message, so nothing here can safely rewrite it. `loadConfig` catches anything thrown while
validating and rethrows a `ConfigError` with an empty `variables` list and a generic message,
explicitly without keeping the original as `cause` — a `cause` is exactly a place for the original's
message, value included, to survive un-scrubbed onto the new error. A morph that needs to fail
without carrying its own value can report the variable by name instead: write it with `.pipe.try` or
`ctx.error` (both arktype's own), either of which reports through the normal rejection path above
rather than throwing.

```ts
import { type } from "arktype"
import { loadConfig, stringBoolean } from "@spy4x/server/config"

const configSchema = type({
  ENV: "'dev' | 'prod'",
  AUTH_PEPPER: "string > 0",
  PORT: "string.integer.parse",
  "FEATURE_FLAG?": stringBoolean,
})

// reads Deno.env; a test injects createEnvReader({...}) instead
export const config = loadConfig(configSchema)
```

## `server/kv`

`RedisKvStore`. A small wrapper over `@iuioiua/redis`'s `RedisClient`: `get`, `set` with a TTL,
`del`, `reset`, `close`. Extracted from `template/libs/server/kv/+index.ts` (#75); `financy`'s copy
differs from the template's by one import line (its own module alias for the cache interface) and
was not otherwise consulted.

**Structurally compatible with `ICacheStorage`.** `@spy4x/platform/cache`'s `ICacheStorage` (#125)
names `server/kv` in its own doc as the interface's Redis implementation, briefed against these exact
signatures: `get(key): Promise<string | null>`, `set(key, value: string, ttlSec): Promise<void>`,
`del(key): Promise<void>`, `reset(): Promise<void>`. This module does not import
`@spy4x/platform/cache` — the two were extracted in parallel and neither depends on the other's
branch — so the match is verified structurally: `deno check` accepts `const _: ICacheStorage = store`
and rejects a `{ get }`-only object with `TS2739`.

**Every key lives under a mandatory prefix, and `reset()` only touches that prefix.** The ported
original's `reset()` sent `FLUSHDB`, which deletes every key in the whole Redis database — another
application's keys, another test run's keys, everything. A shared library should not offer that.
`RedisKvStore.connect` takes a `keyPrefix` and refuses an empty one; every key is stored as
`<prefix>:<key>`, and `reset()` walks only that prefix with `SCAN`/`DEL` — `SCAN` rather than `KEYS`,
because `KEYS` blocks the whole server for the scan's duration on a large database, which is exactly
the kind of shared-resource risk the prefix scoping exists to avoid.

**A prefix is a string match, not a namespace hierarchy.** A store with prefix `app` also reads and
resets the keys of a store with prefix `app:sub`: `app` addresses its own key `sub:k` at
`app:sub:k`, which is exactly where `app:sub` addresses its key `k`. Choose prefixes that are not
one another's sub-string across the `:` separator, unless that overlap is intended.

**Fixed at extraction time**, all in `redis-kv-store.ts`:

| Bug                                                                                                                                                                                      | Pinned by                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset()` sent `FLUSHDB`, wiping the whole database                                                                                                                                      | `sets, gets, deletes and resets within its own prefix only`                                                                                                                                                                   |
| `reset()`'s `SCAN MATCH` pattern did not escape `*`, `?`, `[`, `]` or `\` in the prefix, so a prefix containing one of them matched other stores' keys                                   | `reset() escapes glob metacharacters in the prefix instead of matching them as a pattern`                                                                                                                                     |
| `get<T extends Reply>` let a caller cast an arbitrary type onto a `GET` reply                                                                                                            | `get` is typed `Promise<string \| null>`, matching the protocol                                                                                                                                                               |
| `set(key, value, ttlSec)` forwarded `ttlSec` straight to `SET … EX`, and Redis refuses a non-integer, zero, negative or infinite value with an opaque protocol error or a `NaN` argument | `rejects a ttlSec that is not a positive integer`                                                                                                                                                                             |
| `close()` called `Deno.Conn.close()` unconditionally, which throws `BadResource` on a connection already closed                                                                          | `close() is safe to call more than once`                                                                                                                                                                                      |
| every method called the client directly after `close()` or after the connection died, crashing the process with an uncaught `BadResource` instead of rejecting                           | `rejects instead of crashing after close()`; `get` after the connection is killed by `rejects instead of crashing once the connection is killed` and `rejects every call still queued at the moment the connection is killed` |

An ordinary error reply from Redis (`WRONGTYPE`, an out-of-memory refusal, `READONLY`, `BUSY`)
rejects that one call with `RedisError` from `@iuioiua/redis` and leaves the store usable; only a
failed read or write marks the connection dead. Pinned by
`keeps working after Redis answers one command with an error`.

`connect()` also dropped the ported original's `console.log("✅ Connected to KV")`: a library
primitive should not write to stdout on a caller's behalf. The caller decides whether connecting is
worth logging.

## `server/outbox`

`OutboxProcessor`, `OutboxEvent`, `OutboxPublisher`, `OutboxRepository`, `PostgresOutboxRepository`,
`LoggingOutboxPublisher`, `retryDelayMs`, `errorCodeOf`. Extracted from
`template/libs/server/outbox/+index.ts` (#75) — the template is the only source of an outbox in this
wave's source repositories.

A transactional outbox: a command writes an identity-only row (aggregate, version, kind — never a
payload) in the same transaction as its state change, and `OutboxProcessor.drainOnce`/`run` claim
committed rows and hand them to a publisher, rescheduling a failing row with exponential backoff
without blocking the rest of the batch. Consumers use a drained row to learn that something changed
and pull the authoritative state, which is what keeps the outbox itself out of the correctness path.

**The row this library defines is smaller than the template's.** The ported original's row also
carried `groupId` and `actorUserId` — the template's own data model, not something a generic outbox
needs to do its job. `OutboxEvent` here carries only `id`, `eventKind`, `aggregateType`,
`aggregateId`, `aggregateVersion` and `attemptCount`. A consumer that wants to route or filter on
more than the aggregate identity pulls the authoritative row instead, which is the pattern the module
exists to enforce.

**The retry delay reuses `@spy4x/integrations`'s backoff for its clamp, but keeps the source's own
numbers.** Issue #71 lists this doubling-and-capping formula as one of the duplicated retry helpers
in the codebase. `retryDelayMs` computes the uncapped delay exactly as the ported original did —
`Math.max(1, attemptCount)` before subtracting one for the exponent, and the same `exponent >= 32 ?
Infinity : …` guard, which matters when `baseMs` is `0`: without it, `0 * 2 ** exponent` is `0` for a
merely large exponent and `NaN` once the exponent overflows `2 ** exponent` to `Infinity` — then hands
that number to `createExponentialBackoff`'s own `(attempt, retryAfterMs)` form so the final
`Math.min`/`Math.max` clamp to `[0, maxDelayMs]` is not a second copy of that logic. `retryDelayMs(0,
…)`, a negative attempt and a fractional attempt all return the same delay the source gave for
attempt 1, matching the source rather than a shorter delay computed from a negative or fractional
exponent. No jitter: one worker holds a claimed row at a time via its lease, so there is nothing to
de-synchronise.

**`errorCodeOf` falls back to `"Error"` when `name` is not a string**, the same rule
`integrations/retry.ts`'s `readErrorName` follows. The ported original was `error.name || "Error"`
inside an `instanceof Error` branch: `error.name || "Error"` is truthy for any non-empty, non-zero
`name`, including a number, so an `Error` whose `name` was reassigned to something other than a
string reached `.slice(0, 64)` on that value and threw `TypeError: name.slice is not a function` — from
inside `OutboxProcessor.drainOnce`'s own `catch`, which meant one poisoned event stopped the whole
batch and never rescheduled that event either. A non-`Error` thrown value is still reported by
`typeof`, which returns one of a fixed, small set of strings and cannot carry arbitrary caller text.

**`PostgresOutboxRepository` aliases every returned column to its `OutboxEvent` field name in SQL,**
rather than relying on the caller's `Sql` having been created with a snake-to-camel row transform.
The template's own client set `transform: postgres.camel` globally, but `@spy4x/server/db`'s
`createSql` does not default to one — aliasing in the query itself means this repository's row shape
does not depend on how a caller configured their pool.

**Lease expiry can still double-deliver, and that is inherent, not a bug this repository closes.**
`FOR UPDATE SKIP LOCKED` only holds for the claiming statement; what actually keeps a claimed row
invisible is pushing `available_at` forward by the lease. A worker that dies mid-publish releases its
rows once the lease elapses rather than stranding them, but if the first worker's publish was still
in flight when the lease ran out, a second worker can deliver the same event. A publisher that cannot
tolerate a duplicate needs its own idempotency key; nothing on the SQL side removes this trade. What
`FOR UPDATE SKIP LOCKED` does guarantee — that two connections claiming at the same time never both
receive the same row — is pinned by `never claims the same row from two connections at once`, which
opens an explicit transaction on one connection and claims from a second one while the first is still
open.

**The Postgres repository is part of this extraction, and the table it needs is small.** The
claim/retry/mark-processed SQL is generic over any table shaped like this, and nothing in it
references the template's `groups`/`users` tables:

```sql
CREATE TABLE outbox_events (
  id                UUID PRIMARY KEY,
  event_kind        VARCHAR(64) NOT NULL,
  aggregate_type    VARCHAR(64) NOT NULL,
  aggregate_id      UUID NOT NULL,
  aggregate_version BIGINT NOT NULL,
  attempt_count     INT4 NOT NULL DEFAULT 0,
  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  last_error_code   VARCHAR(64),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON outbox_events (available_at, created_at) WHERE processed_at IS NULL;
```

`aggregate_id` only needs to be a type Postgres returns as a string through this driver — `UUID`
fits the template's own aggregates, but the repository never assumes it. An app may keep extra
columns the repository neither reads nor returns, such as the template's own `group_id` and
`actor_user_id`: the app's own `INSERT` still fills them, in the same transaction as the state
change it records, which is the one line of SQL this package does not own. Recommended but not
required: a unique index on `(aggregate_type, aggregate_id, aggregate_version, event_kind)`, which is
what makes a retried `INSERT` (after a crash between the state change and the outbox row) idempotent
instead of writing the event twice — the template had this index; it is not enforced here because
the repository reads and updates rows but never creates or migrates the table.
