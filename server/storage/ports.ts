/**
 * The storage ports. Nothing here touches the network, the filesystem or the
 * environment: both interfaces exist so a caller can substitute its own
 * provider or its own filesystem, and so the shipped providers stay testable
 * without a live object store.
 */

/** Object payload accepted by `FileStorage.upload`. Bytes, never a stringified buffer. */
export type UploadBody = Uint8Array | string

/**
 * Wire-level object storage provider.
 *
 * Every method takes the bucket explicitly, so one provider instance can serve
 * several buckets; bind a bucket once with `createBucketStorage`.
 *
 * Contract:
 * - `bucket` and `path` are joined after both are validated. A path that is
 *   absolute or contains a `..` segment is rejected with a `TypeError`, in both
 *   providers, so a crafted key cannot leave the bucket.
 * - `upload` is byte-exact. An implementation that decodes the body to text
 *   silently corrupts binary payloads and violates this port.
 * - `download` streams to `toPath` and returns the number of bytes written.
 * - `doesExist` returns `false` for a missing object and throws for every other
 *   failure, so an authorisation or transport error never reads as "missing".
 * - `getUploadURL`/`getDownloadURL` return a presigned URL. The default
 *   presign carries no ACL: the returned objects are private, and granting
 *   world-read is an explicit per-call opt-in.
 */
export interface FileStorage {
  getUploadURL(bucket: string, path: string, options?: PresignOptions): Promise<string>
  getDownloadURL(bucket: string, path: string, options?: PresignOptions): Promise<string>
  upload(bucket: string, path: string, body: UploadBody): Promise<void>
  download(bucket: string, fromPath: string, toPath: string): Promise<number>
  doesExist(bucket: string, path: string): Promise<boolean>
}

/** Per-call presign overrides. Omitted fields fall back to the provider config. */
export interface PresignOptions {
  /**
   * S3 canned ACL to sign. Omitted by default, which leaves the object private.
   * `public-read` makes every object uploaded through the returned URL
   * world-readable: pass it only when a public asset is genuinely intended.
   */
  acl?: string
  /** Lifetime of the URL in seconds. Defaults to 3600, clamped to 604800. */
  expiresIn?: number
}

/**
 * Minimal object-store filesystem port. The shipped adapter wraps `Deno`, and
 * keeping the provider behind an interface is what lets the local provider be
 * tested with an in-memory implementation instead of real disk writes.
 */
export interface ObjectFs {
  readObject(path: string): Promise<Uint8Array>
  /**
   * Write `data` to `path`, creating parents. Returns the number of bytes
   * written, so streaming callers can report a byte count without re-reading.
   */
  writeObject(path: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<number>
  existsObject(path: string): Promise<boolean>
}
