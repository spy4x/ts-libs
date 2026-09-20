/**
 * Safe HTTP fetch.
 *
 * Validates the URL — and every redirect target — through `validatePublicUrl`,
 * uses `redirect: "manual"` so each `Location` is inspected before it is
 * followed, and keeps a single `AbortController` alive across the whole
 * redirect chain so one timeout governs the entire exchange.
 *
 * PRECISE TRADE-OFF — DNS latency is NOT bounded by the timeout:
 *   - The `AbortController` + timer are created before the first
 *     `validatePublicUrl` so a slow `fetcher.fetch()` can be aborted mid-call.
 *   - `DnsResolver.resolve()` does not accept an `AbortSignal` (see
 *     `url-policy.ts`). A slow resolver keeps `await validatePublicUrl(...)`
 *     blocked until the resolver itself settles, even after the timer fired.
 *     The timer is cleared in `finally` either way.
 *   - Callers that need a hard upper bound on DNS must enforce it inside their
 *     own `DnsResolver` implementation.
 *
 * Body-read timeouts (after headers arrive) are handled separately by
 * `net/bounded-body`: once `safeFetch` returns, its timer is gone and a stalled
 * body is governed by the caller's read budget.
 *
 * RELATIVE LOCATIONS: a `Location` that does not parse standalone is resolved
 * against the current URL (`new URL(location, currentUrl)`), which is what
 * RFC 9110 requires. A `Location` that parses to a non-http(s) scheme — a
 * crafted `javascript:` header, say — is rejected by the policy, never fetched.
 *
 * CREDENTIALS DO NOT CROSS AN ORIGIN: taking redirect handling away from the
 * platform `fetch` also took away its header rules, so the caller's
 * `Authorization`, `Cookie` and `Proxy-Authorization` are dropped here the
 * moment a hop changes origin — see `CREDENTIAL_HEADERS`.
 */

import {
  defaultResolver,
  type DnsResolver,
  UrlValidationError,
  validatePublicUrl,
} from "./url-policy.ts"

/** Redirects followed before the chain is refused. */
export const DEFAULT_MAX_REDIRECTS: number = 3

/** Total budget for the whole redirect chain. */
export const DEFAULT_TIMEOUT_MS: number = 10_000

/**
 * Request headers that must not follow a redirect to another origin.
 *
 * Lower-case, because a caller's header record is keyed however they spelled it
 * and HTTP field names are case-insensitive. The list is the one the platform
 * `fetch` strips on a cross-origin redirect: everything that authenticates the
 * caller to the origin it was addressed to and to nobody else.
 *
 * It is the standard names only, exactly like the platform. A house header that
 * carries a secret — `X-Api-Key`, `X-Auth-Token` — is not on it and does follow
 * a redirect to another origin. A caller who sends one either adds it to the
 * request only when it is needed, or does not use `safeFetch` for that request.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "proxy-authorization",
]

/** Request methods a redirect is allowed to carry unchanged. */
export enum SafeFetchMethod {
  Get = "GET",
  Head = "HEAD",
  Post = "POST",
  Put = "PUT",
}

/**
 * The seam that keeps this module off the network in tests.
 *
 * Mirrors the platform `fetch` signature for the two options `safeFetch` sets:
 * `redirect` is always `"manual"` — it is in the type so no implementation can
 * silently opt back into automatic redirects, which would bypass the
 * re-validation this module exists for.
 */
export interface Fetcher {
  fetch(
    input: string,
    init: {
      signal?: AbortSignal
      redirect: "manual"
      method?: string
      headers?: Record<string, string>
    },
  ): Promise<Response>
}

export const defaultFetcher: Fetcher = {
  fetch: (input, init) =>
    fetch(input, {
      redirect: init.redirect,
      signal: init.signal,
      method: init.method,
      headers: init.headers,
    }),
}

