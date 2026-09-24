/**
 * `@spy4x/server/storage` — a `FileStorage` port with a local-disk and an S3 provider, plus a
 * bucket-bound wrapper and the env-driven constructors that pick and build one.
 *
 * @module
 */

import { StorageError } from "./errors.ts"
import { type StorageConfig, StorageEnvName } from "./env.ts"
import type { FileStorage, PresignOptions, UploadBody } from "./ports.ts"
import type { S3StorageConfig } from "./s3.ts"

export { StorageError, type StorageErrorCode } from "./errors.ts"
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
export { DEFAULT_S3_REGION, defaultS3Endpoint, S3Storage, type S3StorageConfig } from "./s3.ts"

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
 */
export async function createStorage(
  environment: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<BucketStorage | undefined> {
  const { parseStorageEnv } = await import("./env.ts")
  return await createStorageFrom(parseStorageEnv(environment))
}

/** Every variable this package reads, for a startup configuration check. */
export function storageEnvNames(): string[] {
  return Object.values(StorageEnvName)
}
