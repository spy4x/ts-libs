/**
 * `@spy4x/server/storage` — a `FileStorage` port with a local-disk and an S3 provider, plus a
 * bucket-bound wrapper and the env-driven constructors that pick and build one.
 *
 * ## The port
 *
 * `FileStorage` is exported **as a type**, not just implemented here: writing your
 * own provider is the point of a port, and nothing in the package requires a
 * subclass of a shipped class.
 *
 * | Method                         | Contract                                                                                                                                            |
 * | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `getUploadURL(bucket, path)`   | Presigned PUT URL. Private by default; `{ acl: "public-read" }` is the only way to change that.                                                     |
 * | `getDownloadURL(bucket, path)` | Presigned GET URL. Never carries an ACL, even if one is passed.                                                                                     |
 * | `upload(bucket, path, body)`   | `Uint8Array` or `string`. **Byte-exact** — a provider that decodes the body to text violates the port.                                              |
 * | `download(bucket, from, to)`   | Streams to the local file `to`, returns the number of bytes written. `to` is the caller's path, refused if it carries a `..` segment or a NUL byte. |
 * | `doesExist(bucket, path)`      | `false` for a missing object; **throws** for every other failure, so a denied or unreachable probe never reads as "absent".                         |
 *
 * `bucket` and `path` are validated before use: a bucket must be a legal
 * lowercase S3 name, and a path that is absolute, carries a scheme, a backslash or
 * a `..` segment is rejected with a `StorageError` rather than normalised. A
 * crafted key cannot leave its bucket in either provider.
 *
 * `StorageError` carries a machine-readable `code` (`invalid_bucket`,
 * `invalid_path`, `invalid_acl`, `invalid_expiry`, `invalid_config`,
 * `request_failed`), the `operation`, and any HTTP `status`, so a caller branches
 * on values instead of message text.
 *
 * ## Providers
 *
 * | Provider       | Runtime dependency | Addressing                                                                  |
 * | -------------- | ------------------ | --------------------------------------------------------------------------- |
 * | `LocalStorage` | none               | `<basePath>/<bucket>/<object>`, default `./file-storage`; dev only          |
 * | `S3Storage`    | none               | Virtual-hosted by default; path-style for a loopback endpoint such as MinIO |
 *
 * Neither provider adds a dependency. SigV4 presigning is implemented over Web
 * Crypto, and the only network calls are the data path (`upload`, `download`,
 * `doesExist`), which is why presigning is pure, deterministic and testable.
 *
 * `LocalStorage.getUploadURL`/`getDownloadURL` return `file:` URLs. A file URL is
 * not an authorisation, and a browser cannot PUT to one, so neither URL is a
 * direct-upload or a share target — they exist to satisfy the port for local
 * development. Use `upload`/`download` with a local provider.
 *
 * ### Provider selection
 *
 * ```ts
 * import { createStorage } from "@spy4x/server/storage"
 *
 * const storage = await createStorage() // reads the storage variables, undefined if unconfigured
 * await storage?.upload("media/photo.png", bytes)
 * ```
 *
 * `loadStorageProvider("s3" | "local", s3Config?)` keeps the source's dynamic
 * `import()`: a deployment that selects `local` never evaluates or fetches the S3
 * provider. The key is an **argument**, not a module-scope `$env` read, so
 * importing the package has no environment dependency and cannot fail on a missing
 * variable. `createStorage()` is the only function that reads real environment
 * variables, only the ones `storageEnvNames()` lists, and it uses the same
 * `parseStorageEnv(record)` helper that a test drives with a literal object.
 *
 * ### Injecting configuration
 *
 * Every provider takes its configuration as a constructor argument, so a caller
 * that does not want the environment path builds one directly:
 *
 * ```ts
 * const provider = new S3Storage({
 *   region: "eu-central-1",
 *   accessKeyId: Deno.env.get("S3_ACCESS_KEY_ID")!,
 *   secretAccessKey: Deno.env.get("S3_SECRET_ACCESS_KEY")!,
 *   endpoint: "http://127.0.0.1:9000",
 *   forcePathStyle: true,
 *   clock: () => new Date(), // injected: tests pin it for a fixed signature
 *   fetch: myFetch, // injected: tests never open a socket
 *   fs: createMemoryObjectFs(), // injected: tests never write to disk
 * })
 * const storage = createBucketStorage({ bucket: "examplebucket", provider })
 * ```
 *
 * `clock`, `fetch` and `fs` each default to the real thing and exist so a
 * signature, a transfer and a filesystem write can all be pinned in a test. A
 * provider that could not be tested this way would be a design defect.
 *
 * ### Browser uploads and object management (S3 only)
 *
 * `S3Storage` has seven more methods that the port does not, because a local folder
 * cannot honour them. The integration tier runs them against MinIO and Garage; they should work
 * against AWS too, but no test runs there.
 *
 * | Method                                                        | Does                                                                                                                                                                                          |
 * | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `presignPut(bucket, path, { contentType, contentLength })`    | URL for one browser PUT. Both headers are signed, so the store refuses another type or another size.                                                                                          |
 * | `presignGet(bucket, path, { responseContentDisposition, … })` | URL for one GET; `responseContentType` and `responseContentDisposition` set the headers the store answers with.                                                                               |
 * | `head(bucket, path)`                                          | `{ size, contentType, etag, lastModified }`, or `null` when the object is missing.                                                                                                            |
 * | `getRange(bucket, path, start, end)`                          | Bytes `start` to `end`, inclusive, to check an upload's real type. Keeps only the range; a store that ignores `Range` sends bytes up to `end`, and those before `start` are read and dropped. |
 * | `copy(bucket, fromPath, toPath)`                              | Copies one object to another key inside the store, with its type; a missing source throws.                                                                                                    |
 * | `delete(bucket, path)`                                        | Deletes one object; a missing one is not an error.                                                                                                                                            |
 * | `list(bucket, prefix, { maxKeys, continuationToken })`        | One page of keys under `prefix`, with the token for the next page.                                                                                                                            |
 *
 * ```ts
 * const url = await provider.presignPut("uploads", `${userId}/${fileId}`, {
 *   contentType: "image/png",
 *   contentLength: file.size,
 *   expiresIn: 300,
 * })
 * // the browser: fetch(url, { method: "PUT", body: file, headers: { "content-type": "image/png" } })
 * ```
 *
 * Before trusting a browser upload, read its first bytes and check them against the
 * type it claimed: a signed URL holds the upload to a name, not to what the file is.
 *
 * ```ts
 * const head = await provider.getRange("uploads", key, 0, SNIFF_BYTES - 1)
 * if (!matchesContentType(head, "image/png")) await provider.delete("uploads", key)
 * ```
 *
 * The signed URL stays valid until it expires, so its holder can PUT other bytes after the check.
 * Sign the browser's PUT for a staging key, `copy` it to a key no browser has a URL for, check
 * that copy, and delete the staging object: the checked bytes then cannot be replaced.
 *
 * `matchesContentType` knows PNG, JPEG, GIF, WebP, HEIC, PDF and ZIP by their signature,
 * and plain text, CSV and JSON as UTF-8 without a NUL byte (`SNIFFABLE_CONTENT_TYPES`).
 * An empty file and any other type never match.
 *
 * The check cannot catch a file that is two types at once, such as a PNG with HTML
 * after its signature, or markup sent as plain text. Serve stored files with their
 * checked type and `X-Content-Type-Options: nosniff`, so a browser never runs them.
 *
 * A failed request throws a `StorageError` whose message carries only the store's
 * error code and message, never the rest of its error body, which can echo the
 * access key id and the signature.
 *
 * ## Environment
 *
 * | Variable                  | Required       | Meaning                                                                          |
 * | ------------------------- | -------------- | -------------------------------------------------------------------------------- |
 * | `FILE_STORAGE_PROVIDER`   | yes, to enable | `local` or `s3`. Unset or empty → `createStorage()` returns `undefined`.         |
 * | `FILE_STORAGE_BUCKET`     | yes            | Bucket to bind. Not defaulted: a wrong bucket must not be guessed.               |
 * | `FILE_STORAGE_LOCAL_PATH` | no             | Local base directory. Defaults to `./file-storage`.                              |
 * | `S3_REGION`               | for `s3`       | e.g. `eu-central-1`.                                                             |
 * | `S3_ENDPOINT`             | no             | Custom endpoint, e.g. `http://127.0.0.1:9000`. Default: derived from the region. |
 * | `S3_ACCESS_KEY_ID`        | for `s3`       | Access key.                                                                      |
 * | `S3_SECRET_ACCESS_KEY`    | for `s3`       | Secret key.                                                                      |
 * | `S3_SESSION_TOKEN`        | no             | Session token, signed into the presign when set.                                 |
 * | `S3_FORCE_PATH_STYLE`     | no             | `true`/`false`/`1`/`0`. Default: auto (loopback → path-style).                   |
 * | `S3_PRESIGN_EXPIRES_IN`   | no             | Whole seconds, 1–604800. Default 3600.                                           |
 *
 * Placeholders only — `AKIAIOSFODNN7EXAMPLE`, `http://127.0.0.1:9000`. Never a real
 * bucket, key or endpoint. A required variable that is missing or empty throws at
 * parse time instead of falling back to a default: an unset variable and a typo
 * both look like an empty string, and a silent default hides the typo.
 *
 * ## The ACL default
 *
 * The source presigned every upload with `ACL: 'public-read'`, so every object
 * uploaded through a returned URL became world-readable. The default here is **no
 * ACL at all**: the canonical request contains no `x-amz-acl` parameter, the
 * object inherits the bucket's private default, and `X-Amz-SignedHeaders` is
 * `host` alone. Both are asserted in `storage.test.ts`.
 *
 * `public-read` remains available as a deliberate, per-call opt-in:
 *
 * ```ts
 * await storage.getUploadURL("public/hero.png", { acl: "public-read" })
 * ```
 *
 * The opt-in is signed, so it cannot be added or stripped by whoever holds the
 * URL, and an ACL outside the canned set is rejected. `getDownloadURL` ignores
 * `acl` entirely — a download must never need one, whatever a caller passes.
 *
 * ## Filesystem port
 *
 * `ObjectFs` (`readObject`, `writeObject`, `existsObject`) is the filesystem
 * dependency of both providers, and is what lets the local provider be exercised
 * without disk access. `createDenoObjectFs()` is the real adapter: it reads and
 * writes through the platform's `denoFileSystem` port
 * (`@spy4x/platform/server/deno-fs`) and its `readBytes`, `writeBytes` and
 * `writeStream` methods. `createMemoryObjectFs()` is exported for callers that want
 * the same substitute in their own tests.
 *
 * `writeObject` returns the byte count it wrote and accepts a `Uint8Array` or a
 * `ReadableStream<Uint8Array>`, which is how `download` streams a response body
 * straight to disk without buffering the whole object. It writes to a temporary
 * file beside the target and renames it into place, so a download cut off midway
 * keeps the file that was there, and the temporary file is removed. Creating the
 * parent folder ignores only `AlreadyExists`; any other failure, such as a denied
 * permission, is thrown.
 *
 * The write path is split so its logic is reachable without disk access:
 * `writeToFile(path, data, open?, makeDirectory?)` owns the byte counting, the open flags contract
 * and the closer-on-error path, and takes `open` as an injectable opener.
 * `parentDirectory(filePath)` decides which directory must exist first and returns
 * `undefined` when none does — a bare filename like `"out.png"` creates no
 * directory at all.
 *
 * Permission needs are documented per task, not assumed: reading needs
 * `--allow-read`, writing needs `--allow-write`, and the repository test task grants
 * neither `--allow-write` nor `--allow-net`. So the suite drives the local provider
 * through `createMemoryObjectFs()`, the S3 provider through an injected `fetch`,
 * `writeToFile` through an injected opener, and the whole `Deno` surface through an
 * injected `DenoFsHost`.
 *
 * **Disclosed gap.** In the unit tier, `server/storage/fs.ts` leaves only its
 * platform calls behind `--allow-write` uncovered: `Deno.open`, `Deno.mkdir`,
 * `Deno.rename` and `Deno.remove` in `denoFsHost` and the default opener. Nothing
 * in that module's own logic is uncovered: the stat-to-boolean branch, both write
 * branches, the byte count, the closer-on-error path (buffer _and_ stream), the
 * rename into place and the directory decision all have direct tests, and the
 * integration tier runs the `ObjectFs` contract on real disk.
 *
 * `Deno.makeTempDir` does **not** make that gap closable here. On this box it fails
 * under the task's exact grants, and under no grants at all:
 *
 * ```
 * $ deno test --no-prompt --allow-read --allow-env /tmp/mtd.test.ts
 * makeTempDir FAILED: NotCapable Requires write access to <TMP>, run again with the --allow-write flag
 * $ deno test --no-prompt /tmp/mtd.test.ts
 * makeTempDir FAILED: NotCapable Requires write access to <TMP>, run again with the --allow-write flag
 * ```
 *
 * Deno 2.9.7, reproduced in a pristine worktree with no workspace config, so it is
 * not this repo's `deno.jsonc`. If it succeeds under a `DENO_DIR`-less default on
 * another box, the tests still must not depend on it: the CI gate runs
 * `deno task test`, and a test that needs a permission the task does not grant
 * fails there. No unit-tier test in this package uses `Deno.makeTempDir`, for the
 * reason above — that gap stands. The integration tier is a different grant:
 * `server/storage/local.integration.test.ts` and the `S3Storage.download` case in
 * `server/storage/s3.integration.test.ts` do write to a real folder, obtained from
 * `createScratchFolder` (`@integration-testing`) rather than `Deno.makeTempDir`,
 * inside the tier's narrower `--allow-write=.volumes`.
 *
 * **`download`'s `toPath` is validated, and it is the caller's file.** It is not
 * derived from an object key, so it is not confined to a bucket — a relative
 * destination resolves against the process working directory, which is the
 * caller's own choice. What is refused is a `..` segment or a NUL byte, so a
 * filename that can climb cannot redirect the write. Beyond that, the destination
 * is the caller's responsibility and this is not a sandbox.
 *
 * **`parentDirectory` is not a sanitiser.** It preserves a `..` segment
 * (`"../../evil/x.png"` → `"../../evil"`) and a percent-encoded one, because keys
 * are validated upstream: every path that reaches it came from a bucket-and-key
 * pair `paths.ts` already rejected `..` and absolute paths for. Feeding it an
 * unvalidated string yields an unvalidated path, by contract.
 *
 * @module
 */

