/**
 * `@ts-libs/server/sign-in` — the building blocks a sign-in method stands on: server-side sessions
 * behind an app-supplied store, the signed session cookie, Hono middleware and guards, password
 * hashing with a pepper, and authenticator-app codes. See `server/README.md`.
 *
 * @module
 */

export {
  type CreatedSession,
  MAX_SESSION_MINUTES,
  type NewSessionFields,
  SecondFactorStatus,
  SessionManager,
  type SessionManagerOptions,
  type SessionRecord,
  SessionStatus,
  type SessionStore,
  type ValidSession,
} from "./session.ts"
export {
  SESSION_COOKIE_NAME,
  SessionCookie,
  type SessionCookieOptions,
  USER_ID_COOKIE_NAME,
} from "./cookie.ts"
export {
  type Auth,
  type AuthEnv,
  type AuthOptions,
  type AuthState,
  createAuth,
  NOT_AUTHENTICATED,
  NOT_AUTHORIZED,
  SECOND_FACTOR_REQUIRED,
} from "./middleware.ts"
export {
  createPasswordHasher,
  DEFAULT_PASSWORD_ITERATIONS,
  MAX_PASSWORD_BYTES,
  type PasswordCheck,
  type PasswordHasher,
  type PasswordHasherOptions,
} from "./password.ts"
export {
  generateTotpSecret,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  type TotpAccount,
  type TotpEnrolment,
  totpEnrolment,
  type TotpVerifyOptions,
  verifyTotp,
} from "./totp.ts"
