/**
 * Cross-site request forgery guard for cookie-authenticated APIs.
 *
 * A browser attaches the session cookie to a request that another site starts, so a cookie alone
 * does not prove that the app's own page sent a mutation. This guard lets GET, HEAD and OPTIONS
 * through and refuses every other request unless all three hold:
 *
 *  1. the session cookie is present (unless {@link SameOriginGuardOptions.requireSessionCookie} is
 *     `false`);
 *  2. `Origin` equals an expected origin exactly, or is `null` while `Sec-Fetch-Site` is
 *     `same-origin`;
 *  3. `Sec-Fetch-Site` is `same-origin`.
 *
 * A browser sets both headers itself and a page cannot forge them. A client outside a browser can
 * forge them, but it has no victim's cookie to ride on, so this guard is not authentication.
 *
 * `Origin: null` is accepted only together with `Sec-Fetch-Site: same-origin`. A same-origin form
 * post from a page served with `Referrer-Policy: no-referrer`, the default of Hono's
 * `secureHeaders()`, arrives with exactly that pair. With any other `Sec-Fetch-Site`, or none, a
 * `null` origin is refused.
 *
 * Browsers send `Sec-Fetch-Site` only to HTTPS origins and to loopback hosts such as `localhost`.
 * Over plain HTTP on any other host they omit it, and this guard refuses every mutation there. A
 * deployment must serve the app over HTTPS, or over `localhost` in development.
 *
 * Methods are compared exactly as received. HTTP methods are case-sensitive, so a
 * lowercase `patch` or an extension method such as `PROPFIND` is checked like any other mutation.
 *
 * Mount the guard after the session guard (`isAuthenticated1FA` and friends from
 * `@spy4x/server/sign-in`). A request with an expired or missing session then gets that guard's
 * 401, which tells the front end to sign in again, instead of this guard's 403.
 *
 * `hono/csrf` is not used because it is weaker in two ways. It checks only requests whose content
 * type a plain HTML form can send, so a JSON or other mutation passes unchecked. And it passes a
 * request when either `Origin` or `Sec-Fetch-Site` looks right, where this guard requires both.
 *
 * Ported from `template/apps/api/middlewares/same-origin.ts`. What changed and why:
 *
 *  - The source found the cookie with `startsWith("<name>=")` on each `;`-separated part. The header
 *    is now parsed by Hono's cookie parser, and an empty value counts as absent.
 *  - The source checked every method. GET, HEAD and OPTIONS now pass, so the guard can be mounted
 *    on a whole router with `app.use`.
 *  - The expected origin can be configured. Behind a proxy that terminates TLS, the request URL the
 *    server sees is `http://`, while the browser sends `Origin: https://…`.
 *  - The source refused `Origin: null`, so a same-origin form post under `no-referrer` failed.
 *
 * @module
 */

import { getCookie } from "hono/cookie"
import type { Context, Env, MiddlewareHandler } from "hono"
import { SESSION_COOKIE_NAME } from "../sign-in/cookie.ts"

/** Body `error` of the default 403 response. */
export const SAME_ORIGIN_REFUSED = "Cross-origin request refused"

/**
 * Methods that must not change state, and so pass the guard unchecked. Frozen: a caller that adds a
 * method to it gets a `TypeError` instead of silently opening the guard.
 */
export const SAFE_METHODS: readonly string[] = Object.freeze(["GET", "HEAD", "OPTIONS"])

/**
 * Why the guard refused a request, passed to {@link SameOriginGuardOptions.onReject}:
 *
 *  - `no-session-cookie`: the session cookie is absent or empty.
 *  - `origin-mismatch`: `Origin` is absent, not an expected origin, or `null` without
 *    `Sec-Fetch-Site: same-origin`.
 *  - `not-same-origin-fetch`: `Sec-Fetch-Site` is absent or anything but `same-origin`.
 *
 * When several apply, the first in this order is reported.
 */
export type SameOriginRefusal = "no-session-cookie" | "origin-mismatch" | "not-same-origin-fetch"