import { readEnvRecord } from "@spy4x/platform/server/process"
import { StorageError } from "./errors.ts"
import { type StorageConfig, StorageEnvName } from "./env.ts"
import type { FileStorage, PresignOptions, UploadBody } from "./ports.ts"
import type { S3StorageConfig } from "./s3.ts"

export { StorageError, type StorageErrorCode } from "./errors.ts"
export { matchesContentType, SNIFF_BYTES, SNIFFABLE_CONTENT_TYPES } from "./content-type.ts"
export { parseExpiresIn, parseStorageEnv, type StorageConfig, StorageEnvName } from "./env.ts"
export { createDenoObjectFs, ensureFileDirectory } from "./fs.ts"
export { DEFAULT_LOCAL_BASE_PATH, LocalStorage, type LocalStorageConfig } from "./local.ts"
export { createMemoryObjectFs } from "./memory-fs.ts"
export {
  assertBucket,
  encodeRfc3986,
  encodeS3Path,
  isSafeObjectPath,
  resolveObjectKey,
  resolveStoragePath,
} from "./paths.ts"
export { type FileStorage, type ObjectFs, type PresignOptions, type UploadBody } from "./ports.ts"
export {
  DEFAULT_EXPIRES_IN_SECONDS,
  formatAmzDate,
  MAX_PRESIGN_EXPIRES_IN_SECONDS,
  type PresignCredentials,
  type PresignRequest,
  signS3Request,
} from "./sigv4.ts"
export {
  DEFAULT_S3_REGION,
  defaultS3Endpoint,
  type PresignGetOptions,
  type PresignPutOptions,
  type S3ListedObject,
  type S3ListOptions,
  type S3ListPage,
  type S3ObjectInfo,
  S3Storage,
  type S3StorageConfig,
} from "./s3.ts"

