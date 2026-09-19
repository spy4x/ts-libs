/**
 * Package constants that are not secrets.
 *
 * There is deliberately no `DEFAULT_PASSWORD_PEPPER` here. The source had one
 * (`misc/constants.ts:4`, the literal `'custom-auth'`) *and* a module-level
 * `import.meta.env.PASSWORD_PEPPER`, so a deployment that forgot the env var
 * silently hashed every password with a public string. See `crypto.ts`: the
 * pepper is injected and its absence is fatal.
 */

/** Length in characters of a generated session token. */
export const DEFAULT_SESSION_LENGTH = 32

/** Session lifetime, 90 days in minutes. */
export const DEFAULT_SESSION_DURATION_MIN = 60 * 24 * 30 * 3

/** PBKDF2 iteration count. Also the cost of an attacker's offline guess. */
export const DEFAULT_HASH_ITERATIONS = 100_000

/** Derived-key length in bytes. */
export const DEFAULT_HASH_KEY_BYTES = 32

/** Digits in a generated one-time password. */
export const DEFAULT_OTP_LENGTH = 6

/** How long an emailed one-time password stays valid. */
export const DEFAULT_OTP_TTL_MS = 10 * 60 * 1000

/** How long an emailed magic link stays valid. */
export const DEFAULT_MAGIC_LINK_TTL_MS = 15 * 60 * 1000

/** Failed verifications of one key before it stops accepting guesses. */
export const DEFAULT_MAX_ATTEMPTS = 5

/** Length in characters of an anonymous key's opaque identification. */
export const DEFAULT_ANONYMOUS_ID_LENGTH = 16

/** OAuth2 `state` cookie lifetime, one hour, matching the redirect's usable window. */
export const DEFAULT_OAUTH2_STATE_MAX_AGE_SEC = 60 * 60

/**
 * Shape test used by the account-linking handlers to decide whether a key's
 * identification may be copied onto a user as an email address.
 *
 * Deliberately stricter than the source's `email.includes('@')`, which accepted
 * an OAuth subject id containing an `@` and wrote it to `user.email`. It still
 * only asserts *shape*: `provider.ts` is not an address validator, and delivery
 * is what proves an address.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Header name carrying a session id token when a cookie jar is not in play. */
export const SESSION_COOKIE_NAME = "session"
