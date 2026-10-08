/**
 * Redirect URI matching: exact string match, except that a loopback URI matches on any port.
 * @module
 */

/** The callback of the hosted Claude apps (claude.ai, Desktop, mobile, Cowork). */
export const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback"

/**
 * The default redirect allowlist: the hosted Claude apps' callback, plus the two loopback
 * callbacks Claude Code declares in its client metadata document. The loopback entries match on
 * any port, because Claude Code listens on a port that changes per session.
 */
export const DEFAULT_REDIRECT_URIS: readonly string[] = Object.freeze([
  CLAUDE_REDIRECT_URI,
  "http://localhost/callback",
  "http://127.0.0.1/callback",
])

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

/** True for an `http:` URL on `localhost`, `127.0.0.1` or `[::1]`. */
export function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

function parse(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Does a requested `redirect_uri` match a registered one?
 *
 * A registered loopback URI (`http://localhost/…`, `http://127.0.0.1/…`, `http://[::1]/…`)
 * matches a request on the same host, path and query with any port, as RFC 8252 section 7.3 asks
 * for native apps; `localhost` and `127.0.0.1` do not stand in for each other. Every other URI
 * must be identical, character for character. A request with a fragment or user info never
 * matches.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  const asked = parse(requested)
  const known = parse(registered)
  if (asked === undefined || known === undefined) return false
  if (asked.hash !== "" || requested.includes("#")) return false
  if (asked.username !== "" || asked.password !== "") return false
  if (isLoopbackRedirect(known)) {
    return isLoopbackRedirect(asked) && asked.hostname === known.hostname &&
      asked.pathname === known.pathname && asked.search === known.search
  }
  return requested === registered
}

/**
 * Check a redirect allowlist at startup: every entry must be an absolute `https:` URL or an
 * `http:` loopback URL, without a fragment or user info.
 *
 * @throws {TypeError} Naming the first entry that breaks the rule.
 */
export function assertRedirectAllowlist(uris: readonly string[]): void {
  if (uris.length === 0) throw new TypeError("redirectUris must list at least one URI")
  for (const uri of uris) {
    const url = parse(uri)
    const allowed = url !== undefined && url.hash === "" && !uri.includes("#") &&
      url.username === "" && url.password === "" &&
      (url.protocol === "https:" || isLoopbackRedirect(url))
    if (!allowed) {
      throw new TypeError(`redirect URI ${uri} must be https, or http on a loopback host`)
    }
  }
}
