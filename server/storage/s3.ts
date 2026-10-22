import { StorageError } from "./errors.ts"
import { createDenoObjectFs } from "./fs.ts"
import { assertBucket, assertDestinationPath, resolveObjectKey } from "./paths.ts"
import type { FileStorage, ObjectFs, PresignOptions, UploadBody } from "./ports.ts"
import {
  DEFAULT_EXPIRES_IN_SECONDS,
  MAX_PRESIGN_EXPIRES_IN_SECONDS,
  type PresignRequest,
  signS3Request,
} from "./sigv4.ts"

/** Default AWS region; overridden by configuration, never read from the environment here. */
export const DEFAULT_S3_REGION = "us-east-1"

/**
 * AWS's regional S3 endpoint, used when `config.endpoint` is not set.
 *
 * Not checked against a real AWS endpoint in this repository — no third-party
 * network call is made from here — so this is pinned only as a URL-shape unit
 * test, against the documented `s3.<region>.amazonaws.com` pattern.
 */
export function defaultS3Endpoint(region: string): string {
  return `https://s3.${region}.amazonaws.com`
}

/** Loopback hosts where a bucket as subdomain cannot resolve, e.g. the MinIO default. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/

/** Options of `S3Storage.presignPut`: the one type and the one size the upload may have. */
export interface PresignPutOptions {
  /** `Content-Type` the upload must send, e.g. `image/png`. Signed, so it cannot change. */
  contentType: string
  /** Exact size in bytes the upload must have. Signed, so a bigger body is refused. */
  contentLength: number
  /** Lifetime of the URL in seconds. Defaults to the provider's `expiresIn`. */
  expiresIn?: number
}

/** Options of `S3Storage.presignGet`: how the store labels the file it sends back. */
export interface PresignGetOptions {
  /** `Content-Type` of the response, overriding the stored one. */
  responseContentType?: string
  /** `Content-Disposition` of the response, e.g. `attachment; filename="report.pdf"`. */
  responseContentDisposition?: string
  /** Lifetime of the URL in seconds. Defaults to the provider's `expiresIn`. */
  expiresIn?: number
}

/** What `S3Storage.head` reports about one object. */
export interface S3ObjectInfo {
  /** Size in bytes. */
  size: number
  /** Stored `Content-Type`, when the store reports one. */
  contentType?: string
  /** Entity tag, quotes included, as the store sends it. */
  etag?: string
  lastModified?: Date
}

/** One object in a `S3Storage.list` page. */
export interface S3ListedObject {
  /** Object key, relative to the bucket. */
  key: string
  size: number
  etag?: string
  lastModified?: Date
}

/** One page of `S3Storage.list`. */
export interface S3ListPage {
  objects: S3ListedObject[]
  /** Pass to the next `list` call to read the next page; absent on the last page. */
  continuationToken?: string
}

/** Options of `S3Storage.list`. */
export interface S3ListOptions {
  /** At most this many keys per page, 1 to 1000. The store's default is 1000. */
  maxKeys?: number
  /** `continuationToken` of the previous page. */
  continuationToken?: string
}

