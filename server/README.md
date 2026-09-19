# `@ts-libs/server`

Server-side primitives and adapters for Hono and Fresh apps. Two groups today:

- **HTTP** — bounded request bodies, CORS origin allow-listing, provider-error redaction, export
  envelopes, static-file serving and a distroless healthcheck. Zero dependencies except `hono`,
  which is already pinned in the root import map and used only for the `hono/cors` resolver type.
- **Storage** — the `FileStorage` port with a local-filesystem provider, an S3-compatible provider
  and a bucket-binding wrapper. Zero dependencies.

## Subpaths

| Export                              | What it is                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `@ts-libs/server/http/bounded-body` | Byte-capped, stall-budgeted request body reading; canonical `PayloadTooLargeError`   |
| `@ts-libs/server/http/cors`         | Exact-match origin allowlist and the `hono/cors` origin resolver                     |
| `@ts-libs/server/http/redact`       | Provider-error redaction: class name and scope to the log, a constant to the client  |
| `@ts-libs/server/export`            | Versioned export envelope and `Content-Disposition` download response                |
| `@ts-libs/server/export-client`     | Browser-only: save a response body as a file (DOM, so never imported server-side)    |
| `@ts-libs/server/static`            | Static-file serving with a MIME table and path-traversal protection                  |
| `@ts-libs/server/healthcheck`       | Loopback TCP probe, exit 0/1, for distroless images                                  |
| `@ts-libs/server/storage`           | The `FileStorage` port, the local and S3 providers, bucket binding, SigV4 presigning |
| `@ts-libs/server/auth`              | Multi-provider auth (`#6`): see the `server/auth` section below                     |

**Merge order:** the four issues that added files here (`#28`, `#30`, `#35`, `#6`) were cut from
different points on `main` and each carries the earlier ones, so whoever merges later rebases with a
**union** on `server/deno.json` exports and this README — never by dropping another package's entries.
`server/http/bounded-body.ts` is the exception: `#28`/`#30` carried a byte-identical copy of
`net/bounded-body.ts` (`sha256 5fc55e75`) and that copy has since collapsed into the canonical module
(`#43`), so this file no longer matches the pre-collapse branches by design. This branch adds `./auth*`
and the `server/auth` section; resolving the conflict by keeping one side would silently drop either the
export/static/healthcheck entries or the auth ones.

The union is asserted rather than trusted: `server/auth/packaging.test.ts` fails on a conflict marker
anywhere in this file, on a duplicated heading, on a table with two header rows, on an export target
that does not resolve, and on any `main` entry missing from `server/deno.json`.
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

| Variable                  | Required       | Meaning                                                                  |
| ------------------------- | -------------- | ------------------------------------------------------------------------ |
| `FILE_STORAGE_PROVIDER`   | yes, to enable | `local` or `s3`. Unset or empty → `createStorage()` returns `undefined`. |
| `FILE_STORAGE_BUCKET`     | yes            | Bucket to bind. Not defaulted: a wrong bucket must not be guessed.       |
| `FILE_STORAGE_LOCAL_PATH` | no             | Local base directory. Defaults to `./file-storage`.                      |
| `S3_REGION`               | for `s3`       | e.g. `eu-central-1`.                                                     |
| `S3_ENDPOINT`             | no             | Custom endpoint, e.g. `http://127.0.0.1:9000`. Default: AWS.             |
| `S3_ACCESS_KEY_ID`        | for `s3`       | Access key.                                                              |
| `S3_SECRET_ACCESS_KEY`    | for `s3`       | Secret key.                                                              |
| `S3_SESSION_TOKEN`        | no             | Session token, signed into the presign when set.                         |
| `S3_FORCE_PATH_STYLE`     | no             | `true`/`false`/`1`/`0`. Default: auto (loopback → path-style).           |
| `S3_PRESIGN_EXPIRES_IN`   | no             | Whole seconds, 1–604800. Default 3600.                                   |

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
fails there. No test in this package uses a temp directory.

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
