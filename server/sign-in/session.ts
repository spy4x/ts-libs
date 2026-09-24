// Server-side sessions: create, validate (extending when due), sign out.
//
// Rewritten from `template/apps/api/services/auth/session.ts`. What changed and why:
//
// - The token was hashed with PBKDF2 at 100 000 iterations and re-derived on every request, so each
//   authenticated request paid for a password-strength derivation, and any signed-in client could
//   make the server repeat it at will. A session token is 256 random bits, so one HMAC-SHA-256
//   keyed by the pepper is enough and costs the same every time.
// - The token came from `getRandomString`, which maps each random byte to `byte % 36`; 256 is not a
//   multiple of 36, so four characters were more likely than the rest. `randomBase64Url` has no
//   such bias.
// - The cookie value was parsed with `Number()`, which accepts `1e3`, `0x10` and ` 7 `, and any text
//   after a second `:` was ignored. Parsing is now one exact pattern.
// - An expired or signed-out token was cached under the raw token itself, which put a bearer
//   credential into a cache key. There is no cache here: every validation reads the store, so a
//   signed-out session is refused on the very next request.
// - The extension wrote the new expiry with an unconditional update and returned whatever row came
//   back, so a session signed out between the read and the write was answered as valid. The store's
//   `extend` now only touches an active session and says whether it did.
// - `expiresAt < now` let a session through at the exact instant it expired, and an invalid date
//   compared false and so never expired. Expiry is now `expiresAt <= now`, and a value that is not
//   a valid `Date` stops the request.

import { constantTimeEquals, randomBase64Url } from "@spy4x/platform/tokens"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import { encodeHex } from "@std/encoding/hex"
import { requireSecret } from "./secret.ts"

/** Lifecycle of a stored session. Values match the template's `UserSessionStatus`. */
export enum SessionStatus {
  Active = 1,
  Expired = 2,
  SignedOut = 3,
}

/** Second-factor state of a session. Values match the template's `SessionMFAStatus`. */
export enum SecondFactorStatus {
  /** The session was created without a second factor being asked for. */
  NotRequired = 1,
  /** A second factor is required and has not been given yet. */
  Pending = 2,
  /** The second factor was given in this session. */
  Completed = 3,
}

/**
 * The fields the session logic reads. An app's session row extends this with its own columns (for
 * example the credential that created the session), and the store and manager carry them through.
 */
export interface SessionRecord {
  /** Positive integer assigned by the store. */
  id: number
  /** The user the session belongs to. */
  userId: number
  /** Lower-case hex HMAC-SHA-256 of the session token. The token itself is never stored. */
  tokenHash: string
  status: SessionStatus
  secondFactor: SecondFactorStatus
  expiresAt: Date
}

/**
 * Persistence for sessions, implemented by the app. These are exactly the operations the manager
 * calls. Every conditional operation must be a single conditional write (for SQL, one `UPDATE …
 * WHERE status = active`), so a concurrent sign-out cannot be overwritten.
 */
export interface SessionStore<S extends SessionRecord = SessionRecord> {
  /** Inserts a session and returns it with the id the store assigned. */
  create(session: Omit<S, "id">): Promise<S>
  /** The session with this id, or `null`. Must not answer from a cache that sign-out bypasses. */
  findById(id: number): Promise<S | null>
  /**
   * Sets `expiresAt` on the session only while its status is `Active`. Never changes the status.
   *
   * @returns `true` when an active session was updated.
   */
  extend(id: number, expiresAt: Date): Promise<boolean>
  /**
   * Sets `secondFactor` to `Completed` only while the session's status is `Active`.
   *
   * @returns `true` when an active session was updated.
   */
  completeSecondFactor(id: number): Promise<boolean>
  /**
   * Sets `secondFactor` to `NotRequired` on every session of the user whose status is `Active` and
   * whose `secondFactor` is `Pending`, as one conditional write (for SQL, one `UPDATE … WHERE
   * user_id = … AND status = active AND second_factor = pending`). A `Completed` session and a
   * session that is not `Active` are left as they are.
   *
   * Optional, so a store written before it existed still type-checks; without it,
   * {@link SessionManager.clearPendingSecondFactors} throws.
   */
  clearPendingSecondFactors?(userId: number): Promise<void>
  /** Sets the status of this session to `SignedOut` if it is `Active`. */
  signOut(id: number): Promise<void>
  /** Sets every `Active` session of the user to `SignedOut`, except `exceptId` when given. */
  signOutUser(userId: number, exceptId: number | null): Promise<void>
  /** Sets every `Active` session whose `expiresAt` is at or before `now` to `Expired`. */
  expire(now: Date): Promise<void>
}

