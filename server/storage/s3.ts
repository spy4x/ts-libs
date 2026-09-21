import { StorageError } from "./errors.ts"
import { createDenoObjectFs } from "./fs.ts"
import { assertDestinationPath, resolveObjectKey } from "./paths.ts"
import type { FileStorage, ObjectFs, PresignOptions, UploadBody } from "./ports.ts"
import {
  DEFAULT_EXPIRES_IN_SECONDS,
  MAX_PRESIGN_EXPIRES_IN_SECONDS,
  signS3Request,
} from "./sigv4.ts"

/** Default AWS region; overridden by configuration, never read from the environment here. */
export const DEFAULT_S3_REGION = "us-east-1"
export const DEFAULT_S3_ENDPOINT = "https://s3.amazonaws.com"

/** Loopback hosts where a bucket as subdomain cannot resolve, e.g. the MinIO default. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/

export interface S3StorageConfig {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Custom endpoint, e.g. `http://127.0.0.1:9000` for MinIO. */
  endpoint?: string
  /** Force `endpoint/bucket/key` addressing instead of `bucket.endpoint/key`. */
  forcePathStyle?: boolean
  /** Presign lifetime in seconds. Defaults to 3600. */
  expiresIn?: number
  /** Clock used for the signature date. Injected so tests pin the signature. */
  clock?: () => Date
  /** Fetch used for data transfer. Injected so tests never touch the network. */
  fetch?: typeof fetch
  /** Filesystem destination for `download`. Defaults to real `Deno` I/O. */
  fs?: ObjectFs
}

/**
 * S3-compatible provider.
 *
 * Presigning is pure computation over Web Crypto (`signS3Request`), so the
 * package needs no AWS SDK: only the data path (`upload`, `download`,
 * `doesExist`) calls `fetch`, and that is injectable. The default presign
 * carries no ACL — objects stay private unless a caller passes
 * `{ acl: "public-read" }` explicitly.
 */
export class S3Storage implements FileStorage {
  private readonly config: S3StorageConfig
  private readonly fetcher: typeof fetch
  private readonly clock: () => Date
  private readonly fs: ObjectFs
  private readonly expiresIn: number

  constructor(config: S3StorageConfig) {
    if (config.region.length === 0) {
      throw new StorageError("invalid_config", "region is required for the s3 provider")
    }
    if (config.accessKeyId.length === 0 || config.secretAccessKey.length === 0) {
      throw new StorageError("invalid_config", "S3 credentials are required for the s3 provider")
    }
    const expiresIn = config.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS
    if (
      !Number.isInteger(expiresIn) || expiresIn < 1 ||
      expiresIn > MAX_PRESIGN_EXPIRES_IN_SECONDS
    ) {
      throw new StorageError(
        "invalid_expiry",
        `expiresIn must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_IN_SECONDS}`,
      )
    }
    this.config = config
    this.fetcher = config.fetch ?? fetch
    this.clock = config.clock ?? (() => new Date())
    this.fs = config.fs ?? createDenoObjectFs()
    this.expiresIn = expiresIn
  }

  /**
   * Presign a PUT. The default result carries no ACL; passing
   * `{ acl: "public-read" }` is the only way to get one, and it makes every
   * object uploaded through the URL world-readable.
   */
  async getUploadURL(bucket: string, path: string, options?: PresignOptions): Promise<string> {
    // `await` so an invalid bucket or key rejects rather than throwing
    // synchronously out of an `async` method's caller.
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    return await this.presign("PUT", address, options)
  }

