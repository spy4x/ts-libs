/**
 * CORS origin allow-listing for browser-facing APIs.
 *
 * The allowlist is exact-match on the serialised origin string: no wildcards, no
 * suffix matching, no case folding. A callback/SPA origin is attacker-supplied,
 * so every rule here is a rejection rule first — an origin that is not
 * *positively* recognised is refused.
 *
 * Server-to-server and MCP clients send no `Origin` header at all; those calls
 * return `undefined` (no CORS headers), which is not a rejection — browsers only
 * enforce CORS when an `Origin` is present.
 *
 * Deviations from the `offer-lens` source, both covered by tests below:
 *  - the allowed origins are a required argument rather than a module constant
 *    baked to one product, and a resolver built from an empty allowlist throws
 *    instead of accepting every origin — the "no config" default must be refuse,
 *    and for a factory "refuse" means refusing to build;
 *  - `chrome-extension://` is validated by shape before the WHATWG round-trip, so
 *    a non-origin scheme cannot be smuggled through `URL`.
 *
 * @module
 */

/** Options for {@link createCorsOriginResolver} and {@link resolveAllowedOrigin}. */
export interface CorsOriginOptions {
  /**
   * Origins allowed verbatim, e.g. `https://example.com`. Ports matter: a
   * production origin with `:443` is a different string and is refused unless
   * listed. Required — an omitted allowlist is a programming error, not "allow
   * everything".
   */
  allowedOrigins: readonly string[]
  /** HTTP dev hosts accepted with any 1-65535 port. Defaults to {@link DEV_ORIGIN_HOSTS}. */
  devHosts?: readonly string[]
}

/** Loopback and wildcard-bind hosts accepted over plain `http` in development. */
export const DEV_ORIGIN_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]

/** Chrome extension ids are 32 characters from `a` to `p` (16 hex-ish symbols). */
const CHROME_EXTENSION_ID = /^[a-p]{32}$/

const CHROME_EXTENSION_SCHEME = "chrome-extension://"

/**
 * Decide whether an `Origin` header value may call the API.
 *
 * Rules, in order:
 *  1. An absent/empty origin returns `undefined` (non-browser caller).
 *  2. Exact match against `allowedOrigins` returns the origin unchanged.
 *  3. `chrome-extension://<32 a-p chars>` returns the origin; anything else on
 *     that scheme, including a trailing slash, is refused.
 *  4. `http` on a dev host, with the port elided or a valid 1-65535 integer.
 *  5. Everything else is refused — including `https://localhost`, any origin
 *     carrying a path, query, fragment, userinfo or trailing slash, and any
 *     host that is not in the exact-match allowlist.
 *
 * The value must round-trip through the WHATWG `URL` parser unchanged
 * (`parsed.origin === origin`), which is what rejects a smuggled path, query,
 * fragment, userinfo or trailing slash in one check.
 *
 * @param origin Raw `Origin` header value.
 * @param options Allowlist plus the dev-host set.
 * @returns The origin to echo in `Access-Control-Allow-Origin`, or `undefined`.
 */
export function resolveAllowedOrigin(
  origin: string | undefined | null,
  options: CorsOriginOptions,
): string | undefined {
  if (!origin) return undefined

  const allowed = new Set(options.allowedOrigins)
  if (allowed.has(origin)) return origin

  if (origin.startsWith(CHROME_EXTENSION_SCHEME)) {
    const id = origin.slice(CHROME_EXTENSION_SCHEME.length)
    return CHROME_EXTENSION_ID.test(id) ? origin : undefined
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return undefined
  }
  if (parsed.origin !== origin) return undefined

  // `https://localhost` is not a production origin, and it must not inherit the
  // dev allowance just because the host matches.
  if (parsed.protocol !== "http:") return undefined

  const devHosts = options.devHosts ?? DEV_ORIGIN_HOSTS
  if (!devHosts.includes(parsed.hostname.toLowerCase())) return undefined

  if (parsed.port === "") return origin
  const port = Number(parsed.port)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? origin : undefined
}

/**
 * Build the origin callback `hono/cors` expects.
 *
 * `hono/cors` reads a returned string as the value for
 * `Access-Control-Allow-Origin` and an empty string as "no header", so a
 * refusal maps to `""` rather than `undefined`.
 *
 * @throws {TypeError} When `allowedOrigins` is empty. An empty allowlist is a
 * misconfiguration, and the alternative — a resolver that accepts every origin —
 * is a silent CORS bypass.
 */
export function createCorsOriginResolver(
  options: CorsOriginOptions,
): (origin: string | undefined, c: unknown) => string {
  if (!options.allowedOrigins.length) {
    throw new TypeError("createCorsOriginResolver requires at least one allowed origin")
  }
  const config: CorsOriginOptions = {
    allowedOrigins: [...options.allowedOrigins],
    devHosts: options.devHosts,
  }
  return (origin: string | undefined, _c: unknown): string =>
    resolveAllowedOrigin(origin, config) ?? ""
}

/** Methods allow-listed for browser CORS preflight. */
export const CORS_ALLOW_METHODS: readonly string[] = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]

/** Request headers allow-listed for browser CORS preflight. */
export const CORS_ALLOW_HEADERS: readonly string[] = [
  "Content-Type",
  "X-Session-Id",
  "Authorization",
]