type SignedMethod = "GET" | "PUT" | "HEAD" | "DELETE"

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
 * S3-compatible provider and client: presigned PUT and GET URLs for browsers,
 * head, ranged read, delete and list, for AWS, MinIO and Garage.
 *
 * Presigning is pure computation over Web Crypto (`signS3Request`), so the
 * package needs no AWS SDK: only the methods that talk to the store call
 * `fetch`, and that is injectable. The default presign
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
   * Presign a browser upload of one exact file: the URL accepts a PUT only with
   * this `Content-Type` and a body of exactly `contentLength` bytes, because
   * both headers are signed. No ACL is signed, so the object stays private.
   */
  async presignPut(bucket: string, path: string, options: PresignPutOptions): Promise<string> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    const { contentType, contentLength } = options
    if (contentType.trim() === "") {
      throw new StorageError("invalid_config", "contentType must not be empty")
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new StorageError("invalid_config", "contentLength must be a non-negative integer")
    }
    return await this.presign("PUT", address, {
      expiresIn: options.expiresIn,
      headers: { "content-type": contentType, "content-length": String(contentLength) },
    })
  }

  /**
   * Presign a download, optionally telling the store which `Content-Type` and
   * `Content-Disposition` to answer with, so a browser saves the file under its
   * own name, or never renders an upload as a page of this origin.
   */
  async presignGet(bucket: string, path: string, options: PresignGetOptions = {}): Promise<string> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    return await this.presign("GET", address, {
      expiresIn: options.expiresIn,
      query: {
        "response-content-type": options.responseContentType,
        "response-content-disposition": options.responseContentDisposition,
      },
    })
  }

  /** Size, type, entity tag and date of one object, or `null` when it does not exist. */
  async head(bucket: string, path: string): Promise<S3ObjectInfo | null> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    const url = await this.presign("HEAD", address)
    const response = await this.fetchOrFail(url, { method: "HEAD" }, "head", bucket, path)
    if (response.status === 404) return null
    if (!response.ok) throw await this.failure("head", response, bucket, path)
    const info: S3ObjectInfo = { size: Number(response.headers.get("content-length") ?? "0") }
    const contentType = response.headers.get("content-type")
    const etag = response.headers.get("etag")
    const lastModified = response.headers.get("last-modified")
    if (contentType !== null) info.contentType = contentType
    if (etag !== null) info.etag = etag
    if (lastModified !== null) info.lastModified = new Date(lastModified)
    return info
  }

  /**
   * Read bytes `start` to `end` of one object, both inclusive: the first bytes
   * of an upload are enough to check what the file really is. A range that
   * starts past the end of the object reads as no bytes, and never more than
   * the range is kept, even from a store that ignores `Range`.
   */
  async getRange(bucket: string, path: string, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new StorageError("invalid_config", "range must be integers with 0 <= start <= end")
    }
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    const url = await this.presign("GET", address)
    const response = await this.fetchOrFail(
      url,
      { method: "GET", headers: { range: `bytes=${start}-${end}` } },
      "getRange",
      bucket,
      path,
    )
    if (response.status === 416) {
      await response.body?.cancel().catch(() => {})
      return new Uint8Array(0)
    }
    if (!response.ok || response.body === null) {
      throw await this.failure("getRange", response, bucket, path)
    }
    const skip = response.status === 206 ? 0 : start
    return await readBounded(response.body, skip, end - start + 1)
  }

  /** Delete one object. Deleting an object that is not there succeeds. */
  async delete(bucket: string, path: string): Promise<void> {
    const address = await Promise.resolve().then(() => this.addressFor(bucket, path))
    const url = await this.presign("DELETE", address)
    const response = await this.fetchOrFail(url, { method: "DELETE" }, "delete", bucket, path)
    if (!response.ok && response.status !== 404) {
      throw await this.failure("delete", response, bucket, path)
    }
    await response.body?.cancel().catch(() => {})
  }

  /**
   * One page of the objects whose key starts with `prefix`, in key order
   * (ListObjectsV2). Pass the page's `continuationToken` back to read the next.
   */
  async list(bucket: string, prefix: string, options: S3ListOptions = {}): Promise<S3ListPage> {
    const address = await Promise.resolve().then(() => this.bucketAddress(bucket))
    const { maxKeys } = options
    if (maxKeys !== undefined && (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000)) {
      throw new StorageError("invalid_config", "maxKeys must be an integer between 1 and 1000")
    }
    const url = await this.presign("GET", address, {
      query: {
        "list-type": "2",
        prefix,
        "max-keys": maxKeys === undefined ? undefined : String(maxKeys),
        "continuation-token": options.continuationToken,
      },
    })
    const response = await this.fetchOrFail(url, { method: "GET" }, "list", bucket, prefix)
    if (!response.ok) throw await this.failure("list", response, bucket, prefix)
    return parseListPage(await response.text())
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
    const endpoint = new URL(this.config.endpoint ?? defaultS3Endpoint(this.config.region))
    const objectKey = resolveObjectKey(bucket, path)
    const pathStyle = this.config.forcePathStyle ?? LOOPBACK_HOST.test(endpoint.hostname)
    return pathStyle
      ? { origin: endpoint.origin, key: objectKey }
      : { origin: `${endpoint.protocol}//${bucket}.${endpoint.host}`, key: path }
  }

  /** The same as `addressFor`, for a request on the bucket itself, such as a listing. */
  private bucketAddress(bucket: string): { origin: string; key: string } {
    const endpoint = new URL(this.config.endpoint ?? defaultS3Endpoint(this.config.region))
    assertBucket(bucket)
    const pathStyle = this.config.forcePathStyle ?? LOOPBACK_HOST.test(endpoint.hostname)
    return pathStyle
      ? { origin: endpoint.origin, key: bucket }
      : { origin: `${endpoint.protocol}//${bucket}.${endpoint.host}`, key: "" }
  }

  /**
   * Sign one request. `key` is the canonical URI for the addressing style in
   * use, and `options.acl` is forwarded verbatim: when it is absent the
   * canonical request carries no ACL at all.
   */
  private presign(
    method: SignedMethod,
    address: { origin: string; key: string },
    options?: PresignOptions & Pick<PresignRequest, "headers" | "query">,
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
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
      ...(options?.query !== undefined ? { query: options.query } : {}),
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

  /**
   * Read the response body once and turn a non-2xx reply into a `StorageError`.
   *
   * Only the S3 error `<Code>` and `<Message>` reach the message: the rest of
   * an error body can echo the access key id, the string to sign and the
   * signature (`SignatureDoesNotMatch` does), which a log must not carry.
   */
  private async failure(
    operation: string,
    response: Response,
    bucket: string,
    path: string,
  ): Promise<StorageError> {
    const body = await response.text().catch(() => "")
    const detail = [xmlField(body, "Code"), xmlField(body, "Message")]
      .filter((part) => part !== undefined).join(": ")
    const suffix = detail === "" ? "" : `: ${detail.slice(0, 200)}`
    return new StorageError(
      "request_failed",
      `${operation} failed for ${bucket}/${path} with HTTP ${response.status}${suffix}`,
      { operation, status: response.status },
    )
  }
}

