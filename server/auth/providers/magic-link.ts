/**
 * Magic-link provider: a single-use token emailed to an address, which signs that
 * address in when it comes back.
 *
 * Three changes from `roley/providers/magicLink.ts`, all security fixes.
 *
 * **Hashed at rest.** The source wrote the raw token into `key.secret` (`:37`,
 * `:50`, `:63`) and compared it with `!==` (`:152`) and `===` (`:192`). A dump of
 * the keys table was therefore a set of working login links. Here only the
 * PBKDF2 digest is stored — the same mechanism passwords use, so there is one
 * hashing path in the package, not two.
 *
 * **Constant-time comparison.** `CryptoContext.constantTimeEquals` digests both
 * sides to a fixed 32 bytes before comparing, so neither the content nor the
 * length of a guessed token is observable in the response time. A plain `===`
 * exits at the first differing byte, and an early return on a length mismatch
 * leaks the length.
 *
 * **Single use, with a deadline and a lockout.** The source left the token valid
 * until the next one was requested, with no expiry and no attempt counter, so a
 * leaked link worked indefinitely and could be guessed without limit. `check`
 * now refuses an expired key, counts every failed verification toward
 * `maxAttempts`, and deletes the key on success.
 *
 * The stub API surface is gone: `getUserByEmail` and `createToken` returned
 * `Promise.resolve(null)` after a no-op `email.toString()` call, and
 * `checkToken` compared two strings the caller had to fetch itself.
 */

import type { EventPublisher, ProviderDeps } from "./provider.ts"
import type { Everything, IMagicLinkProvider, Key, User } from "../types.ts"
import { EventKind } from "../events.ts"
import { KeyKind } from "../types.ts"
import type { CryptoContext } from "../crypto.ts"
import {
  DEFAULT_MAGIC_LINK_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SESSION_LENGTH,
} from "../constants.ts"
import { getRandomString } from "../random.ts"

/** Options for `MagicLinkProvider`. */
export interface MagicLinkProviderOptions extends ProviderDeps {
  crypto: CryptoContext
  publish: EventPublisher
  /** Base URL a link points at, without query. */
  redirectUri: string
  /** Query parameter carrying the address. */
  emailParam?: string
  /** Query parameter carrying the token. */
  tokenParam?: string
  /** Link lifetime in milliseconds. */
  ttlMs?: number
  /** Failed verifications of one link before it stops accepting guesses. */
  maxAttempts?: number
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Single-use emailed links.
 *
 * `token` is returned to the caller exactly once, so it can be emailed and never
 * stored. The returned `Key.secret` is the digest, which is useless as a link.
 */
export class MagicLinkProvider implements IMagicLinkProvider {
  /** The credential kind this provider owns, for the account-linking handlers. */
  readonly keyKind = KeyKind.MagicLink
  private readonly deps: ProviderDeps
  private readonly crypto: CryptoContext
  private readonly publish: EventPublisher
  private readonly redirectUri: string
  private readonly emailParam: string
  private readonly tokenParam: string
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly now: () => number

  constructor(options: MagicLinkProviderOptions) {
    this.deps = options
    this.crypto = options.crypto
    this.publish = options.publish
    this.redirectUri = options.redirectUri
    this.emailParam = options.emailParam ?? "email"
    this.tokenParam = options.tokenParam ?? "token"
    this.ttlMs = options.ttlMs ?? DEFAULT_MAGIC_LINK_TTL_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.now = options.now ?? Date.now
  }

  exists(userId: number): Promise<null | Key> {
    return this.deps.key.findByUserId({ userId, kind: KeyKind.MagicLink })
  }

  getUserByEmail(email: string): Promise<null | User> {
    return this.findUserByEmail(email)
  }

  /**
   * Create or rotate the link for `email`, creating the account when the address
   * is unknown. Returns the raw token, never the stored value.
   */
  async signUp(email: string): Promise<string> {
    const token = this.newToken()
    const secret = await this.crypto.hash(token)
    const expiresAt = this.expiry()
    const existing = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.MagicLink,
      identification: email,
    })
    if (existing) {
      // Rotating resets the attempt counter: a fresh link is not locked out by
      // guesses at the previous one.
      await this.deps.key.update(existing.id, { secret, expiresAt, attempts: 0 })
      return token
    }
    const sibling = await this.deps.key.findByIdentification(email)
    if (sibling && sibling.kind !== KeyKind.MagicLink) {
      const key = await this.deps.key.create({
        userId: sibling.userId,
        kind: KeyKind.MagicLink,
        identification: email,
        email,
        secret,
        expiresAt,
        attempts: 0,
      })
      if (!key) {
        throw new Error("magic-link key was not created")
      }
      const user = await this.deps.user.get(sibling.userId)
      if (!user) {
        throw new Error("user for the existing key was not found")
      }
      await this.publish({
        kind: EventKind.MethodConnected,
        user,
        key,
        email,
      })
      return token
    }

