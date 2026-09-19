/**
 * Origin comparison for the credential rule, in one module.
 *
 * Internal: not in the package's export map, because it is the primitive the
 * rule is *built* from, not a policy a caller needs. The policies live in
 * `client.ts` (`requestHeaders`, the single credential gate, and the two
 * `crossOrigin*Warning` functions) and in `ical.ts` (`resourceUrl`).
 *
 * Both functions fail **closed**: an origin that cannot be read as `http(s)` is
 * never treated as equal to anything, so "cannot tell" never reads as "same
 * origin". That direction is the whole point — a comparison that fails open is a
 * comparison an attacker chooses the input to, and a `URL`'s own `origin`
 * property is `"null"` for every non-`http(s)` scheme, which would make
 * `file:///etc/passwd` and `file:///tmp/x/` look like one origin.
 */

/**
 * Origin of an absolute `http(s)` URL as `scheme://host:port`, else `undefined`.
 *
 * Composed from the parsed parts rather than read from `URL.origin`, which is the
 * string `"null"` for any non-`http(s)` scheme and would therefore compare equal
 * across unrelated URLs. `new URL` has already lower-cased the host, punycoded an
 * IDN, dropped a default port and resolved `..` by the time this runs, so the
 * string is not fakeable with a lookalike.
 *
 * `undefined` means "not comparable", and every caller treats it as "not the
 * configured origin": a non-`http(s)` `baseUrl` (the constructor accepts any
 * absolute URL), a relative URL, a URL a protocol-relative `//host/x` has not
 * been resolved against anything yet, and unparseable text.
 *
 * @param url URL to read the origin from.
 * @returns `scheme://host:port`, or `undefined` when there is no comparable one.
 */
export function originOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return `${parsed.protocol}//${parsed.host}`
}

/**
 * True only when both URLs are absolute `http(s)` URLs with the same origin.
 *
 * The comparison includes the port, so `https://host:8443/` and `https://host/`
 * are different origins, and it excludes the path, so a deeper path on the
 * configured origin is the same origin — which is the normal shape of a CalDAV
 * URL. A trailing-dot host (`caldav.example.com.`) is *not* folded to the same
 * host as `caldav.example.com`: DNS treats them alike, a string comparison does
 * not, and the safe direction here is to refuse.
 *
 * @param left One URL, typically the request destination.
 * @param right The other, typically the configured `baseUrl`.
 * @returns whether the two share an origin that both sides could be read for.
 */
export function sameOrigin(left: string, right: string): boolean {
  const leftOrigin = originOf(left)
  const rightOrigin = originOf(right)
  return leftOrigin !== undefined && rightOrigin !== undefined && leftOrigin === rightOrigin
}