/** Options for {@link createSameOriginMutationGuard}. */
export interface SameOriginGuardOptions<E extends Env = Env> {
  /** Name of the session cookie. Defaults to {@link SESSION_COOKIE_NAME}. */
  cookieName?: string
  /**
   * Refuse a mutating request that carries no session cookie. Defaults to `true`.
   *
   * Pass `false` on sign-in and sign-up routes, which have no cookie yet: the `Origin` and
   * `Sec-Fetch-Site` checks still run, which stops another site from signing the browser in to an
   * attacker's account.
   */
  requireSessionCookie?: boolean
  /**
   * The origins a browser may send, such as `https://app.example.com`. Defaults to the origin of
   * the request URL the server sees.
   *
   * Set it whenever that URL differs from what the browser uses, most often behind a proxy that
   * terminates TLS: the server sees `http://app.example.com` and would refuse every request. Take
   * the value from configuration, never from `X-Forwarded-*` headers, which a client can set.
   * Each value must be a bare origin (scheme, host and port only).
   */
  expectedOrigin?: string | readonly string[]
  /**
   * Builds the response for a refused request. Defaults to `403 { error: SAME_ORIGIN_REFUSED }`.
   * The reason is for logs; do not tell the client which check failed.
   */
  onReject?: (c: Context<E>, reason: SameOriginRefusal) => Response | Promise<Response>
}

/**
 * Build a Hono middleware that refuses cross-site mutations. See the module documentation for the
 * three checks and where to mount it. A request without `Sec-Fetch-Site` is refused. Browsers omit
 * it over plain HTTP on a host that is not loopback, so such a deployment has every mutation
 * refused; without the header nothing shows that the app's own page sent the request.
 *
 * @throws {TypeError} When `expectedOrigin` is empty or holds a value that is not a bare origin.
 */
export function createSameOriginMutationGuard<E extends Env = Env>(
  options: SameOriginGuardOptions<E> = {},
): MiddlewareHandler<E> {
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME
  const requireCookie = options.requireSessionCookie !== false
  const expected = options.expectedOrigin === undefined
    ? undefined
    : validateOrigins(options.expectedOrigin)
  const onReject = options.onReject ??
    ((c: Context<E>) => c.json({ error: SAME_ORIGIN_REFUSED }, 403))

  return async (c, next) => {
    if (SAFE_METHODS.includes(c.req.method)) return await next()

    const reason = refusal(c, cookieName, requireCookie, expected)
    if (reason !== undefined) return await onReject(c, reason)
    return await next()
  }
}

/**
 * The first check a mutating request fails, in the order {@link SameOriginRefusal} lists them, or
 * `undefined` when it passes all three. `expected` is `undefined` when no origin was configured,
 * and the request URL's own origin is used instead.
 */
function refusal(
  c: Context,
  cookieName: string,
  requireCookie: boolean,
  expected: readonly string[] | undefined,
): SameOriginRefusal | undefined {
  if (requireCookie) {
    const value = getCookie(c, cookieName)
    if (value === undefined || value === "") return "no-session-cookie"
  }
  const origin = c.req.header("origin")
  const sameOriginFetch = c.req.header("sec-fetch-site") === "same-origin"
  const allowed = expected ?? [new URL(c.req.url).origin]
  const originMatches = origin !== undefined &&
    (allowed.includes(origin) || (origin === "null" && sameOriginFetch))
  if (!originMatches) return "origin-mismatch"
  if (!sameOriginFetch) return "not-same-origin-fetch"
  return undefined
}

/** Check each configured origin once, at startup, so a typo fails loudly instead of refusing all. */
function validateOrigins(value: string | readonly string[]): readonly string[] {
  const origins = typeof value === "string" ? [value] : [...value]
  if (origins.length === 0) {
    throw new TypeError("expectedOrigin is empty: no request could pass the guard")
  }
  for (const origin of origins) {
    let parsed: string
    try {
      parsed = new URL(origin).origin
    } catch {
      throw new TypeError(`expectedOrigin ${JSON.stringify(origin)} is not a URL`)
    }
    if (parsed !== origin) {
      throw new TypeError(
        `expectedOrigin ${JSON.stringify(origin)} is not a bare origin such as https://example.com`,
      )
    }
  }
  return origins
}
