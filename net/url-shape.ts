/**
 * Shape-only URL normalisation for user-entered URLs.
 *
 * Pure and dependency-free: it parses with the platform `URL`, and it does no
 * DNS, no allow-listing beyond `http`/`https`, and no fetching. Anything that
 * needs to decide whether a host is safe to call is `net/url-policy`.
 */

/** Machine-readable rejection reason. */
export type UrlShapeErrorCode =
  | "empty"
  | "unsupported_protocol"
  | "invalid_format"
  | "invalid_hostname"

/** Rejected input, with the reason a caller can branch on. */
export interface UrlShapeError {
  ok: false
  code: UrlShapeErrorCode
  message: string
}

export interface UrlShapeOk {
  ok: true
  /** Normalised URL: lowercased scheme and host, default port stripped. */
  url: string
}

export type NormalizeUrlShapeResult = UrlShapeOk | UrlShapeError

/**
 * Narrow a `normalizeUrlShape` result to its success branch.
 *
 * Exported so `net/url-policy` — which forks the shape rules it needs to keep —
 * can assert the shape contract on the input it shares with this module.
 */
export function isUrlShapeOk(result: NormalizeUrlShapeResult): result is UrlShapeOk {
  return result.ok
}

export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

/**
 * Any `scheme:` prefix, with or without `//`, so `javascript:` is caught too.
 *
 * Shared with `net/url-policy` so both layers agree on what counts as an
 * explicit scheme — a scheme-less `example.com:8443` must not be read as one.
 * The pattern carries no `/g` flag, so `.exec()` holds no `lastIndex` state.
 */
export const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** A hostname that is a plain DNS label run: no `:`, no brackets, no dots. */
export const PLAIN_HOSTNAME = /^[a-z0-9_-]+$/i

// The control-character range is the point of this pattern.
// deno-lint-ignore no-control-regex
export const INVALID_CHARACTERS = /[\s\u0000-\u001f\u007f]/

export const EMPTY_MESSAGE = "Enter a URL"
export const UNSUPPORTED_PROTOCOL_MESSAGE = "URL must start with http:// or https://"
export const INVALID_FORMAT_MESSAGE = "Invalid URL format"
export const INVALID_CHARACTERS_MESSAGE = "URL contains invalid characters"

/**
 * Split an explicit `scheme:` prefix off the raw input.
 *
 * A dotted candidate is a host with a port, not a scheme: `example.com:8443` is
 * scheme-less input, while `javascript:` and `data:` are schemes.
 *
 * @param raw Trimmed input.
 * @returns Whether a scheme was written, and its lowercased name without `:`.
 */
export function detectScheme(raw: string): { hadScheme: boolean; scheme: string } {
  const candidate = EXPLICIT_SCHEME.exec(raw)?.[1]
  const hadScheme = candidate !== undefined && !candidate.includes(".")
  return { hadScheme, scheme: hadScheme ? candidate.toLowerCase() : "" }
}

/**
 * Normalise the shape of a user-entered URL.
 *
 * Rules:
 *  - Trims surrounding whitespace.
 *  - Adds `https://` when the input carries no scheme.
 *  - Accepts only `http://` and `https://`. `javascript:`, `data:`, `file:` and
 *    friends are rejected, never rewritten.
 *  - Requires a hostname containing at least one dot, so `localhost` and bare
 *    IPs-shaped typos such as `.com` are refused, as are bracketed IPv6
 *    literals. This is a shape check for user-entered public origins, not a
 *    safety check — `net/url-policy` accepts those forms on purpose so it can
 *    reject them with a policy code instead.
 *  - Lowercases the scheme and the host; path, query and fragment keep their case.
 *  - Strips a default port (`:443` on https, `:80` on http) and keeps any other.
 *  - Preserves the absence of a trailing slash when the input had no path.
 *
 * Deviations from the `offer-lens` source this was ported from, all covered by
 * tests below: the port is no longer dropped, `example.com:8443` is no longer
 * mistaken for a scheme, and a slash inside the query is no longer mistaken for
 * a path.
 *
 * @param input Raw user input. A non-string throws (the type forbids it).
 * @returns `{ ok: true, url }`, or `{ ok: false, code, message }`.
 */
export function normalizeUrlShape(input: string): NormalizeUrlShapeResult {
  const raw = input.trim()
  if (!raw) {
    return { ok: false, code: "empty", message: EMPTY_MESSAGE }
  }

  // Control characters and embedded whitespace are never valid in a URL.
  if (INVALID_CHARACTERS.test(raw)) {
    return { ok: false, code: "invalid_format", message: INVALID_CHARACTERS_MESSAGE }
  }

  const { hadScheme, scheme } = detectScheme(raw)

  if (hadScheme && !ALLOWED_PROTOCOLS.has(`${scheme}:`)) {
    return {
      ok: false,
      code: "unsupported_protocol",
      message: UNSUPPORTED_PROTOCOL_MESSAGE,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(hadScheme ? raw : `https://${raw}`)
  } catch {
    return { ok: false, code: "invalid_format", message: INVALID_FORMAT_MESSAGE }
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      code: "unsupported_protocol",
      message: UNSUPPORTED_PROTOCOL_MESSAGE,
    }
  }

  const host = parsed.hostname
  if (!host || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    return { ok: false, code: "invalid_hostname", message: "Invalid domain" }
  }

  // `URL` always reports `/` for an empty path, so input typed without one would
  // come back with a trailing slash. Strip the scheme and the authority from the
  // raw input and ask whether a path was actually typed — looking for a slash
  // anywhere would read `example.com?a=/b` as having one.
  const afterAuthority = raw
    .replace(EXPLICIT_SCHEME, "")
    .replace(/^\/\//, "")
    .replace(/^[^/?#]*/, "")
  const path = parsed.pathname === "/" && !afterAuthority.startsWith("/") ? "" : parsed.pathname

  // `parsed.host` carries the port only when it is not the scheme default —
  // `URL` already strips `:443` and `:80` — so the port survives here instead of
  // being silently dropped into a different origin.
  return {
    ok: true,
    url: `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`,
  }
}
