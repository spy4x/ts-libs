// The session cookie: a signed, HTTP-only cookie holding `<session id>:<token>`, plus a readable
// cookie holding the user id for the front end.
//
// Rewritten from `template/apps/api/services/auth/cookie.ts`. The source passed Hono's `maxAge` in
// milliseconds whenever it was given an expiry date and in seconds otherwise. Hono's `maxAge` is
// seconds, so that branch asked for a cookie a thousand times too long, and Hono throws for anything
// over 400 days. No caller in the template passed a date, so the cookie always got the full lifetime
// from the moment it was set and was never sent again when the session was extended. `Max-Age` is
// now computed in seconds from the session's own expiry, and `createAuth` sends the cookie again
// after an extension. The source's `secure` followed an `isDev` flag read from the app's config;
// here it is an option that defaults to on.

import { deleteCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie"
import type { Context } from "hono"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import { requireSecret } from "./secret.ts"

/** Default name of the signed session cookie, as in the template. */
export const SESSION_COOKIE_NAME = "sessionIdToken"

/** Default name of the readable user-id cookie, as in the template. */
export const USER_ID_COOKIE_NAME = "user_id"

/** Options for {@link SessionCookie}. */
export interface SessionCookieOptions {
  /** HMAC key that signs the session cookie, at least 32 printable characters. */
  secret: string
  /**
   * Adds the `Secure` attribute. Defaults to `true`. Pass `false` only for local development over
   * plain HTTP; a browser does not send a `Secure` cookie over an unencrypted connection.
   */
  secure?: boolean
  /** Name of the session cookie. Defaults to {@link SESSION_COOKIE_NAME}. */
  name?: string
  /** Name of the readable user-id cookie. Defaults to {@link USER_ID_COOKIE_NAME}. */
  userIdName?: string
  /** Time source for `Max-Age`. Defaults to the host clock. */
  clock?: Clock
}

/**
 * Reads, writes and clears the session cookie on a Hono context.
 *
 * Both cookies are `Path=/` and `SameSite=Lax`. The session cookie is `HttpOnly` and signed with
 * the secret, so a value the server did not issue is refused before any store lookup. The user-id
 * cookie is readable by scripts and is never read back by this module: it is a display hint, not
 * proof of anything.
 */
export class SessionCookie {
  readonly #secret: string
  readonly #secure: boolean
  readonly #name: string
  readonly #userIdName: string
  readonly #clock: Clock

  /** @throws {TypeError} When the secret is missing or shorter than 32 characters. */
  constructor(options: SessionCookieOptions) {
    this.#secret = requireSecret("secret", options.secret)
    // Only the literal `false` turns it off, so a config value that arrives as `"false"`, `0` or
    // `undefined` keeps the attribute.
    this.#secure = options.secure !== false
    this.#name = options.name ?? SESSION_COOKIE_NAME
    this.#userIdName = options.userIdName ?? USER_ID_COOKIE_NAME
    this.#clock = options.clock ?? systemClock
  }

  /** The session cookie's value, or `null` when it is absent or its signature does not verify. */
  async read(c: Context): Promise<string | null> {
    const value = await getSignedCookie(c, this.#secret, this.#name)
    return typeof value === "string" && value !== "" ? value : null
  }

  /**
   * Sets both cookies to expire with the session.
   *
   * @param session The session's user id and expiry.
   * @param value The session cookie value from `SessionManager.create`.
   * @throws {RangeError} When the session has already expired.
   */
  async set(
    c: Context,
    session: { userId: number; expiresAt: Date },
    value: string,
  ): Promise<void> {
    const maxAge = Math.floor((session.expiresAt.getTime() - this.#clock.now()) / 1000)
    if (!(maxAge > 0)) throw new RangeError("cannot set a cookie for a session that has expired")
    const attributes = {
      path: "/",
      maxAge,
      expires: session.expiresAt,
      sameSite: "Lax",
      secure: this.#secure,
    } as const
    await setSignedCookie(c, this.#name, value, this.#secret, { ...attributes, httpOnly: true })
    setCookie(c, this.#userIdName, String(session.userId), { ...attributes, httpOnly: false })
  }

  /** Tells the browser to drop both cookies. */
  clear(c: Context): void {
    const attributes = { path: "/", sameSite: "Lax", secure: this.#secure } as const
    deleteCookie(c, this.#name, { ...attributes, httpOnly: true })
    deleteCookie(c, this.#userIdName, attributes)
  }
}