/** Undo the five XML entities and numeric character references. */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
    if (entity[0] !== "#") return named[entity.toLowerCase()]
    const hex = entity[1] === "x" || entity[1] === "X"
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10))
  })
}

/** Text of the first `<name>` element in `xml`, decoded, or `undefined`. */
function xmlField(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)
  return match === null ? undefined : decodeXml(match[1])
}

/**
 * Read a ListObjectsV2 reply. S3's listing is flat and regular, so each
 * `<Contents>` block is read field by field instead of pulling in an XML parser.
 */
function parseListPage(xml: string): S3ListPage {
  const objects: S3ListedObject[] = []
  for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlField(block, "Key")
    if (key === undefined) continue
    const etag = xmlField(block, "ETag")
    const lastModified = xmlField(block, "LastModified")
    objects.push({
      key,
      size: Number(xmlField(block, "Size") ?? "0"),
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified: new Date(lastModified) }),
    })
  }
  const truncated = xmlField(xml, "IsTruncated") === "true"
  const token = xmlField(xml, "NextContinuationToken")
  return truncated && token !== undefined ? { objects, continuationToken: token } : { objects }
}

/**
 * Read `length` bytes of `body` after skipping `skip`, then cancel the rest,
 * so a store that ignores `Range` cannot make the caller download a whole file.
 */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  skip: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  let offset = 0
  let skipped = 0
  const reader = body.getReader()
  try {
    while (offset < length) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = value
      if (skipped < skip) {
        const drop = Math.min(skip - skipped, chunk.length)
        skipped += drop
        chunk = chunk.subarray(drop)
      }
      const take = Math.min(length - offset, chunk.length)
      out.set(chunk.subarray(0, take), offset)
      offset += take
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out.slice(0, offset)
}
