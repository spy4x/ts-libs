/**
 * Sign-in with a one-time code sent by email (#57, finding 3).
 *
 * `requestCode` issues a guess-counted challenge for the normalised address and hands the raw code
 * to the app's `sendCode`. `verifyCode` checks one guess; on a match it signs the person in to the
 * account that owns the address, or creates one, and never deletes the login method: the key stays,
 * so the same person signs in again with the next code and no second account is created.
 *
 * Who a matched code signs in:
 *
 * 1. The email-code key for the address, proven again with `proveKey`, when its user owns the
 *    address. `proveKey` also deletes any unproven claim another user registered on it since.
 * 2. Otherwise the user who owns the proven address, through a new proven email-code key.
 * 3. Otherwise a new user with a proven email-code key.
 *
 * An email-code key whose user does not own the address is an unproven claim somebody registered
 * without receiving mail there. It is never proven for its user, because that would sign the
 * mailbox owner in to the account of whoever registered it. Cases 2 and 3 write a proven key, which
 * deletes such a claim in the same write.
 *
 * `proveAddress` is the other way to use a code: a signed-in user proves an address for their own
 * account, and no user is created. A person who signed up with a password (an unproven key) calls
 * it to keep that account: the password key becomes proven, the user owns the address, and a later
 * code sign-in or password reset lands in the same user. Without it, `verifyCode` for that address
 * creates a new user and evicts the unproven password key.
 *
 * **Rate-limit the route that calls `requestCode`.** This module limits guesses per code, not how
 * often a code is asked for, and every new code moves the expiry of a locked challenge. Put
 * `createRateLimitMiddleware` from `@spy4x/platform/rate-limit` in front of that route with two
 * limiters: one keyed by the normalised address (`normalizeEmail` of the submitted value), so one
 * mailbox cannot be flooded, and one keyed by `clientIp` from `@spy4x/platform/rate-limit`, so one
 * client cannot walk through many addresses. Rate-limit the route that calls `verifyCode` by
 * `clientIp` too.
 *
 * @module
 */

import { randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import { systemClock } from "@spy4x/platform/universal/time"
import { SecondFactorStatus } from "../sign-in/mod.ts"
import {
  AuthConflictError,
  type AuthKey,
  type AuthUser,
  ChallengeOutcome,
  normalizeEmail,
} from "./model.ts"
import type { ProviderDeps, SignInResult } from "./provider.ts"
import type { AuthStore } from "./store.ts"

/** The `AuthKey.method` of an email-code key. Its subject and email are the normalised address. */
export const EMAIL_CODE_METHOD = "email-code"

/** The challenge purpose `requestCode` issues and `verifyCode` checks. */
export const EMAIL_CODE_PURPOSE = "email-code"

/** Random bytes in a code: 48 bits, rendered as 8 base64url characters. */
export const EMAIL_CODE_BYTES = 6

/** Default lifetime of a code. */
export const DEFAULT_CODE_TTL_MINUTES = 10

/** Default number of guesses one challenge allows. */
export const DEFAULT_CODE_MAX_ATTEMPTS = 5

/** Why {@link EmailCodeSignIn} refused a request. */
export type EmailCodeErrorReason =
  /** The address is not one `normalizeEmail` accepts. */
  | "invalid-email"
  /** The code did not match (a compared guess was counted), or was not a string (nothing was
   * compared). */
  | "wrong-code"
  /** The code has used up its guesses. Nothing was compared. */
  | "locked-out"
  /** No live code for this address: never asked for, already used, or expired. */
  | "no-code"
  /** The code matched, but the account it belongs to is deleted. */
  | "account-deleted"

/** Thrown by {@link EmailCodeSignIn}. The message is fixed per reason and never echoes input. */
export class EmailCodeError extends Error {
  readonly reason: EmailCodeErrorReason

  constructor(reason: EmailCodeErrorReason) {
    super(ERROR_MESSAGES[reason])
    this.name = "EmailCodeError"
    this.reason = reason
  }
}

const ERROR_MESSAGES: Record<EmailCodeErrorReason, string> = {
  "invalid-email": "the email address is not valid",
  "wrong-code": "the code is not correct",
  "locked-out": "too many wrong codes; ask for a new code later",
  "no-code": "no valid code for this address; ask for a new one",
  "account-deleted": "this account is deleted",
}

/** What {@link createEmailCodeSignIn} needs from the app, on top of {@link ProviderDeps}. */
export interface EmailCodeSignInDeps extends ProviderDeps {
  /**
   * Sends `code` to `email`, the normalised address. The app owns the mail: its sender, its text and
   * its transport. A rejection reaches the caller of `requestCode`; the code is already issued then.
   */
  sendCode(email: string, code: string): Promise<void>
  /** How long a code stays valid, in whole minutes. Defaults to {@link DEFAULT_CODE_TTL_MINUTES}. */
  codeTtlMinutes?: number
  /** Guesses one challenge allows. Defaults to {@link DEFAULT_CODE_MAX_ATTEMPTS}. */
  maxAttempts?: number
}

/** The email-code sign-in provider. */
export interface EmailCodeSignIn {
  /**
   * Issues a new code for the address and sends it. A code asked for while an earlier one is live
   * replaces it and keeps its guess counter, so asking again never buys more guesses. The outcome
   * is the same whether or not the address has an account.
   *
   * @throws {EmailCodeError} `invalid-email` when `normalizeEmail` rejects the address.
   */
  requestCode(email: string): Promise<void>
  /**
   * Checks one guess and, on a match, signs in and creates a session. Surrounding whitespace in the
   * code is ignored.
   *
   * @throws {EmailCodeError} `invalid-email`, `wrong-code`, `locked-out`, `no-code`, or
   *     `account-deleted`.
   * @throws {AuthConflictError} When another sign-in for the same address wrote first (a new code
   *     then succeeds), or an email-code key for the address carries no `email` and so cannot be
   *     evicted.
   */
  verifyCode(email: string, code: string): Promise<SignInResult>
  /**
   * Proves `email` for the signed-in user `userId` with a code from `requestCode`, and creates no
   * user and no session. On a match, every key of the user that carries the address is proven with
   * `proveKey`; when none does, a proven email-code key is added to the user. The user keeps their
   * id and keys and becomes the owner of the address, and every other user's unproven claim to it
   * is deleted. An address the user already owns is a success that writes nothing.
   *
   * The code is the one `requestCode` sends for sign-in: it is bound to the address, not to a user.
   * The session proves who asks and the code proves the mailbox, so a code only ever works for the
   * person who received it, once. Take `userId` from a validated session, never from the request.
   *
   * Several keys that carry the address are proven with one `proveKey` each, not in one
   * transaction. A failure part-way leaves some proven; calling again with a new code finishes the
   * rest.
   *
   * @returns The user's keys that carry the address, all proven, sorted by id. They carry `secret`
   *     (a password hash for a password key): keep them on the server, never in a response body.
   * @throws {EmailCodeError} `invalid-email`, `wrong-code`, `locked-out`, `no-code`, or
   *     `account-deleted` when the user is soft-deleted (checked before a guess is spent).
   * @throws {AuthConflictError} `email-owned` when another user owns the address; the code is used
   *     by then. `key-exists` when an email-code key for the address carries no `email`.
   * @throws {RangeError} When no user has the id `userId`. No guess is spent.
   */
  proveAddress(userId: number, email: string, code: string): Promise<AuthKey[]>
}

/**
 * Creates the email-code sign-in provider.
 *
 * @throws {RangeError} When `codeTtlMinutes` or `maxAttempts` is not a positive integer.
 */
export function createEmailCodeSignIn(deps: EmailCodeSignInDeps): EmailCodeSignIn {
  const ttlMinutes = positiveInteger(
    "codeTtlMinutes",
    deps.codeTtlMinutes ?? DEFAULT_CODE_TTL_MINUTES,
  )
  const maxAttempts = positiveInteger("maxAttempts", deps.maxAttempts ?? DEFAULT_CODE_MAX_ATTEMPTS)
  const clock = deps.clock ?? systemClock
  const { store, sessions } = deps

  return {
    async requestCode(email: string): Promise<void> {
      const address = requireEmail(email)
      const now = new Date(clock.now())
      const code = randomBase64Url(EMAIL_CODE_BYTES)
      await store.issueChallenge({
        purpose: EMAIL_CODE_PURPOSE,
        subject: address,
        secretHash: await hashCode(address, code),
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
        now,
      })
      await deps.sendCode(address, code)
    },

    async verifyCode(email: string, code: string): Promise<SignInResult> {
      const address = requireEmail(email)
      if (typeof code !== "string") throw new EmailCodeError("wrong-code")
      const now = new Date(clock.now())
      const outcome = await store.attemptChallenge({
        purpose: EMAIL_CODE_PURPOSE,
        subject: address,
        secretHash: await hashCode(address, code.trim()),
        maxAttempts,
        now,
      })
      if (outcome !== ChallengeOutcome.Matched) throw new EmailCodeError(refusalOf(outcome))

      const { user, key } = await signInKey(store, address, now)
      const secondFactor = deps.secondFactorFor
        ? await deps.secondFactorFor(user)
        : SecondFactorStatus.NotRequired
      const session = await sessions.create({ userId: user.id, keyId: key.id, secondFactor })
      return { user, key, session }
    },

    async proveAddress(userId: number, email: string, code: string): Promise<AuthKey[]> {
      const address = requireEmail(email)
      if (typeof code !== "string") throw new EmailCodeError("wrong-code")
      const user = await store.findUser(userId)
      if (user === null) throw new RangeError(`no auth user with id ${userId}`)
      if (user.deletedAt !== null) throw new EmailCodeError("account-deleted")
      const now = new Date(clock.now())
      const outcome = await store.attemptChallenge({
        purpose: EMAIL_CODE_PURPOSE,
        subject: address,
        secretHash: await hashCode(address, code.trim()),
        maxAttempts,
        now,
      })
      if (outcome !== ChallengeOutcome.Matched) throw new EmailCodeError(refusalOf(outcome))
      return await proveFor(store, user.id, address, now)
    },
  }
}

/**
 * Proves `address` for `userId`, who showed a matching code: proves each of the user's own keys
 * that carry it, or adds a proven email-code key when none does. Never touches another user's key
 * except through the eviction `proveKey` and a proven `addKey` perform.
 *
 * Ownership is checked only after the code matched, so the answer `email-owned` never tells a
 * caller without the code that somebody owns the address.
 */
async function proveFor(
  store: AuthStore,
  userId: number,
  address: string,
  now: Date,
): Promise<AuthKey[]> {
  const owner = await store.findUserIdByProvenEmail(address)
  if (owner !== null && owner !== userId) throw new AuthConflictError("email-owned")
  const carrying = (await store.listKeys(userId)).filter((key) => key.email === address)
  if (carrying.length === 0) {
    const key = await store.addKey(userId, {
      method: EMAIL_CODE_METHOD,
      subject: address,
      email: address,
      secret: null,
      provenAt: now,
    })
    return [key]
  }
  const proven: AuthKey[] = []
  for (const key of carrying) {
    proven.push(key.provenAt === null ? await store.proveKey(key.id, now) : key)
  }
  return proven
}

/**
 * The user and key a matched code for `address` signs in, written as described in the module
 * documentation. Never deletes a key of the user it signs in.
 */
async function signInKey(
  store: AuthStore,
  address: string,
  now: Date,
): Promise<{ user: AuthUser; key: AuthKey }> {
  const owner = await store.findUserIdByProvenEmail(address)
  const existing = await store.findKey(EMAIL_CODE_METHOD, address)
  const newKey = {
    method: EMAIL_CODE_METHOD,
    subject: address,
    email: address,
    secret: null,
    provenAt: now,
  }
  if (owner === null) return await store.createUserWithKey(newKey)

  const user = await store.findUser(owner)
  if (user === null) throw new Error(`the owner of a proven address, user ${owner}, is missing`)
  if (user.deletedAt !== null) throw new EmailCodeError("account-deleted")
  const key = existing !== null && existing.userId === owner
    ? await store.proveKey(existing.id, now)
    : await store.addKey(owner, newKey)
  return { user, key }
}

/**
 * The stored form of a code: SHA-256 of the address and the code. Binding the address means one
 * digest never stands for the same code sent to two addresses.
 */
function hashCode(address: string, code: string): Promise<string> {
  return sha256Hex(`${EMAIL_CODE_PURPOSE}\n${address}\n${code}`)
}

function requireEmail(email: string): string {
  const address = normalizeEmail(email)
  if (address === null) throw new EmailCodeError("invalid-email")
  return address
}

function refusalOf(outcome: ChallengeOutcome): EmailCodeErrorReason {
  if (outcome === ChallengeOutcome.WrongGuess) return "wrong-code"
  if (outcome === ChallengeOutcome.LockedOut) return "locked-out"
  return "no-code"
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}
