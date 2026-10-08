/**
 * URL rules for a CalDAV client: resolve the hrefs a server sends, compare two addresses of the
 * same resource, build the address of a new resource, and check an origin before credentials are
 * attached.
 *
 * Hrefs are kept exactly as the server sent them (`%40`, `%2F` survive): addresses are built with
 * `new URL(href, base)`, never by joining strings, and compared segment by segment after decoding.
 *
 * @module
 */

/**
 * Resolve an `href` from a multistatus body against the URL of the request that returned it.
 * Returns `null` when the result is not a valid URL.
 */
export function resolveHref(
  href: string,
  requestUrl: string | URL,
): URL | null {
  try {
    return new URL(href, requestUrl)
  } catch {
    return null
  }
}

function toUrl(value: string | URL): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Decoded path segments, split on the raw `/`, so an encoded `%2F` stays inside its segment. */
function pathSegments(url: URL): string[] {
  const segments = url.pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })
  // A trailing slash marks a collection, and servers drop or add it freely.
  if (segments.length > 1 && segments.at(-1) === "") segments.pop()
  return segments
}

/**
 * Whether two absolute URLs name the same resource: same origin, same query and the same path
 * segments once each segment is percent-decoded. `a%40b` equals `a@b`, `a%2Fb` does not equal
 * `a/b`, and a trailing slash is ignored. Invalid URLs are never the same resource.
 */
export function sameResource(a: string | URL, b: string | URL): boolean {
  const left = toUrl(a)
  const right = toUrl(b)
  if (left === null || right === null) return false
  if (
    left.origin !== right.origin || left.origin === "null" ||
    left.search !== right.search
  ) {
    return false
  }
  const leftSegments = pathSegments(left)
  const rightSegments = pathSegments(right)
  return leftSegments.length === rightSegments.length &&
    leftSegments.every((segment, index) => segment === rightSegments[index])
}

/**
 * The URL of a new member of `collectionUrl`, named `segment` encoded with `encodeURIComponent`.
 * Pass a generated name such as `${crypto.randomUUID()}.ics`, never a display name. Throws a
 * `RangeError` on an empty, `.` or `..` segment, which would not name a new member.
 */
export function childUrl(collectionUrl: string | URL, segment: string): URL {
  if (segment === "" || segment === "." || segment === "..") {
    throw new RangeError(`"${segment}" cannot name a member of a collection`)
  }
  const collection = new URL(collectionUrl)
  if (!collection.pathname.endsWith("/")) collection.pathname += "/"
  return new URL(encodeURIComponent(segment), collection)
}

/**
 * Whether `target` is on the same origin as `serverUrl`: the same scheme, host and port. Only
 * `http:` and `https:` qualify. Call it before attaching credentials to a request, and before
 * following a redirect with them.
 */
export function isSameOrigin(
  target: string | URL,
  serverUrl: string | URL,
): boolean {
  const left = toUrl(target)
  const right = toUrl(serverUrl)
  if (left === null || right === null) return false
  if (left.protocol !== "http:" && left.protocol !== "https:") return false
  return left.origin === right.origin
}