export interface SafeFetchOptions {
  /** Resolver for DNS lookups; defaults to `defaultResolver`. */
  resolver?: DnsResolver
  /**
   * Maximum number of redirects to follow before the chain is refused.
   * Defaults to `DEFAULT_MAX_REDIRECTS` (3).
   *
   * Counts hops, not requests: `maxRedirects: 3` issues up to **4** requests —
   * the original plus one per followed `Location`.
   */
  maxRedirects?: number

  /**
   * Total timeout covering the in-flight fetcher, shared by every hop.
   * Defaults to 10s. Must be a positive number of milliseconds.
   */
  timeoutMs?: number
  /** Fetcher implementation; defaults to the global `fetch`. */
  fetcher?: Fetcher
  /**
   * Request headers, in any shape the platform `fetch` accepts: a `Headers`, an
   * array of name/value pairs, or a plain object.
   *
   * Whatever arrives is normalised through the platform `Headers` before
   * anything in this module reads it, so the names compared against
   * `CREDENTIAL_HEADERS` are real header names rather than whatever keys the
   * value happened to have. Anything the platform refuses — a malformed pair, an
   * invalid name, a value with a newline in it — is refused here too, with
   * `UrlValidationError` and code `invalid_format`.
   */
  headers?: HeadersInit
  /** Request method. Defaults to `GET`. */
  method?: SafeFetchMethod | string
}

export interface SafeFetchResult {
  /** Final canonical URL after any redirects. */
  url: string
  /** The response whose `url` was `url` — never a redirect response. */
  response: Response
}

/**
 * Fetch a URL following redirects manually, validating each `Location` through
 * the public-URL policy.
 *
 * A redirect is consumed and its body cancelled before the next hop, so a
 * refused chain does not leak a socket or an unread stream.
 *
 * Method handling follows RFC 9110: a 301/302/303 downgrades any non-`GET`/`HEAD`
 * request to `GET`; a 307/308 preserves the method.
 *
 * `options.headers` are normalised through the platform `Headers`, sent on the
 * first request and carried along the chain, except that the headers in
 * `CREDENTIAL_HEADERS` are dropped as soon as a hop lands on a different origin
 * — and stay dropped for the rest of the chain, so neither a bounce back to the
 * first origin nor a further hop inside the second one gets them back.
 *
 * @throws `UrlValidationError` when the initial URL or any redirect target
 * fails the policy, when a redirect carries no `Location`, when the chain
 * exceeds `maxRedirects`, or when an option — `timeoutMs`, `maxRedirects`,
 * `headers` — is not something this module can use.
 */
