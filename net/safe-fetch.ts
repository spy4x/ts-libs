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
 */

import {
  defaultResolver,
  type DnsResolver,
  UrlValidationError,
  validatePublicUrl,
} from "./url-policy.ts"

/** Redirects followed before the chain is refused. */
export const DEFAULT_MAX_REDIRECTS = 3

/** Total budget for the whole redirect chain. */
export const DEFAULT_TIMEOUT_MS = 10_000

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
  /** Maximum number of redirects to follow. Defaults to 3. */
  maxRedirects?: number
  /**
   * Total timeout covering the in-flight fetcher, shared by every hop.
   * Defaults to 10s. Must be a positive number of milliseconds.
   */
  timeoutMs?: number
  /** Fetcher implementation; defaults to the global `fetch`. */
  fetcher?: Fetcher
  /** Request headers (e.g. User-Agent). */
  headers?: Record<string, string>
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
 * @throws `UrlValidationError` when the initial URL or any redirect target
 * fails the policy, when a redirect carries no `Location`, or when the chain
 * exceeds `maxRedirects`.
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
  const resolver = options.resolver ?? defaultResolver
  let method = options.method ?? SafeFetchMethod.Get

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let currentUrl = await validatePublicUrl(startUrl, { resolver })

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await fetcher.fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        method,
        headers: options.headers,
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
      if (!location) {
        await tryCancel(response)
        throw new UrlValidationError(
          "invalid_redirect",
          "Redirect response missing Location header",
        )
      }

      // Resolve relative Locations against the current URL, then validate the
      // result through the full public-URL policy (scheme, host, credentials,
      // IP family, DNS). This is the only place a redirect target is allowed to
      // become a request target.
      const next = new URL(location, currentUrl)
      currentUrl = await validatePublicUrl(next.href, { resolver })

      if (response.status === 301 || response.status === 302 || response.status === 303) {
        method = SafeFetchMethod.Get
      }

      // Drop the redirect response so the next iteration can issue a fresh
      // fetch against the new URL.
      await tryCancel(response)
    }

    // Unreachable: the loop returns or throws.
    throw new UrlValidationError("too_many_redirects", "Exceeded redirect limit")
  } finally {
    clearTimeout(timer)
  }
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