/** A `FileStorage` provider bound to one bucket, with the bucket argument removed. */
export interface BucketStorage {
  readonly bucket: string
  readonly provider: FileStorage
  getUploadURL(path: string, options?: PresignOptions): Promise<string>
  getDownloadURL(path: string, options?: PresignOptions): Promise<string>
  upload(path: string, body: UploadBody): Promise<void>
  download(fromPath: string, toPath: string): Promise<number>
  doesExist(path: string): Promise<boolean>
}

export interface BucketStorageConfig {
  bucket: string
  provider: FileStorage
}

/**
 * Bind a provider to one bucket.
 *
 * The port takes the bucket on every call so one provider can serve several
 * buckets; a caller normally serves one, and this removes the argument that is
 * therefore always the same. A class is used rather than a closure so a caller
 * can subclass and override a single method.
 */
export class DefaultBucketStorage implements BucketStorage {
  constructor(readonly bucket: string, readonly provider: FileStorage) {}

  getUploadURL(path: string, options?: PresignOptions): Promise<string> {
    return this.provider.getUploadURL(this.bucket, path, options)
  }

  getDownloadURL(path: string, options?: PresignOptions): Promise<string> {
    return this.provider.getDownloadURL(this.bucket, path, options)
  }

  upload(path: string, body: UploadBody): Promise<void> {
    return this.provider.upload(this.bucket, path, body)
  }