export async function safeFetch(
  startUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetcher = options.fetcher ?? defaultFetcher
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new UrlValidationError(
      "invalid_format",
      "timeoutMs must be a positive number of milliseconds",
    )
  }
  // `NaN` is what `Number(process.env.MAX_REDIRECTS)` gives for a typo, and it
  // compares false against everything: the loop would end on its first turn and
  // report "too many redirects" for a chain of none. `Infinity` would let the
  // chain run until the timeout instead of until the cap.
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new UrlValidationError(
      "invalid_format",
      "maxRedirects must be a non-negative whole number",
    )
  }
  const resolver = options.resolver ?? defaultResolver
  let method = options.method ?? SafeFetchMethod.Get
  let headers = normalizeHeaders(options.headers)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let currentUrl = await validatePublicUrl(startUrl, { resolver })

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await fetcher.fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        method,
        headers,
      })

      if (!isRedirectStatus(response.status)) {
        return { url: currentUrl, response }
      }

      if (hop === maxRedirects) {
        // Consume the redirect body so the socket can be reused, then throw.
        await tryCancel(response)
        throw new UrlValidationError(
          "too_many_redirects",
          `Exceeded ${maxRedirects} redirects`,
        )
      }

      const location = response.headers.get("location")

      // Nothing below reads the redirect body, and everything below can throw.
      // Cancelling here — before the header is even looked at — is what makes
      // "a refused chain does not leak a socket" true on every path out of this
      // loop, rather than on the two that were remembered.
      await tryCancel(response)

      if (!location) {
        throw new UrlValidationError(
          "invalid_redirect",
          "Redirect response missing Location header",
        )
      }

      // Resolve relative Locations against the current URL, then validate the
      // result through the full public-URL policy (scheme, host, credentials,
      // IP family, DNS). This is the only place a redirect target is allowed to
      // become a request target.
      //
      // The `Location` is upstream's text, so a value the URL parser refuses is
      // a bad redirect, not a bug here: it leaves as this module's own error
      // with a code a caller can branch on, never as a raw `TypeError`. The
      // value itself is left out of the message — it is attacker-chosen text and
      // this message reaches logs.
      let next: URL
      try {
        next = new URL(location, currentUrl)
      } catch {
        throw new UrlValidationError(
          "invalid_redirect",
          "Redirect Location is not a valid URL",
        )
      }
      const target = await validatePublicUrl(next.href, { resolver })
      headers = headersForHop(headers, currentUrl, target)
      currentUrl = target

      method = methodAfterRedirect(response.status, method)
    }

    // Unreachable: the loop returns or throws.
    throw new UrlValidationError("too_many_redirects", "Exceeded redirect limit")
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The method the next hop is issued with, per RFC 9110 §15.4.
 *
 * A 303 rewrites everything to `GET`, a 301 or 302 rewrites everything that is
 * not already `GET`, and 307/308 exist precisely so nothing is rewritten.
 * `HEAD` is never rewritten by any of them: turning it into a `GET` downloads a
 * body the caller asked not to receive, which is the opposite of what a caller
 * who wrote `HEAD` wanted. The comparison is case-insensitive because `method`
 * is a free string as well as a `SafeFetchMethod`.
 */
function methodAfterRedirect(status: number, method: string): string {
  const upper = method.toUpperCase()
  if (upper === SafeFetchMethod.Head) return method
  if (status === 303) return SafeFetchMethod.Get
  if (status === 301 || status === 302) {
    return upper === SafeFetchMethod.Get ? method : SafeFetchMethod.Get
  }
  return method
}

/**
 * Turn whatever the caller passed into a record of real header names.
 *
 * The platform `Headers` is the parser for every shape `fetch` takes, so it is
 * the parser here: a `Headers`, an array of pairs and a plain object all come
 * out as lower-cased names with their values, and nothing else gets past.
 *
 * This is a security boundary, not a convenience. Reading an array of pairs
 * with `Object.entries` gives the *indices* as names — `0`, `1` — and the pair
 * as the value, so a credential crosses an origin under a name no list of
 * credential headers will ever match, with the secret still in the value. A
 * `Headers` object read the same way gives nothing at all, and the caller's
 * headers silently vanish. One parser removes both.
 *
 * @throws `UrlValidationError` with code `invalid_format` for anything the
 * platform refuses, which includes an invalid header name and a value carrying
 * a newline.
 */
function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> | undefined {
  if (init === undefined) return undefined
  let parsed: Headers
  try {
    parsed = new Headers(init)
  } catch {
    throw new UrlValidationError(
      "invalid_format",
      "headers must be a Headers, an array of name/value pairs, or a plain object",
    )
  }
  return Object.fromEntries(parsed)
}

/**
 * The headers the next hop may carry.
 *
 * Same origin — same scheme, host and port — keeps the record untouched. Any
 * other target gets a copy without the `CREDENTIAL_HEADERS`, matched
 * case-insensitively because a caller's record is keyed however they spelled it.
 *
 * Origin, not registrable domain: `https://pay.example.com` and
 * `https://blog.example.com` are one site and two origins, and a guard whose
 * whole job is to distrust the destination has no reason to hand a token to the
 * second because the first asked it to.
 */
function headersForHop(
  headers: Record<string, string> | undefined,
  fromUrl: string,
  toUrl: string,
): Record<string, string> | undefined {
  if (!headers) return headers
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return headers
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.includes(name.toLowerCase())) continue
    kept[name] = value
  }
  return kept
}

async function tryCancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Body may already be consumed; ignore.
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308
}