    const body = await this.deps.session.createBody({ userId: -1, keyId: -1 })
    const everything = await this.deps.user.createWithEverything(
      { kind: KeyKind.MagicLink, identification: email, secret, expiresAt, attempts: 0 },
      body.session,
      { email },
    )
    everything.session.token = body.notHashedToken
    await this.publish({
      kind: EventKind.MethodConnected,
      user: everything.user,
      key: everything.key,
      email,
      isNewUser: true,
    })
    return token
  }

  /** Rotate the link for an address that already has a magic-link key. */
  async signIn(email: string): Promise<string> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.MagicLink,
      identification: email,
    })
    if (!key) {
      throw new Error("no magic-link key for this address")
    }
    const token = this.newToken()
    await this.deps.key.update(key.id, {
      secret: await this.crypto.hash(token),
      expiresAt: this.expiry(),
      attempts: 0,
    })
    return token
  }

  /**
   * Create a link key for an address without creating an account, for a caller
   * that already knows which user it means.
   *
   * The raw token travels on `notHashedToken`; `key.secret` is the digest. The
   * source returned `null` here unconditionally.
   */
  async createToken(email: string): Promise<null | { key: Key; notHashedToken: string }> {
    const token = this.newToken()
    const key = await this.deps.key.create({
      userId: -1,
      kind: KeyKind.MagicLink,
      identification: email,
      email,
      secret: await this.crypto.hash(token),
      expiresAt: this.expiry(),
      attempts: 0,
    })
    if (!key) {
      return null
    }
    return { key, notHashedToken: token }
  }

  getRedirectURL(email: string, token: string): string {
    const url = new URL(this.redirectUri)
    url.searchParams.set(this.emailParam, email)
    url.searchParams.set(this.tokenParam, token)
    return url.toString()
  }

  /**
   * Verify a link and consume it.
   *
   * Returns `null` for every failure — unknown address, expired link, locked-out
   * link, wrong token — without distinguishing them to the caller. A wrong token
   * increments the counter; the key is deleted once a correct token creates the
   * session, which is what makes a replay fail.
   */
  async check(email: string, token: string): Promise<null | Everything> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.MagicLink,
      identification: email,
    })
    if (!key || !key.secret) {
      return null
    }
    if (key.expiresAt && key.expiresAt.getTime() <= this.now()) {
      return null
    }
    if ((key.attempts ?? 0) >= this.maxAttempts) {
      return null
    }
    if (!(await this.verifyToken(token, key.secret))) {
      await this.deps.key.update(key.id, { attempts: (key.attempts ?? 0) + 1 })
      return null
    }
    const user = await this.deps.user.get(key.userId)
    if (!user) {
      return null
    }
    const session = await this.deps.session.create({ userId: key.userId, keyId: key.id })
    if (!session) {
      return null
    }
    // Consume: this is the delete-on-use step. Without it the same link keeps
    // minting sessions until it expires.
    await this.deps.key.deleteById(key.id)
    return { user, key, session }
  }

  /** Attach a magic-link key to an existing account. */
  async connect(userId: number, email: string): Promise<Everything> {
    const existing = await this.deps.key.findByUserId({ userId, kind: KeyKind.MagicLink })
    if (existing) {
      throw new Error("magic-link key already exists for this user")
    }
    const key = await this.deps.key.create({
      userId,
      kind: KeyKind.MagicLink,
      identification: email,
      email,
      secret: await this.crypto.hash(this.newToken()),
      expiresAt: this.expiry(),
      attempts: 0,
    })
    if (!key) {
      throw new Error("magic-link key was not created")
    }
    const session = await this.deps.session.create({ userId: key.userId, keyId: key.id })
    if (!session) {
      throw new Error("session was not created")
    }
    const user = await this.deps.user.get(userId)
    if (!user) {
      throw new Error("user was not found")
    }
    await this.publish({ kind: EventKind.MethodConnected, user, key, email })
    return { user, key, session }
  }

  disconnect(userId: number): Promise<boolean> {
    return this.deps.key.delete({ userId, kind: KeyKind.MagicLink })
  }

  /** Move the magic-link key to a new address, invalidating the outstanding link. */
  async changeEmail(userId: number, email: string): Promise<string> {
    const key = await this.deps.key.findByUserId({ userId, kind: KeyKind.MagicLink })
    if (!key) {
      throw new Error("no magic-link key for this user")
    }
    const token = this.newToken()
    await this.deps.key.update(key.id, {
      identification: email,
      secret: await this.crypto.hash(token),
      expiresAt: this.expiry(),
      attempts: 0,
    })
    return token
  }

  /**
   * Verify a presented token against the stored one, in constant time.
   *
   * The comparison runs on the *digests*, never on the raw values: `verify`
   * derives the presented token with the stored salt and compares the two
   * fixed-width keys with `timingSafeEqual`. Three properties fall out of that,
   * and each is why a plain `===` is not equivalent:
   *
   *  - the stored `secret` is already a hash, so there is no raw token to compare
   *    against and no length to leak from the stored side;
   *  - both operands handed to the comparison are the same fixed width (32 bytes,
   *    or the width the stored key was derived at), so no branch observes the
   *    presented length. `timingSafeEqual` throws on unequal lengths, and a caught
   *    throw is a length oracle;
   *  - a mismatch is `false`, never an exception, so callers cannot distinguish
   *    "wrong token" from "wrong token length" by the failure mode.
   *
   * Exported on its own so this rule is testable directly rather than only through
   * a full sign-in flow.
   */
  verifyToken(provided: string, storedSecret: string): Promise<boolean> {
    return this.crypto.verify(provided, storedSecret)
  }

  /** The account that owns the magic-link key for `email`, if any. */ private async findUserByEmail(
    email: string,
  ): Promise<null | User> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.MagicLink,
      identification: email,
    })
    if (!key) {
      return null
    }
    return this.deps.user.get(key.userId)
  }

  private newToken(): string {
    return getRandomString(DEFAULT_SESSION_LENGTH)
  }

  private expiry(): Date {
    return new Date(this.now() + this.ttlMs)
  }
}