/** What an app supplies to create a session: its own fields, without what the manager sets. */
export type NewSessionFields<S extends SessionRecord = SessionRecord> = Omit<
  S,
  "id" | "tokenHash" | "status" | "expiresAt"
>

/** Options for {@link SessionManager}. */
export interface SessionManagerOptions<S extends SessionRecord = SessionRecord> {
  store: SessionStore<S>
  /** HMAC key for session tokens, at least 32 printable characters. */
  pepper: string
  /** Session lifetime in whole minutes, from 1 to {@link MAX_SESSION_MINUTES}. */
  durationMinutes: number
  /** Time source. Defaults to the host clock. */
  clock?: Clock
}

/** A session that passed {@link SessionManager.validate}. */
export interface ValidSession<S extends SessionRecord = SessionRecord> {
  session: S
  /** True when this validation moved `expiresAt`; the cookie should be sent again. */
  extended: boolean
}

/** A newly created session and the cookie value that proves it. */
export interface CreatedSession<S extends SessionRecord = SessionRecord> {
  session: S
  /** `<id>:<token>`. The only place the token exists; it is not stored. */
  cookieValue: string
}

/**
 * Longest session: 400 days, the most a browser keeps a cookie and the most Hono's cookie helper
 * accepts.
 */
export const MAX_SESSION_MINUTES = 400 * 24 * 60

/** Random bytes in a session token: 256 bits, 43 base64url characters. */
const TOKEN_BYTES = 32
const COOKIE_VALUE = /^([1-9][0-9]{0,15}):([A-Za-z0-9_-]{43})$/

/**
 * Splits a session cookie value into its id and token, or `null` unless the value is exactly
 * `<positive integer without leading zeros>:<43 base64url characters>`.
 */
export function parseSessionCookieValue(value: unknown): { id: number; token: string } | null {
  if (typeof value !== "string") return null
  const match = COOKIE_VALUE.exec(value)
  if (!match) return null
  const id = Number(match[1])
  if (!Number.isSafeInteger(id)) return null
  return { id, token: match[2] }
}

/**
 * Creates, validates, extends and ends sessions over an app-supplied {@link SessionStore}.
 *
 * A session is extended to a full lifetime when a validation finds less than a quarter of the
 * lifetime left. Only an active, unexpired session whose token matches is ever extended; nothing in
 * this class changes a session's status back to `Active`.
 */
export class SessionManager<S extends SessionRecord = SessionRecord> {
  readonly #store: SessionStore<S>
  readonly #clock: Clock
  readonly #durationMs: number
  readonly #key: Promise<CryptoKey>