  download(fromPath: string, toPath: string): Promise<number> {
    return this.provider.download(this.bucket, fromPath, toPath)
  }

  doesExist(path: string): Promise<boolean> {
    return this.provider.doesExist(this.bucket, path)
  }
}

/** Build a bucket-bound storage from an already-constructed provider. */
export function createBucketStorage(config: BucketStorageConfig): BucketStorage {
  if (config.bucket.length === 0) {
    throw new StorageError("invalid_bucket", "bucket must not be empty")
  }
  return new DefaultBucketStorage(config.bucket, config.provider)
}

/** The two selectable backends, as the wire name used in `FILE_STORAGE_PROVIDER`. */
export type StorageProviderKey = "local" | "s3"

/**
 * Load and construct a provider by dynamic `import()`.
 *
 * The dynamic import is kept from the source: a deployment that never selects
 * `s3` never evaluates or fetches the S3 provider. Unlike the source, no
 * environment is read — the caller passes the key, so this is reachable from a
 * test and importing the package has no import-time environment dependency.
 * The S3 provider needs its credentials, so they are passed in rather than
 * invented here.
 */
export async function loadStorageProvider(
  key: StorageProviderKey,
  config: { s3?: S3StorageConfig; localPath?: string } = {},
): Promise<FileStorage> {
  if (key === "s3") {
    if (config.s3 === undefined) {
      throw new StorageError("invalid_config", "The s3 provider requires S3 configuration")
    }
    const { S3Storage } = await import("./s3.ts")
    return new S3Storage(config.s3)
  }
  if (key !== "local") {
    // An explicit throw, because the fall-through shape returned the local
    // provider for any unrecognised key: a caller who bypassed the type got
    // silent dev storage instead of an error. The env path already threw, so
    // this makes the two agree.
    throw new StorageError(
      "invalid_config",
      `Unknown storage provider: ${JSON.stringify(key)}. Expected "local" or "s3".`,
    )
  }
  const { LocalStorage } = await import("./local.ts")
  return new LocalStorage(config.localPath === undefined ? {} : { basePath: config.localPath })
}

