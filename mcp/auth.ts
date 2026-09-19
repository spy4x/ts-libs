// ── Bearer token verification ──
// The token is caller-supplied (a port). It is never read from the environment at
// module scope, never read from a query parameter, and the comparison is constant
// time: a byte-by-byte `===` on a bearer token is a timing oracle.

import { timingSafeEqual } from "@std/crypto/timing-safe-equal"

/** The canonical redaction marker. Used by every log path that could see a credential. */
export const REDACTED_TOKEN = "<REDACTED:TOKEN>"

/** Verifies a bearer token presented by a client. */
export interface TokenVerifier {
  /** True only for an exact, configured token. Never called with an absent header. */
  verify(token: string): Promise<boolean>
}

/** The header a token is read from. No alternative source exists by design. */
export const AUTHORIZATION_HEADER = "authorization"

/**
 * Extract the token from `Authorization`. Accepts `Bearer <token>` and a bare
 * `<token>`, the two forms the source accepted from this header. Returns `undefined`
 * for a missing or malformed header. Query parameters are deliberately not consulted:
 * `?api_key=` ends up in proxy and access logs.
 */
export function bearerTokenFromHeaders(headers: Headers): string | undefined {
  const raw = headers.get(AUTHORIZATION_HEADER)
  if (raw === null) return undefined

  const value = raw.trim()
  if (value.length === 0) return undefined

  const match = /^bearer\s+(.+)$/i.exec(value)
  const token = (match ? match[1] : value).trim()
  return token.length === 0 ? undefined : token
}

/**
 * Compare two tokens in constant time. Both sides are SHA-256 digested first, so the
 * comparison runs over two equal-length 32-byte digests regardless of input length —
 * neither the length nor a shared prefix of `presented` can be probed by timing.
 * A missing configured token never verifies.
 */
export async function constantTimeEquals(presented: string, expected: string): Promise<boolean> {
  if (presented.length === 0 || expected.length === 0) return false

  const [presentedDigest, expectedDigest] = await Promise.all([
    digest(presented),
    digest(expected),
  ])
  // Digests are fixed width by construction, but keep the guard so a future change
  // cannot turn `timingSafeEqual` into a silent `false`.
  if (presentedDigest.byteLength !== expectedDigest.byteLength) return false
  return timingSafeEqual(presentedDigest, expectedDigest)
}

/**
 * Build a verifier over one configured token. The token is passed in, never read from
 * `Deno.env` here — an entry point calls {@link bearerTokenFromEnv} at startup instead,
 * so a module import can never pick up a credential.
 */
export function createTokenVerifier(token: string): TokenVerifier {
  if (token.length === 0) {
    throw new Error("createTokenVerifier requires a non-empty token: refusing to fail open")
  }
  // Pre-digest the configured token once. The comparison stays constant time; this
  // only avoids hashing the same value on every request.
  const expectedDigest = digest(token)
  return {
    async verify(presented: string): Promise<boolean> {
      if (presented.length === 0) return false
      const presentedDigest = await digest(presented)
      return timingSafeEqual(presentedDigest, await expectedDigest)
    },
  }
}

/**
 * Read a bearer token from the environment. The environment is passed in explicitly —
 * there is no `Deno.env` default — so an entry point has to opt in at startup and no
 * import can pick up a credential as a side effect. Throws on a missing or empty value,
 * so a misconfigured server fails at startup instead of serving unauthenticated.
 */
export function bearerTokenFromEnv(name: string, env: Pick<typeof Deno.env, "get">): string {
  const value = env.get(name)
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set: refusing to start an authenticated transport without it`)
  }
  return value
}

/**
 * Redact every occurrence of `secrets` in one log line. Returns a replacement function
 * suitable for `String.prototype.replace` and for `formatLogLine`, so no log path can
 * emit a credential by forgetting to call it.
 */
export function redactor(
  secrets: ReadonlyArray<string | undefined>,
): (input: string) => string {
  const known = secrets.filter((secret): secret is string =>
    typeof secret === "string" && secret.length > 0
  )
  return (input: string): string => {
    let output = input
    for (const secret of known) {
      output = output.split(secret).join(REDACTED_TOKEN)
    }
    return output
  }
}

/**
 * Format a log line with every argument redacted. The transport logs through this, so a
 * raw `Authorization` header cannot be interpolated into a log by accident.
 */
export function formatLogLine(
  level: string,
  message: string,
  secrets: ReadonlyArray<string | undefined>,
): string {
  const redact = redactor(secrets)
  return `[${level.toUpperCase()}] ${redact(message)}`
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
}
