import { StorageError } from "./errors.ts"
import { buildCanonicalQuery, encodeS3Path } from "./paths.ts"

/** Fallback URL lifetime, and the ceiling S3 itself enforces. */
export const DEFAULT_EXPIRES_IN_SECONDS = 3600
export const MAX_PRESIGN_EXPIRES_IN_SECONDS = 604800

const ALGORITHM = "AWS4-HMAC-SHA256"
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Canned ACLs that are safe to sign, plus the one that is not the default. */
const CANNED_ACLS = new Set([
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
  "aws-exec-read",
  "bucket-owner-read",
  "bucket-owner-full-control",
])

/** Credentials for one presign. `sessionToken` is required for STS-issued keys. */
export interface PresignCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

/** Everything SigV4 needs to describe the request being signed. */
export interface PresignRequest {
  method: "GET" | "PUT" | "HEAD" | "DELETE"
  /**
   * Full endpoint origin, e.g. `https://s3.eu-central-1.amazonaws.com`, or
   * `https://bucket.s3.eu-central-1.amazonaws.com` for virtual-hosted
   * addressing. Its host is the single signed header.
   */
  endpoint: string
  /**
   * Canonical URI, relative and without a leading slash: the object key alone
   * for virtual-hosted addressing, `bucket/key` for path-style. It is what the
   * signature covers, so it must match the URL exactly.
   */
  key: string
  region: string
  credentials: PresignCredentials
  expiresIn: number
  /** `Date` of the signature. Injected so a test can pin the signature. */
  now: Date
  /** Canned ACL to sign. Omitted means the object stays private. */
  acl?: string
  /** Extra query parameters, e.g. `{"response-content-type": "image/png"}`. */
  query?: Record<string, string | undefined>
}

function sha256Hex(input: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(input))
    .then((digest) => toHex(new Uint8Array(digest)))
}

async function hmacSha256(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(raw).slice(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/** `YYYYMMDDTHHMMSSZ`, the only timestamp format SigV4 accepts. */
export function formatAmzDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new StorageError("invalid_config", "Presign clock returned an invalid date")
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

/**
 * Derive the SigV4 signing key: four chained HMAC-SHA256 rounds over the date,
 * region, service and the `aws4_request` terminator. Pure Web Crypto, so no AWS
 * SDK dependency is needed to presign.
 */
async function deriveSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const dateKey = await hmacSha256(`AWS4${secretAccessKey}`, date)
  const regionKey = await hmacSha256(dateKey, region)
  const serviceKey = await hmacSha256(regionKey, service)
  return await hmacSha256(serviceKey, "aws4_request")
}

function assertPresignRequest(request: PresignRequest): void {
  if (!REGION_PATTERN.test(request.region)) {
    throw new StorageError("invalid_config", `Invalid region: ${JSON.stringify(request.region)}`)
  }
  if (request.credentials.accessKeyId.length === 0) {
    throw new StorageError("invalid_config", "accessKeyId must not be empty")
  }
  if (request.credentials.secretAccessKey.length === 0) {
    throw new StorageError("invalid_config", "secretAccessKey must not be empty")
  }
  if (
    !Number.isInteger(request.expiresIn) || request.expiresIn < 1 ||
    request.expiresIn > MAX_PRESIGN_EXPIRES_IN_SECONDS
  ) {
    throw new StorageError(
      "invalid_expiry",
      `expiresIn must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_IN_SECONDS}, got ${request.expiresIn}`,
    )
  }
  const endpoint = new URL(request.endpoint)
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new StorageError("invalid_config", `Endpoint must be http or https: ${request.endpoint}`)
  }
}

/**
 * Build a SigV4 query-string presigned URL for one S3 request.
 *
 * Zero dependencies: the signature is computed with Web Crypto. The request
 * always carries `UNSIGNED-PAYLOAD`, which is what every S3 presign uses, and
 * the canonical signed-header list is `host` alone unless an `acl` was
 * explicitly requested — so by default the returned URL grants no ACL at all.
 */
export async function signS3Request(request: PresignRequest): Promise<string> {
  assertPresignRequest(request)

  const endpoint = new URL(request.endpoint)
  const host = endpoint.host
  const service = "s3"
  const amzDate = formatAmzDate(request.now)
  const date = amzDate.slice(0, 8)
  const scope = `${date}/${request.region}/${service}/aws4_request`

  // The ACL rides the canonical query string. The only signed header is `host`.
  const parameters: Record<string, string | undefined> = {
    ...request.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${request.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(request.expiresIn),
    "X-Amz-SignedHeaders": "host",
  }
  if (request.acl !== undefined) {
    if (!CANNED_ACLS.has(request.acl)) {
      throw new StorageError(
        "invalid_acl",
        `Unsupported canned ACL: ${JSON.stringify(request.acl)}`,
      )
    }
    parameters["x-amz-acl"] = request.acl
  }
  if (request.credentials.sessionToken !== undefined) {
    parameters["X-Amz-Security-Token"] = request.credentials.sessionToken
  }

  const canonicalQuery = buildCanonicalQuery(parameters)
  const canonicalRequest = [
    request.method,
    `/${encodeS3Path(request.key)}`,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n")

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")

  const signingKey = await deriveSigningKey(
    request.credentials.secretAccessKey,
    date,
    request.region,
    service,
  )
  const signature = toHex(await hmacSha256(signingKey, stringToSign))

  return `${endpoint.origin}/${
    encodeS3Path(request.key)
  }?${canonicalQuery}&X-Amz-Signature=${signature}`
}
