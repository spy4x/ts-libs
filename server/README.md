# `@ts-libs/server`

Server-side primitives and adapters for Hono and Fresh apps. Two groups today:

- **HTTP** — bounded request bodies, CORS origin allow-listing, bearer-token verification, export
  envelopes, static-file serving and a distroless healthcheck. Zero runtime dependencies: `hono` is
  pinned in the root import map, but `cors.ts` imports nothing — only `cors.test.ts` imports the
  `hono/cors` resolver type, for its own assertions.
- **Storage** — the `FileStorage` port with a local-filesystem provider, an S3-compatible provider
  and a bucket-binding wrapper. Zero dependencies.

## Subpaths

| Export                              | What it is                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `@ts-libs/server/http/bounded-body` | Byte-capped, stall-budgeted request body reading; canonical `PayloadTooLargeError`   |
| `@ts-libs/server/http/cors`         | Exact-match origin allowlist and the `hono/cors` origin resolver                     |
| `@ts-libs/server/http/bearer-auth`  | Bearer token extraction and constant-time verification (moved from `mcp/auth.ts`)    |
| `@ts-libs/server/export`            | Versioned export envelope and `Content-Disposition` download response                |
| `@ts-libs/server/static`            | Static-file serving with a MIME table and path-traversal protection                  |
| `@ts-libs/server/healthcheck`       | Loopback TCP probe, exit 0/1, for distroless images                                  |
| `@ts-libs/server/storage`           | The `FileStorage` port, the local and S3 providers, bucket binding, SigV4 presigning |
| `@ts-libs/server/auth`              | Multi-provider auth (`#6`): see the `server/auth` section below                      |
| `@ts-libs/server/crypto`            | AES-256-GCM cipher bound to its row, hex key, capped `maskKey` hint                  |
| `@ts-libs/server/user-secrets`      | BYOK store over an injected port: guarded base URL, encrypt, mask, upsert            |
| `@ts-libs/server/quota`             | Usage metering with an atomic reserve and 429/503 — not a rate limiter               |
| `@ts-libs/server/db`                | Barrel: Postgres and SQLite adapters plus the migration runner they share            |
| `@ts-libs/server/db/migrate`        | Migration runner: discovers, orders and applies `.sql` files, one port for both      |
| `@ts-libs/server/db/postgres`       | Postgres pool with sane connect/idle/statement timeout defaults                      |
| `@ts-libs/server/db/sqlite`         | SQLite adapter behind an injectable driver port; ships no driver                     |

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
import { createStorage } from "@ts-libs/server/storage"

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

