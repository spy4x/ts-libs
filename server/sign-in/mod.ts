/**
 * `@spy4x/server/sign-in` — the building blocks a sign-in method stands on: server-side sessions
 * behind an app-supplied store, the signed session cookie, Hono middleware and guards, password
 * hashing with a pepper, and authenticator-app codes.
 *
 * The account model, sign-in keys and challenges (`AuthStore`) are in `@spy4x/server/auth`.
 *
 * The building blocks a sign-in method stands on. Entry point:
 * `sign-in/mod.ts`. Nothing here imports from `server/auth/`.
 *
 * | File            | What it is                                                                          |
 * | --------------- | ----------------------------------------------------------------------------------- |
 * | `session.ts`    | `SessionManager` over an app-supplied `SessionStore`: create, validate, sign out    |
 * | `cookie.ts`     | `SessionCookie`: the signed `HttpOnly` session cookie and a readable user-id cookie |
 * | `middleware.ts` | `createAuth`: Hono `parseAuth`, the guards, `startSession` and `endSession`         |
 * | `password.ts`   | `createPasswordHasher`: PBKDF2-HMAC-SHA-256 with a pepper, parameters in the value  |
 * | `totp.ts`       | Authenticator-app codes: random secret, enrolment URI and QR code, `verifyTotp`     |
 *
 * To make a hash for an app's config, such as one owner's password, run the `password-hash` CLI with
 * the pepper the app runs with. It reads the password from standard input, typed without echo at a
 * terminal, so the password stays out of the shell history and the process list:
 *
 * ```jsonc
 * // deno.json
 * "password:hash": "deno run --allow-env=AUTH_PEPPER jsr:@spy4x/server/sign-in/password-hash"
 * ```
 *
 * ```sh
 * deno task password:hash                        # type it, then Enter
 * printf %s "$PASSWORD" | deno task password:hash
 * ```
 *
 * The hash contains `$`, and a `.env` loader or a Compose file that expands `$` cuts it short; `verify`
 * then answers "no" to the right password. Check the configured value with `isPasswordHash` at
 * start-up, and refuse to run when it is false:
 *
 * ```ts
 * import { isPasswordHash } from "@spy4x/server/sign-in"
 *
 * if (!isPasswordHash(Deno.env.get("OWNER_PASSWORD_HASH"))) {
 *   throw new Error("OWNER_PASSWORD_HASH is not a hash made by password:hash")
 * }
 * ```
 *
 * ## What it does
 *
 * **Sessions live in the app's database.** The app implements `SessionStore`: seven operations, and
 * five optional ones: `clearPendingSecondFactors`, and the four behind the list of signed-in devices. `SessionRecord` holds only what the session logic
 * reads (id, user id, token hash, status, second-factor state, expiry); an app's own columns ride along
 * through the type parameter. The store's writes (`extend`, `completeSecondFactor`,
 * `clearPendingSecondFactors`, the sign-outs, `expire`) must only touch a session whose status is
 * `Active`, each as a single conditional write, so a concurrent sign-out is never undone. The library
 * cannot check that; the interface's comments state it for whoever implements it.
 *
 * **The cookie value is `<id>:<token>`.** The token is 32 random bytes; the store keeps only its
 * HMAC-SHA-256 under the pepper, and the comparison is constant-time. The value is parsed by one exact
 * pattern: a positive integer without leading zeros, a colon, 43 base64url characters, nothing else.
 * The cookie is also signed with its own secret, so a value the server never issued is refused before
 * the store is asked.
 *
 * **Expiry and extension.** A session is refused from the millisecond its `expiresAt` is reached. When
 * a request finds less than a quarter of the lifetime left, the session is extended to a full lifetime
 * and `parseAuth` sends the cookie again. An expired, signed-out or unknown-status session is never
 * extended. There is no cache: every request reads the store, so a sign-out takes effect on the next
 * request. A store that caches must drop or update its entry on every write the interface names.
 *
 * **Guards fail closed.** `isAuthenticated1FA` needs a valid session. `isAuthenticated2FA` also needs
 * the second factor settled: `Completed`, or `NotRequired` for a user whose `hasSecondFactor` is false.
 * The same rule is exported as `secondFactorSatisfied(status, hasSecondFactor)` for an app that
 * checks a session outside the guards. A `Pending` session stays refused after the user removes
 * their second factor until the app calls
 * `sessions.clearPendingSecondFactors(userId)`. Call it right after removing the TOTP secret, in the
 * same transaction when there is one: `createPostgresSessionStore(tx).clearPendingSecondFactors(userId)`
 * inside the caller's `sql.begin` commits or rolls back with the secret's removal. It turns every
 * active `Pending` session of that user into `NotRequired` in one write, and leaves `Completed`,
 * signed-out and expired sessions as they are. On a store that does not implement it, the manager
 * throws a `TypeError` rather than leaving those sessions locked out without a sign.
 *
 * **The list of signed-in devices.** `sessions.create(fields, device)` takes an optional second
 * argument, `{ deviceName, ipHint }`: two labels the app made from the request, such as
 * `deviceName(userAgent)` from `@spy4x/net/user-agent` and `ipHint(address)` from `@spy4x/net/ip`.
 * The manager strips control characters, cuts the name to 100 characters and the hint to 45
 * (`cleanSessionDevice`), and never refuses a label, so a strange header cannot fail a sign-in. Store
 * a hint, not the address: the list is shown back to the user and the row outlives the request. The
 * providers in `server/auth` pass it on: `device` in the input of the password operations that create
 * a session and of the OAuth `handleCallback`, `verifyCode(email, code, { device })`, and
 * `confirmSignUp(token, device)`. Four
 * more operations work on one user's sessions, and every one of them takes the user's id from the
 * caller's validated session and touches no other user's rows:
 *
 * ```ts
 * const { session } = (await sessions.validate(cookieValue))!
 * void sessions.touch(session.userId, session.id) // at most one write per 5 minutes
 * const devices = await sessions.listForUser(session.userId) // most recently used first
 * await sessions.deleteForUser(session.userId, idFromTheRequest) // false for someone else's id
 * await sessions.deleteOthers(session.userId, session.id) // "sign out everywhere else"
 * ```
 *
 * `listForUser` returns `{ id, deviceName, ipHint, createdAt, lastUsedAt }` for each session that is
 * active and not run out, and never the token hash; mark the caller's own by comparing `id`.
 * `deleteForUser` and `deleteOthers` delete the rows, so the sessions fail every later validation.
 * `deleteOthers` deletes exactly the listed sessions minus the one it keeps. It deletes nothing and
 * answers 0 unless the id to keep is a live session of that same user: another user's session, an id
 * no session has, a signed-out or run-out session, and a value that is not an id all end no session,
 * so a wrong id never signs the person out everywhere. `touch` writes `lastUsedAt` only when the stored time is at least
 * `SESSION_TOUCH_INTERVAL_MS` (5 minutes) old, so calling it on every request costs one write per
 * session per interval. In a `SessionStore` the four are optional, like
 * `clearPendingSecondFactors`: an app's own store keeps compiling, and the manager throws a
 * `TypeError` for the one that is missing. `createPostgresSessionStore` implements all of them; a
 * database created before this needs `AUTH_POSTGRES_SESSION_DEVICES_UPGRADE` (see `server/auth`).
 * `isAuthorized(check)` applies the same two rules and then answers 403 unless `check` returns `true`.
 * A route that never passed through `parseAuth` is refused by every guard.
 *
 * **Passwords.** New hashes are `pbkdf2-sha256$<iterations>$<32 hex salt>$<64 hex key>`: 600 000
 * iterations by default (the OWASP figure for PBKDF2-HMAC-SHA-256), a 16-byte random salt, a 32-byte
 * key, and HMAC-SHA-256 of the password under the pepper as the PBKDF2 input. `verify` reads the
 * iteration count from the stored value and reports `needsRehash` when it is below the configured one.
 * Hashes in the template's `<salt>:<key>` format still verify, always with `needsRehash`, so an existing
 * database keeps working; hash the password again after such a sign-in. A stored value in neither exact
 * format is a mismatch, never an exception. Passwords over 1024 UTF-8 bytes are refused before any key
 * derivation.
 *
 * **Authenticator-app codes.** SHA-1, six digits, 30-second steps, one step of tolerance either side:
 * the configuration every mainstream app supports. `verifyTotp` returns the time step it accepted; store
 * it per user with a conditional write (only if greater than the stored one), and pass it back as
 * `lastAcceptedStep`. A code for that step or an earlier one is refused, so one code signs in once.
 *
 * ## What it does not do
 *
 * - **It does not limit guesses.** Six digits across three accepted steps is one chance in about 333 000
 *   per guess, and a password is only as strong as its user made it. Put `@spy4x/platform/rate-limit`
 *   in front of every route that checks a password or a code, keyed per account as well as per address.
 * - **It does not hide whether an account exists.** When the account is missing, the app should still
 *   spend the time of one `verify` (against a hash made once at start-up) before answering.
 * - **It does not send mail, sign users up, or talk to identity providers.** Those methods are
 *   `@spy4x/server/auth`'s, built on this set.
 * - **It does not know about roles, groups or users.** `loadUser` and `hasSecondFactor` come from the
 *   app, and so does the check given to `isAuthorized`.
 * - **It does not use the `__Host-` cookie prefix by default.** Pass `name: "__Host-sessionIdToken"`
 *   in production: Hono then enforces `Secure`, `Path=/` and no `Domain`, and a sibling subdomain can
 *   no longer plant or shadow the cookie. (`secure: false` and a `__Host-` name cannot be combined;
 *   Hono throws.)
 * - **It does not rotate the session when the second factor completes.** Without rotation, a
 *   `Pending` session cookie planted in a victim's browser becomes fully signed in when the victim
 *   enters their code. To rotate, end the `Pending` session (`sessions.signOut(cookieValue)`) and
 *   start a new one with `secondFactor: Completed` instead of calling `completeSecondFactor`.
 * - **It does not give a `Pending` session its own deadline.** `validate` extends a session that
 *   still owes its second factor like any other, so someone holding only the password can keep one
 *   alive by polling a route that needs one factor. Such a session never passes the second-factor
 *   guard, but the app should give the second-factor step a deadline of its own.
 *
 * @module
 */

export {
  cleanSessionDevice,
  type CreatedSession,
  MAX_DEVICE_NAME_LENGTH,
  MAX_IP_HINT_LENGTH,
  MAX_SESSION_MINUTES,
  type NewSessionDevice,
  type NewSessionFields,
  SecondFactorStatus,
  SESSION_TOUCH_INTERVAL_MS,
  type SessionDevice,
  type SessionListEntry,
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
  secondFactorSatisfied,
} from "./middleware.ts"
export {
  createPasswordHasher,
  DEFAULT_PASSWORD_ITERATIONS,
  isPasswordHash,
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
