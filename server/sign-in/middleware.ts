// Hono middleware: resolve the session cookie to `c.get("auth")`, and guard routes on it.
//
// Rewritten from `template/apps/api/middlewares/auth-guards.ts`, `auth.ts` and the request half of
// `template/apps/api/services/auth/+index.ts`. What changed and why:
//
// - `createParseAuth` stored its result with `c.set("auth", authData!)`, asserting away a possible
//   `null`. `auth` is now typed `AuthState | null` and is always set, to `null` when there is no
//   session.
// - `isRole` checked only that someone was signed in, so a user who had given a password but not
//   yet the second factor passed a role guard unless the route also mounted `isAuthenticated2FA`.
//   Its replacement, `isAuthorized`, refuses an incomplete second factor before it runs the check.
//   Roles themselves are the app's: the check is a function the app passes.
// - The 2FA guard let every session through whenever the user had no second factor configured,
//   including one still marked as owing it and one carrying a value the guard did not know. Only
//   `NotRequired` (for a user without a second factor) and `Completed` pass now.
// - When a session was extended the cookie was not sent again, so the browser dropped it at the
//   original expiry. `parseAuth` re-sends it after an extension.

import { createMiddleware } from "hono/factory"
import type { Context, MiddlewareHandler } from "hono"
import type { SessionCookie } from "./cookie.ts"
import {
  type NewSessionFields,
  SecondFactorStatus,
  type SessionManager,
  type SessionRecord,
} from "./session.ts"

/** Body of the 401 response when there is no valid session. */
export const NOT_AUTHENTICATED = "Not authenticated"
/** Body of the 401 response when the second factor is still owed. */
export const SECOND_FACTOR_REQUIRED = "Need to pass 2FA"
/** Body of the 403 response when the app's check refuses. */
export const NOT_AUTHORIZED = "Not authorized"

/** What `parseAuth` stores under `c.get("auth")` for a valid session. */
export interface AuthState<S extends SessionRecord, U> {
  session: S
  user: U
}

/** The Hono environment the middleware reads and writes. Intersect it with the app's own. */
export interface AuthEnv<S extends SessionRecord, U> {
  Variables: { auth: AuthState<S, U> | null }
}

/** Options for {@link createAuth}. */
export interface AuthOptions<S extends SessionRecord, U> {
  sessions: SessionManager<S>
  cookie: SessionCookie
  /**
   * The user a session belongs to, or `null` when the user no longer exists or may not sign in.
   * `null` clears the cookie and leaves the request unauthenticated.
   */
  loadUser(userId: number): Promise<U | null>
  /**
   * Whether the user has a second factor configured. When it returns `true`, only a session whose
   * second factor is `Completed` passes `isAuthenticated2FA` and `isAuthorized`.
   */
  hasSecondFactor(user: U): boolean
}

/** The middleware and request helpers {@link createAuth} returns. */
export interface Auth<S extends SessionRecord, U> {
  /**
   * Reads the session cookie and sets `c.get("auth")` to the session and user, or to `null`. Clears
   * the cookie when it names no valid session or no user. Never rejects a request itself.
   */
  parseAuth: MiddlewareHandler<AuthEnv<S, U>>
  /** 401 without a valid session. Does not look at the second factor. */
  isAuthenticated1FA: MiddlewareHandler<AuthEnv<S, U>>
  /** 401 without a valid session, and 401 while the second factor is owed. */
  isAuthenticated2FA: MiddlewareHandler<AuthEnv<S, U>>
  /** As {@link isAuthenticated2FA}, then 403 unless `check` returns `true`. */
  isAuthorized(
    check: (auth: AuthState<S, U>) => boolean | Promise<boolean>,
  ): MiddlewareHandler<AuthEnv<S, U>>
  /** Creates a session and sets its cookie. For a sign-in route, after the credentials checked out. */
  startSession(c: Context, fields: NewSessionFields<S>): Promise<S>
  /** Signs out the session in the request's cookie, if any, and clears the cookie. */
  endSession(c: Context<AuthEnv<S, U>>): Promise<void>
}

/**
 * Builds the session middleware and guards over one {@link SessionManager} and
 * {@link SessionCookie}.
 *
 * Every guard fails closed: a request that never passed through `parseAuth`, a `null` state, and a
 * second-factor value it does not recognise are all refused.
 */
export function createAuth<S extends SessionRecord, U>(options: AuthOptions<S, U>): Auth<S, U> {
  const { sessions, cookie, loadUser, hasSecondFactor } = options

  const secondFactorSatisfied = (auth: AuthState<S, U>): boolean => {
    const status = auth.session.secondFactor
    if (status === SecondFactorStatus.Completed) return true
    if (status === SecondFactorStatus.NotRequired) return !hasSecondFactor(auth.user)
    return false
  }

  const parseAuth = createMiddleware<AuthEnv<S, U>>(async (c, next) => {
    c.set("auth", null)
    const value = await cookie.read(c)
    if (value !== null) {
      const valid = await sessions.validate(value)
      const user = valid ? await loadUser(valid.session.userId) : null
      if (!valid || user === null || user === undefined) {
        cookie.clear(c)
      } else {
        if (valid.extended) await cookie.set(c, valid.session, value)
        c.set("auth", { session: valid.session, user })
      }
    }
    await next()
  })

  const isAuthenticated1FA = createMiddleware<AuthEnv<S, U>>(async (c, next) => {
    if (!c.get("auth")) return c.json({ error: NOT_AUTHENTICATED }, 401)
    await next()
  })

  const isAuthenticated2FA = createMiddleware<AuthEnv<S, U>>(async (c, next) => {
    const auth = c.get("auth")
    if (!auth) return c.json({ error: NOT_AUTHENTICATED }, 401)
    if (!secondFactorSatisfied(auth)) return c.json({ error: SECOND_FACTOR_REQUIRED }, 401)
    await next()
  })

  const isAuthorized = (check: (auth: AuthState<S, U>) => boolean | Promise<boolean>) =>
    createMiddleware<AuthEnv<S, U>>(async (c, next) => {
      const auth = c.get("auth")
      if (!auth) return c.json({ error: NOT_AUTHENTICATED }, 401)
      if (!secondFactorSatisfied(auth)) return c.json({ error: SECOND_FACTOR_REQUIRED }, 401)
      if ((await check(auth)) !== true) return c.json({ error: NOT_AUTHORIZED }, 403)
      await next()
    })

  const startSession = async (c: Context, fields: NewSessionFields<S>): Promise<S> => {
    const { session, cookieValue } = await sessions.create(fields)
    await cookie.set(c, session, cookieValue)
    return session
  }

  const endSession = async (c: Context<AuthEnv<S, U>>): Promise<void> => {
    const value = await cookie.read(c)
    cookie.clear(c)
    c.set("auth", null)
    if (value !== null) await sessions.signOut(value)
  }

  return {
    parseAuth,
    isAuthenticated1FA,
    isAuthenticated2FA,
    isAuthorized,
    startSession,
    endSession,
  }
}