A pluggable multi-provider authentication system, ported from `roley` (issue #6). Providers:
email + password (with password reset), magic link, email OTP, OAuth2 (Google and Facebook are one
implementation with two configurations) and anonymous guest accounts. Persistence is an `Adapter`
interface, so Postgres, SQLite, KV or an in-memory fake are interchangeable.

```ts
import { createAuth, PostgresAdapter } from "@ts-libs/server/auth"

const auth = createAuth({
  // Required and non-blank. Throws MissingPepperError otherwise.
  passwordPepper: Deno.env.get("PASSWORD_PEPPER") ?? "",
  adapter: new PostgresAdapter(postgres(connectionString)),
  appUrl: "https://app.example.com",
  oauth2: {
    google: {
      provider: OAuth2Provider.Google,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
      scope: "email profile",
      clientId: Deno.env.get("AUTH_GOOGLE_CLIENT_ID") ?? "",
      clientSecret: Deno.env.get("AUTH_GOOGLE_CLIENT_SECRET") ?? "",
      redirectUri: "https://app.example.com/api/keys/google/callback",
      stateCookieName: "google_auth_state",
      subjectField: "sub",
      emailField: "email",
      firstNameField: "given_name",
      lastNameField: "family_name",
      pictureField: "picture",
    },
  },
})
```

Nothing in the package reads the environment, imports a framework type, performs a session write
inside a provider or logs a secret. The adapter, the clock, the randomness source, the HTTP client,
the cookie jar and the session sink are all injected, which is why the suite runs under
`--allow-read --allow-env` with no network and no database.

### Subpaths

| Export                                        | What it is                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `@ts-libs/server/auth/types`                  | `Adapter`, `KeyKind`, `User`/`Key`/`Session`, the provider interfaces  |
| `@ts-libs/server/auth/crypto`                 | `CryptoContext`: PBKDF2 with an injected pepper, constant-time compare |
| `@ts-libs/server/auth/random`                 | Codes and tokens from the platform CSPRNG, rejection-sampled           |
| `@ts-libs/server/auth/session`                | Session mint, validate, refresh and revoke, with a negative cache      |
| `@ts-libs/server/auth/cache`                  | TTL cache in milliseconds, with a correct falsy read path              |
| `@ts-libs/server/auth/account-linking`        | The `MethodConnected` handlers that link sibling methods               |
| `@ts-libs/server/auth/email-password`         | Password sign-up, sign-in, reset and change                            |
| `@ts-libs/server/auth/magic-link`             | Single-use emailed links                                               |
| `@ts-libs/server/auth/otp`                    | Single-use emailed codes                                               |
| `@ts-libs/server/auth/oauth2`                 | One configurable authorization-code provider                           |
| `@ts-libs/server/auth/postgres-adapter`       | `PostgresAdapter` over `npm:postgres`                                  |
| `@ts-libs/server/auth/testing/memory-adapter` | In-memory `Adapter` with database-like constraints                     |

`@ts-libs/server/auth` re-exports all of the above. `./auth` itself is listed in the Subpaths table at
the top of this file.

### Security fixes applied at extraction time

| Source bug                                                                    | Fix                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `helpers.ts:84` OTP drawn from the non-cryptographic generator                | `crypto.getRandomValues` with rejection sampling, so digits are exactly uniform |
| `magicLink.ts:37,50,63,152,192` token stored plaintext, compared `===`        | stored as a PBKDF2 digest, compared with `timingSafeEqual` over digests         |
| `otp.ts:97` a consumed code stayed valid forever                              | `expiresAt`, an attempt counter with a lockout, and delete-on-use               |
| `misc/types.ts:18` `KeyKind.EMAIL_PASSWORD = 0` is falsy                      | kinds numbered from 1                                                           |
| `cache.ts:23,36,55` `ttl * 1000` → ≈19-year TTL; `if (fromCache)` loses falsy | milliseconds end to end, and `undefined` alone is a miss                        |
| `helpers.ts:7` + `misc/constants.ts:4` two peppers, one a literal             | one injected pepper that throws at construction when absent                     |
| `google.ts:195,226,265` providers called `setSession`                         | an injected `SessionSink` and a generic `CookieJar`; no framework type anywhere |
| `magicLink.ts:133,185` stub methods returning `null`                          | implemented, or removed from the interface                                      |

### Account linking

An account is a bag of `KeyKind`-keyed credentials, each with an `identification` and the `email` it
was established with. A credential for an address that already exists attaches to that account
instead of founding a second one, and the `MethodConnected` handlers then attach the sibling methods
for the same address and drop the anonymous key. This is why one address signing in with Google,
then Facebook, then a password ends up as one account with four credentials.

### Differences from the source, by design

`managers/session.ts` is the template's, not `roley`'s: PBKDF2-WebCrypto with a negative cache
instead of bcrypt on every validation. `index.ts` (SvelteKit cookie glue) is not ported — the
transport supplies a `SessionSink` instead. `KeyKind.OAuth2` replaces the separate `GOOGLE` and
`FACEBOOK` kinds, so the two OAuth2 providers keep provider-scoped identifications.

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
`@ts-libs/net/url-policy`, which resolves the host and refuses loopback, link-local (including the
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
has to go through `safeFetch` from `@ts-libs/net/safe-fetch`, which re-checks at connect time and
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
  await meter.release(principal, 1, metering) // the units were not spent after all
  throw error
}
```

**A refund is not idempotent, and a `release` that threw must not be retried for a session
principal.** Releasing the same reservation twice gives the units back twice; only a counter already
at zero absorbs the second one, because a store never goes below zero. For a session principal a
release is two store calls — the principal's own counter first, then the shared pool — so after one
of them has failed the other has already been refunded, and a retry would credit the pool a unit
nobody gave back, which any other anonymous caller can then spend. The own counter is refunded first
so that a failure part-way through leaves the pool holding a unit that nothing holds any more: short
rather than over-credited, and cleared when the window rolls.

A `release` keys by the window the clock is in when it runs, not the one the reservation was taken
in. Work that outlives a window boundary is refunded against the new window, and the old one keeps
the unit until it rolls: the unit moves between windows and the total across the two is unchanged.
Keep a unit of work shorter than the window, or use a lifetime window, where this cannot happen.
Closing it properly is a small API change — `release` would take the clock reading `reserve` used —
and nothing on the store; it is deliberately not part of this change.

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

Two adapters, one migration runner. `@ts-libs/server/db` is the barrel; `db/migrate`,
`db/postgres` and `db/sqlite` are the subpaths. Nothing here ships a driver: `postgres` is pinned in
the root import map and the SQLite driver is the caller's own, passed through `SqliteDriver`.

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
