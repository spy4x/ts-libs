/**
 * Sign-in with an email address and a password, built on `AuthStore` and `SessionManager` (#57).
 *
 * Written from the rules in issue #57, not moved from the earlier `providers/email-password.ts`. The
 * rules this file carries:
 *
 * - **Sign-in takes the same work as an account whose hash the current hasher made, whether or not
 *   the account exists.** A missing account is checked against a fixed dummy hash made once when
 *   the provider is created, so every `signIn` runs exactly one `PasswordHasher.verify`, and a
 *   wrong password and a missing account fail with the same error. A legacy or lower-iteration
 *   hash still verifies faster than the dummy until its first successful sign-in rehashes it.
 * - **Addresses are compared in one form.** Every address goes through `normalizeEmail`, and a key's
 *   `email` is always set to its subject, so eviction can find it.
 * - **Password sign-up does not prove the address.** The key starts unproven. Sign-up is refused
 *   when another user owns the address, and a completed reset proves it, taking it away from
 *   whoever registered it first.
 * - **Create before revoke.** A password change or reset stores the new secret and creates the new
 *   session before it signs out the user's other sessions, so a failure part-way never leaves the
 *   person signed out with the old password still working.
 *
 * This provider sends no mail. `requestReset` returns the code, and the app delivers it.
 *
 * @module
 */

import { randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import { systemClock } from "@spy4x/platform/universal/time"
import { type PasswordHasher, SecondFactorStatus } from "@spy4x/server/sign-in"
import {
  AuthConflictError,
  type AuthKey,
  type AuthUser,
  ChallengeOutcome,
  type NewAuthKey,
  normalizeEmail,
} from "./model.ts"
import type { ProviderDeps, SignInResult } from "./provider.ts"

/** The `AuthKey.method` of every key this provider writes. */
export const PASSWORD_METHOD = "password"

/** The challenge purpose of a password-reset code. */
export const PASSWORD_RESET_PURPOSE = "password-reset"

/** Shortest new password accepted by default, in characters (code points). */
export const DEFAULT_MIN_PASSWORD_LENGTH = 8

/** How long a reset code lives by default, in minutes. */
export const DEFAULT_RESET_TTL_MINUTES = 30

/** Guesses allowed per reset code by default. */
export const DEFAULT_MAX_RESET_ATTEMPTS = 5

/** Random bytes in a reset code: 256 bits, 43 base64url characters. */
const RESET_CODE_BYTES = 32

/** Longest reset TTL accepted: one day. */
const MAX_RESET_TTL_MINUTES = 24 * 60

/**
 * Why a password operation was refused. The same reason never depends on whether an account
 * exists, except where noted.
 */
export type PasswordSignInFailure =
  /** The address is not one `normalizeEmail` accepts. */
  | "invalid-email"
  /** The new password is too short, too long, or not a string. */
  | "invalid-password"
  /**
   * Sign-up only: another user owns the address, or a password account already exists for it.
   * Sign-up necessarily tells the caller the address is in use; `requestReset` is the way in for its
   * owner.
   */
  | "email-taken"
  /** Sign-in and password change: wrong password, no such account, or a deleted user. */
  | "invalid-credentials"
  /** Reset: the code is wrong, expired, already used, or was never issued. */
  | "invalid-code"
  /** Reset: this code has used up its guesses. Ask for a new one after it expires. */
  | "locked-out"
  /**
   * Reset: the code matched, but no password account uses this address. Only the person who
   * received the code learns this.
   */
  | "no-account"
  /** Reset: another write for this address committed at the same moment. Ask for a new code. */
  | "conflict"

/** Thrown by every method of {@link PasswordSignIn} on a refusal. `reason` names which. */
export class PasswordSignInError extends Error {
  readonly reason: PasswordSignInFailure

  constructor(reason: PasswordSignInFailure, message?: string) {
    super(message ?? `password sign-in refused: ${reason}`)
    this.name = "PasswordSignInError"
    this.reason = reason
  }
}

/** What {@link createPasswordSignIn} needs: the shared provider deps plus a hasher and limits. */
export interface PasswordSignInOptions extends ProviderDeps {
  /** Hashes and verifies passwords. Its iteration count also sets the cost of the dummy hash. */
  hasher: PasswordHasher
  /** Shortest new password, in code points. Defaults to {@link DEFAULT_MIN_PASSWORD_LENGTH}. */
  minPasswordLength?: number
  /** Minutes a reset code lives, 1 to 1440. Defaults to {@link DEFAULT_RESET_TTL_MINUTES}. */
  resetTtlMinutes?: number
  /** Guesses per reset code, a positive integer. Defaults to {@link DEFAULT_MAX_RESET_ATTEMPTS}. */
  maxResetAttempts?: number
}

/** Input of {@link PasswordSignIn.signUp} and {@link PasswordSignIn.signIn}. */
export interface PasswordCredentials {
  email: string
  password: string
}

/** Input of {@link PasswordSignIn.changePassword}. */
export interface ChangePasswordInput {
  /** The signed-in user, from a validated session. */
  userId: number
  currentPassword: string
  newPassword: string
}

/** Input of {@link PasswordSignIn.completeReset}. */
export interface CompleteResetInput {
  email: string
  /** The code {@link PasswordSignIn.requestReset} returned, as the person entered it. */
  code: string
  newPassword: string
}

/** A reset code for the app to deliver to `email`. */
export interface IssuedReset {
  /** The normalised address the code must be sent to. */
  email: string
  /** The raw code. Only its hash is stored; send it and forget it. */
  code: string
  expiresAt: Date
}

/** The password provider. Every refusal is a {@link PasswordSignInError}. */
export interface PasswordSignIn {
  /**
   * Creates a user with an unproven password key and signs them in.
   *
   * @throws {PasswordSignInError} `invalid-email`, `invalid-password`, `email-taken`.
   */
  signUp(input: PasswordCredentials): Promise<SignInResult>
  /**
   * Signs in with an address and password. Runs one hash verification whether or not the account
   * exists, and rehashes a stored hash the hasher reports as outdated.
   *
   * @throws {PasswordSignInError} `invalid-credentials` for a malformed address too, so the answer
   *     never depends on whether the account exists.
   */
  signIn(input: PasswordCredentials): Promise<SignInResult>
  /**
   * Replaces the password after checking the current one, creates a new session, then signs out
   * every other session of the user. The caller replaces its cookie with the returned one.
   *
   * @throws {PasswordSignInError} `invalid-password`, `invalid-credentials`.
   */
  changePassword(input: ChangePasswordInput): Promise<SignInResult>
  /**
   * Issues a reset code for the address, whether or not an account uses it, so the answer tells
   * nothing about existence. The app delivers the code and should rate-limit this call.
   *
   * @throws {PasswordSignInError} `invalid-email`.
   */
  requestReset(input: { email: string }): Promise<IssuedReset>
  /**
   * Checks the reset code (guess-counted by the store), sets the new password, proves the address,
   * creates a new session, then signs out every other session of the user.
   *
   * When the password key was unproven and belonged to someone who is not the address's owner, that
   * claim loses: the key goes, and the password is set on the owner's account, or on a new account
   * when nobody owns the address yet. The returned `user` can therefore differ from the one that
   * held the key. The provider cannot tell a squatter from a person who signed up and never proved
   * the address, so both lose the unproven account this way; prove the key after sign-up to keep
   * it.
   *
   * @throws {PasswordSignInError} `invalid-email`, `invalid-password`, `invalid-code`, `locked-out`,
   *     `no-account`, `conflict`.
   */
  completeReset(input: CompleteResetInput): Promise<SignInResult>
}

/**
 * Creates the password provider.
 *
 * A dummy hash is made here, once, with the same hasher, so a sign-in for a missing account costs a
 * full verification like any other.
 *
 * @throws {RangeError} When `minPasswordLength`, `resetTtlMinutes` or `maxResetAttempts` is not a
 *     positive integer in range.
 */
export function createPasswordSignIn(options: PasswordSignInOptions): PasswordSignIn {
  const { store, sessions, hasher } = options
  const clock = options.clock ?? systemClock
  const minLength = positiveInteger(
    options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH,
    "minPasswordLength",
    Number.MAX_SAFE_INTEGER,
  )
  const ttlMs = positiveInteger(
    options.resetTtlMinutes ?? DEFAULT_RESET_TTL_MINUTES,
    "resetTtlMinutes",
    MAX_RESET_TTL_MINUTES,
  ) * 60_000
  const maxAttempts = positiveInteger(
    options.maxResetAttempts ?? DEFAULT_MAX_RESET_ATTEMPTS,
    "maxResetAttempts",
    1000,
  )

  // Made once, never per call. The catch only keeps an early failure from being reported as an
  // unhandled rejection; awaiting `dummyHash` still rethrows it.
  const dummyHash = hasher.hash(randomBase64Url(RESET_CODE_BYTES))
  dummyHash.catch(() => {})

  function now(): Date {
    const value = clock.now()
    if (!Number.isFinite(value)) throw new TypeError("clock.now() must return a finite number")
    return new Date(value)
  }

  /** Hashes a new password, or refuses it as `invalid-password`. */
  async function hashNewPassword(password: unknown): Promise<string> {
    if (typeof password !== "string" || [...password].length < minLength) {
      throw new PasswordSignInError("invalid-password")
    }
    try {
      return await hasher.hash(password)
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new PasswordSignInError("invalid-password")
      }
      throw error
    }
  }

  function requireEmail(raw: unknown): string {
    const email = normalizeEmail(raw)
    if (email === null) throw new PasswordSignInError("invalid-email")
    return email
  }

  /** Creates a session for `key`. The second-factor status is the app's, or NotRequired. */
  async function signInWith(user: AuthUser, key: AuthKey): Promise<SignInResult> {
    const secondFactor = await options.secondFactorFor?.(user) ?? SecondFactorStatus.NotRequired
    const session = await sessions.create({ userId: user.id, keyId: key.id, secondFactor })
    return { user, key, session }
  }

  /** Create before revoke: the new session exists before every other session is signed out. */
  async function replaceSessions(user: AuthUser, key: AuthKey): Promise<SignInResult> {
    const result = await signInWith(user, key)
    await sessions.signOutUser(user.id, { except: result.session.session.id })
    return result
  }

  async function liveUser(userId: number): Promise<AuthUser | null> {
    const user = await store.findUser(userId)
    return user && user.deletedAt === null ? user : null
  }

  async function reloadKey(keyId: number): Promise<AuthKey> {
    const key = await store.findKeyById(keyId)
    if (!key) throw new PasswordSignInError("conflict")
    return key
  }

  function passwordKey(email: string, secret: string, provenAt: Date | null): NewAuthKey {
    // The subject is an address, so `email` carries it too: eviction matches on `email`.
    return { method: PASSWORD_METHOD, subject: email, email, secret, provenAt }
  }

  return {
    async signUp({ email: rawEmail, password }) {
      const email = requireEmail(rawEmail)
      const secret = await hashNewPassword(password)
      if (await store.findUserIdByProvenEmail(email) !== null) {
        throw new PasswordSignInError("email-taken")
      }
      let created: { user: AuthUser; key: AuthKey }
      try {
        created = await store.createUserWithKey(passwordKey(email, secret, null))
      } catch (error) {
        if (error instanceof AuthConflictError) throw new PasswordSignInError("email-taken")
        throw error
      }
      return await signInWith(created.user, created.key)
    },

    async signIn({ email: rawEmail, password }) {
      const email = normalizeEmail(rawEmail)
      const key = email === null ? null : await store.findKey(PASSWORD_METHOD, email)
      // Exactly one verification on every path: the key's own hash, or the dummy one.
      const stored = key?.secret ?? await dummyHash
      const check = await hasher.verify(password, stored)
      if (key === null || key.secret === null || !check.valid) {
        throw new PasswordSignInError("invalid-credentials")
      }
      const user = await liveUser(key.userId)
      if (!user) throw new PasswordSignInError("invalid-credentials")
      if (check.needsRehash) await store.updateKeySecret(key.id, await hasher.hash(password))
      return await signInWith(user, await reloadKey(key.id))
    },

    async changePassword({ userId, currentPassword, newPassword }) {
      const secret = await hashNewPassword(newPassword)
      const user = await liveUser(userId)
      const keys = user ? await store.listKeys(user.id) : []
      let matched: AuthKey | null = null
      for (const key of keys) {
        if (key.method !== PASSWORD_METHOD || key.secret === null) continue
        if ((await hasher.verify(currentPassword, key.secret)).valid) {
          matched = key
          break
        }
      }
      if (!user || !matched) throw new PasswordSignInError("invalid-credentials")
      if (!(await store.updateKeySecret(matched.id, secret))) {
        throw new PasswordSignInError("invalid-credentials")
      }
      return await replaceSessions(user, await reloadKey(matched.id))
    },

    async requestReset({ email: rawEmail }) {
      const email = requireEmail(rawEmail)
      const code = randomBase64Url(RESET_CODE_BYTES)
      const issuedAt = now()
      const expiresAt = new Date(issuedAt.getTime() + ttlMs)
      await store.issueChallenge({
        purpose: PASSWORD_RESET_PURPOSE,
        subject: email,
        secretHash: await sha256Hex(code),
        expiresAt,
        now: issuedAt,
      })
      return { email, code, expiresAt }
    },

    async completeReset({ email: rawEmail, code, newPassword }) {
      const email = requireEmail(rawEmail)
      // Checked before the guess is spent, so a refused password does not consume a matching code.
      const secret = await hashNewPassword(newPassword)
      if (typeof code !== "string" || code.length === 0) {
        throw new PasswordSignInError("invalid-code")
      }
      const at = now()
      const outcome = await store.attemptChallenge({
        purpose: PASSWORD_RESET_PURPOSE,
        subject: email,
        secretHash: await sha256Hex(code),
        maxAttempts,
        now: at,
      })
      if (outcome === ChallengeOutcome.LockedOut) throw new PasswordSignInError("locked-out")
      if (outcome !== ChallengeOutcome.Matched) throw new PasswordSignInError("invalid-code")

      const key = await store.findKey(PASSWORD_METHOD, email)
      if (!key) throw new PasswordSignInError("no-account")
      const owner = await store.findUserIdByProvenEmail(email)
      try {
        if (owner === key.userId) {
          // The key's own user owns the address: keep the key, prove it if it is not yet, then set
          // the secret, so a refused proof changes nothing.
          const user = await liveUser(key.userId)
          if (!user) throw new PasswordSignInError("no-account")
          if (key.provenAt === null) await store.proveKey(key.id, at)
          await store.updateKeySecret(key.id, secret)
          return await replaceSessions(user, await reloadKey(key.id))
        }
        // The key is an unproven claim by someone who does not own the address. A proven insert
        // deletes it in the same write and puts the password on the owner's account, or on a new
        // one when nobody owns the address yet.
        if (owner !== null) {
          const user = await liveUser(owner)
          if (!user) throw new PasswordSignInError("no-account")
          const added = await store.addKey(owner, passwordKey(email, secret, at))
          return await replaceSessions(user, added)
        }
        const created = await store.createUserWithKey(passwordKey(email, secret, at))
        return await replaceSessions(created.user, created.key)
      } catch (error) {
        if (error instanceof AuthConflictError) throw new PasswordSignInError("conflict")
        throw error
      }
    },
  }
}

function positiveInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}`)
  }
  return value
}