  /**
   * @throws {TypeError} When the pepper is missing or shorter than 32 characters.
   * @throws {RangeError} When `durationMinutes` is not an integer from 1 to
   *     {@link MAX_SESSION_MINUTES}.
   */
  constructor(options: SessionManagerOptions<S>) {
    const pepper = requireSecret("pepper", options.pepper)
    const minutes = options.durationMinutes
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_SESSION_MINUTES) {
      throw new RangeError(`durationMinutes must be an integer from 1 to ${MAX_SESSION_MINUTES}`)
    }
    this.#store = options.store
    this.#clock = options.clock ?? systemClock
    this.#durationMs = minutes * 60_000
    this.#key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
  }

  /**
   * Creates an active session with a fresh token.
   *
   * @param fields The app's own fields, including `userId` and `secondFactor`.
   * @throws {TypeError} When `secondFactor` is not a {@link SecondFactorStatus}, or the store
   *     returns an id that is not a positive safe integer.
   */
  async create(fields: NewSessionFields<S>): Promise<CreatedSession<S>> {
    if (!isSecondFactorStatus(fields.secondFactor)) {
      throw new TypeError("secondFactor must be a SecondFactorStatus")
    }
    const token = randomBase64Url(TOKEN_BYTES)
    const record = {
      ...fields,
      tokenHash: await this.#hashToken(token),
      status: SessionStatus.Active,
      expiresAt: new Date(this.#now() + this.#durationMs),
    } as Omit<S, "id">
    // The store assigns the id. One passed in with the app's fields would otherwise reach the insert.
    delete (record as { id?: unknown }).id
    const session = await this.#store.create(record)
    if (!Number.isSafeInteger(session.id) || session.id < 1) {
      throw new TypeError("the session store returned an id that is not a positive integer")
    }
    return { session, cookieValue: `${session.id}:${token}` }
  }

  /**
   * Resolves a cookie value to its session, or `null` when the value is malformed, the session does
   * not exist, the token does not match, the session is not active, or it has expired.
   *
   * @throws {TypeError} When the store returns a session whose `expiresAt` is not a valid `Date`.
   */
  async validate(cookieValue: string): Promise<ValidSession<S> | null> {
    const session = await this.#find(cookieValue)
    if (!session || session.status !== SessionStatus.Active) return null

    const now = this.#now()
    const expiresAt = expiryOf(session)
    if (expiresAt <= now) return null

    if (expiresAt - now < this.#durationMs / 4) {
      const next = new Date(now + this.#durationMs)
      if (!(await this.#store.extend(session.id, next))) return null
      return { session: { ...session, expiresAt: next }, extended: true }
    }
    return { session, extended: false }
  }

  /**
   * Signs out the session this cookie value proves.
   *
   * @returns `true` when an active session with a matching token was signed out.
   */
  async signOut(cookieValue: string): Promise<boolean> {
    const session = await this.#find(cookieValue)
    if (!session || session.status !== SessionStatus.Active) return false
    await this.#store.signOut(session.id)
    return true
  }

  /** Signs out every active session of a user, optionally keeping one (the caller's own). */
  async signOutUser(userId: number, options: { except?: number } = {}): Promise<void> {
    await this.#store.signOutUser(userId, options.except ?? null)
  }

  /**
   * Records that the second factor was given in this session.
   *
   * @returns `true` when the session was active and is now `Completed`.
   */
  async completeSecondFactor(sessionId: number): Promise<boolean> {
    return await this.#store.completeSecondFactor(sessionId)
  }

  /**
   * Stops the user's active sessions from waiting for a second factor the user no longer has: each
   * one that is `Pending` becomes `NotRequired`, so it passes `isAuthenticated2FA` again once
   * `hasSecondFactor` answers false for the user. `Completed` sessions already pass and are left
   * alone; signed-out and expired sessions are never touched.
   *
   * A cleared session gave only the first factor, so it now grants what a fresh password sign-in
   * would. If the password was also changed since, sign those sessions out instead.
   *
   * Call it right after the app removes the user's TOTP secret, in the same transaction when there
   * is one (give that transaction's handle to the store, as `createPostgresSessionStore(tx)`), so
   * the sessions and the secret change together.
   *
   * @throws {TypeError} When the store does not implement `clearPendingSecondFactors`. Doing nothing
   *     instead would leave the user's pending sessions refused with no sign of why.
   */
  async clearPendingSecondFactors(userId: number): Promise<void> {
    if (typeof this.#store.clearPendingSecondFactors !== "function") {
      throw new TypeError("the session store does not implement clearPendingSecondFactors")
    }
    await this.#store.clearPendingSecondFactors(userId)
  }

  /** Marks every active session that has run out as `Expired`. For a periodic job. */
  async expireStale(): Promise<void> {
    await this.#store.expire(new Date(this.#now()))
  }

  /** The stored session this cookie value proves, whatever its status, or `null`. */
  async #find(cookieValue: string): Promise<S | null> {
    const parsed = parseSessionCookieValue(cookieValue)
    if (!parsed) return null
    const session = await this.#store.findById(parsed.id)
    if (!session || session.id !== parsed.id) return null
    const hash = await this.#hashToken(parsed.token)
    if (!(await constantTimeEquals(hash, session.tokenHash))) return null
    return session
  }

  async #hashToken(token: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await this.#key, new TextEncoder().encode(token))
    return encodeHex(new Uint8Array(mac))
  }

  #now(): number {
    const now = this.#clock.now()
    if (!Number.isFinite(now)) throw new TypeError("clock.now() must return a finite number")
    return now
  }
}

function expiryOf(session: SessionRecord): number {
  const value = session.expiresAt
  const time = value instanceof Date ? value.getTime() : Number.NaN
  if (Number.isNaN(time)) {
    throw new TypeError("the session store returned an expiresAt that is not a valid Date")
  }
  return time
}

function isSecondFactorStatus(value: unknown): value is SecondFactorStatus {
  return value === SecondFactorStatus.NotRequired || value === SecondFactorStatus.Pending ||
    value === SecondFactorStatus.Completed
}