/**
 * Build the configured storage from an explicit configuration.
 *
 * Returns `undefined` when the configuration is absent, which is the intended
 * behaviour for a deployment that does not use object storage. The provider is
 * loaded through `loadStorageProvider`, so only the selected module is fetched.
 */
export async function createStorageFrom(
  config: StorageConfig | undefined,
): Promise<BucketStorage | undefined> {
  if (config === undefined) return undefined
  return createBucketStorage({
    bucket: config.bucket,
    provider: await loadStorageProvider(config.s3 === undefined ? "local" : "s3", {
      ...(config.s3 === undefined ? {} : { s3: config.s3 }),
      ...(config.localPath === undefined ? {} : { localPath: config.localPath }),
    }),
  })
}

/**
 * Read the environment, then build the configured storage.
 *
 * The only function in the package that reads real environment variables:
 * `parseStorageEnv` takes a record, and every provider takes its configuration
 * as a constructor argument. Nothing is read at import time, so importing the
 * module cannot fail on a missing variable.
 *
 * By default it reads only the variables {@link storageEnvNames} lists, through
 * `readEnvRecord` of `@spy4x/platform/server/process`, so on Deno `--allow-env`
 * can name exactly those, and Node and Bun work too.
 */
export async function createStorage(
  environment: Record<string, string | undefined> = readEnvRecord(storageEnvNames()),
): Promise<BucketStorage | undefined> {
  const { parseStorageEnv } = await import("./env.ts")
  return await createStorageFrom(parseStorageEnv(environment))
}

/** Every variable this package reads, for a startup configuration check. */
export function storageEnvNames(): string[] {
  return Object.values(StorageEnvName)
}