  /** Presign a GET. `options.acl` is never applied to a download. */
  async getDownloadURL(bucket: string, path: string, options?: PresignOptions): Promise<string> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    return await this.presign("GET", address, { expiresIn: options?.expiresIn })
  }

  async upload(bucket: string, path: string, body: UploadBody): Promise<void> {
    const url = await this.getUploadURL(bucket, path)
    const payload = body instanceof Uint8Array ? body : new TextEncoder().encode(body)
    const response = await this.fetchOrFail(
      url,
      {
        method: "PUT",
        body: new Uint8Array(payload).slice(),
      },
      "upload",
      bucket,
      path,
    )
    if (!response.ok) {
      throw await this.failure("upload", response, bucket, path)
    }
    await response.body?.cancel().catch(() => {})
  }

  /**
   * Stream the object into `toPath` and return the byte count written.
   *
   * `toPath` is the caller's file rather than an object key, so a relative
   * destination is accepted and resolves against the process working
   * directory; what is rejected is a `..` segment or a NUL byte, because a
   * filename that can climb is still a filename that can climb.
   */
  async download(bucket: string, fromPath: string, toPath: string): Promise<number> {
    const destination = assertDestinationPath(toPath)
    const url = await this.getDownloadURL(bucket, fromPath)
    const response = await this.fetchOrFail(url, { method: "GET" }, "download", bucket, fromPath)
    if (!response.ok || response.body === null) {
      throw await this.failure("download", response, bucket, fromPath)
    }
    return await this.fs.writeObject(destination, response.body)
  }

  /**
   * `false` for a 404, and a thrown `StorageError` for every other failure.
   *
   * Signed for `HEAD` on its own presign, not by reusing `getDownloadURL`'s
   * `GET` signature with the method swapped on the request: a signature covers
   * the method, so a HEAD sent against a GET-signed URL is rejected by a real
   * bucket even though nothing in this package's own tests noticed.
   */
  async doesExist(bucket: string, path: string): Promise<boolean> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    const url = await this.presign("HEAD", address)
    const response = await this.fetchOrFail(url, { method: "HEAD" }, "doesExist", bucket, path)
    if (response.ok) return true
    if (response.status === 404) return false
    throw await this.failure("doesExist", response, bucket, path)
  }

  /**
   * Resolve the endpoint origin and the canonical URI for one object.
   *
   * Path-style addressing (selected for a loopback endpoint such as MinIO's
   * default, or forced by configuration) puts the bucket in the path, so the
   * canonical URI — the string the signature covers — carries `bucket/key`.
   * Virtual-hosted style puts the bucket in the host, so the canonical URI is
   * the key alone. The two are returned together because deriving them
   * separately is how a signature silently stops covering the request it signs.
   */
  private addressFor(bucket: string, path: string): { origin: string; key: string } {
    const endpoint = new URL(this.config.endpoint ?? DEFAULT_S3_ENDPOINT)
    const objectKey = resolveObjectKey(bucket, path)
    const pathStyle = this.config.forcePathStyle ?? LOOPBACK_HOST.test(endpoint.hostname)
    return pathStyle
      ? { origin: endpoint.origin, key: objectKey }
      : { origin: `${endpoint.protocol}//${bucket}.${endpoint.host}`, key: path }
  }

  /**
   * Sign one request. `key` is the canonical URI for the addressing style in
   * use, and `options.acl` is forwarded verbatim: when it is absent the
   * canonical request carries no ACL at all.
   */
  private presign(
    method: "GET" | "PUT" | "HEAD",
    address: { origin: string; key: string },
    options?: PresignOptions,
  ): Promise<string> {
    return signS3Request({
      method,
      endpoint: address.origin,
      key: address.key,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        ...(this.config.sessionToken !== undefined
          ? { sessionToken: this.config.sessionToken }
          : {}),
      },
      expiresIn: options?.expiresIn ?? this.expiresIn,
      now: this.clock(),
      ...(options?.acl !== undefined ? { acl: options.acl } : {}),
    })
  }

  /**
   * Call `fetcher` and turn a network failure into a `StorageError`.
   *
   * The original error is not kept as the message or the `cause`: on Deno 2.9.7
   * a failed `fetch` reports the request URL in its `cause`, and the request
   * URL here is a presigned S3 URL carrying the access key id and the
   * signature — forwarding that error, including through `console.error`,
   * would leak both.
   */
  private async fetchOrFail(
    url: string,
    init: RequestInit,
    operation: string,
    bucket: string,
    path: string,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, init)
    } catch {
      throw new StorageError(
        "request_failed",
        `${operation} failed for ${bucket}/${path}: the request could not be sent`,
        { operation },
      )
    }
  }

  /** Read the response body once and turn a non-2xx reply into a `StorageError`. */
  private async failure(
    operation: string,
    response: Response,
    bucket: string,
    path: string,
  ): Promise<StorageError> {
    const detail = await response.text().catch(() => "")
    const suffix = detail === "" ? "" : `: ${detail.slice(0, 200)}`
    return new StorageError(
      "request_failed",
      `${operation} failed for ${bucket}/${path} with HTTP ${response.status}${suffix}`,
      { operation, status: response.status },
    )
  }
}
