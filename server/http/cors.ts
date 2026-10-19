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
 * Deviations from the source, all covered by tests below:
 *  - the allowed origins are a required argument rather than a module constant
 *    baked to one product, and a resolver built from an empty allowlist throws
 *    instead of accepting every origin — the "no config" default must be refuse,
 *    and for a factory "refuse" means refusing to build;
 *  - no Chrome extension is accepted unless its exact `chrome-extension://<id>`
 *    origin is in the allowlist: the source echoed every extension's origin, so
 *    any installed extension could read credentialed responses;
 *  - plain-http loopback origins are accepted only for the hosts the caller
 *    passes as `devHosts` (none by default): the source accepted them in every
 *    deployment, so any page served from a port on the visitor's machine could.
 *
 * @module
 */

/** Options for {@link createCorsOriginResolver} and {@link resolveAllowedOrigin}. */
export interface CorsOriginOptions {
  /**
   * Origins allowed verbatim, e.g. `https://example.com`. Ports matter: a
   * production origin with `:443` is a different string and is refused unless
   * listed. Required — an omitted allowlist is a programming error, not "allow
   * everything". A Chrome extension is allowed only by listing its exact origin,
   * `chrome-extension://<id>`.
   */
  allowedOrigins: readonly string[]
  /**
   * Hosts accepted over plain `http` with any 1-65535 port, for development only.
   * Defaults to none. Pass {@link DEV_ORIGIN_HOSTS} in a development build to
   * accept the loopback hosts; never in production, where any page served from a
   * port on the visitor's machine would pass.
   */
  devHosts?: readonly string[]
}

/** Loopback and wildcard-bind hosts, for `devHosts` in a development build. Not a default. */
export const DEV_ORIGIN_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]

/**
 * Decide whether an `Origin` header value may call the API.
 *
 * Rules, in order:
 *  1. An absent/empty origin returns `undefined` (non-browser caller).
 *  2. Exact match against `allowedOrigins` returns the origin unchanged; this is
 *     the only way a `chrome-extension://` origin passes.
 *  3. `http` on one of `devHosts` (none by default), with the port elided or a
 *     valid 1-65535 integer.
 *  4. Everything else is refused — including `https://localhost`, any origin
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

  const devHosts = options.devHosts ?? []
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
  "Authorization",
]
