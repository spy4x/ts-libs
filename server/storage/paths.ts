import { StorageError } from "./errors.ts"

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/** Characters SigV4 leaves unescaped: the RFC 3986 unreserved set. */
const UNRESERVED = /[A-Za-z0-9\-._~]/

/** Absolute URI, e.g. `s3://bucket`, `https://host`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Normalise one path segment into a `file://` URL.
 *
 * Exported for testability: it must reject a `..` segment and an absolute path,
 * because the local provider builds its object path from caller-supplied keys.
 */
export function isSafeObjectPath(path: string): boolean {
  if (path.length === 0 || HAS_SCHEME.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    return false
  }
  if (path.includes("\\") || path.includes("\0")) return false
  return !path.split("/").some((segment) => segment === "..")
}

/**
 * Build `${basePath}/${bucket}/${path}` for the local provider.
 *
 * Both halves are validated first: an empty or malformed bucket is rejected,
 * and a path that is absolute or carries a `..` segment is rejected rather than
 * silently normalised, so a crafted key cannot escape the base directory.
 */
export function resolveStoragePath(basePath: string, bucket: string, path: string): string {
  const key = resolveObjectKey(bucket, path)
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath
  return `${base}/${key}`
}

/** Percent-encode per RFC 3986. `encodeURIComponent` leaves `!'()*~` alone, SigV4 does not. */
export function encodeRfc3986(value: string): string {
  let out = ""
  for (const character of value) {
    if (UNRESERVED.test(character)) {
      out += character
    } else {
      for (const byte of new TextEncoder().encode(character)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      }
    }
  }
  return out
}

/** Encode an object key for the canonical URI, keeping `/` as the separator. */
export function encodeS3Path(path: string): string {
  return path.split("/").map(encodeRfc3986).join("/")
}

/** Build a sorted, encoded query string. Values that are `undefined` are dropped. */
export function buildCanonicalQuery(parameters: Record<string, string | undefined>): string {
  return Object.entries(parameters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

/** Validate a bucket name. Throws rather than normalising, so typos surface loudly. */
export function assertBucket(bucket: string): string {
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new StorageError("invalid_bucket", `Invalid bucket name: ${JSON.stringify(bucket)}`)
  }
  return bucket
}

/**
 * Validate a bucket and an object key and return them joined.
 *
 * The S3 provider needs `bucket/key` for the canonical URI; the local provider
 * resolves the pair against its base directory. Both need the same validation,
 * so it lives here and `resolveStoragePath` is the filesystem-specific wrapper.
 */
export function resolveObjectKey(bucket: string, path: string): string {
  assertBucket(bucket)
  if (!isSafeObjectPath(path)) {
    throw new StorageError(
      "invalid_path",
      `Object path must be relative and free of '..': ${JSON.stringify(path)}`,
    )
  }
  return `${bucket}/${path}`
}

/**
 * Validate a local destination path for `download`.
 *
 * `toPath` is the caller's own file, not derived from an object key, so it is
 * not constrained to a bucket. The contract is: a **relative destination is
 * allowed** and resolves against the process working directory, which is the
 * caller's own choice, but a `..` segment or a NUL byte is refused. That is the
 * part a caller cannot be expected to see: a filename that can climb can reach
 * anywhere, and rejecting it here means a download only ever writes where the
 * caller named. `toPath` is otherwise the caller's responsibility — this is not
 * a sandbox, and it does not confine a destination to any base directory.
 */
export function assertDestinationPath(toPath: string): string {
  if (toPath.length === 0) {
    throw new StorageError("invalid_path", "Download destination must not be empty")
  }
  if (toPath.includes("\u0000")) {
    throw new StorageError(
      "invalid_path",
      `Download destination must not contain a NUL byte: ${JSON.stringify(toPath)}`,
    )
  }
  if (toPath.split(/[/\\]/).some((segment) => segment === "..")) {
    throw new StorageError(
      "invalid_path",
      `Download destination must not contain a '..' segment: ${JSON.stringify(toPath)}`,
    )
  }
  return toPath
}
