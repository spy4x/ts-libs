/**
 * Email + password provider, including the password-reset flow.
 *
 * The port is close to the source, because this provider was already the
 * well-tested one. What changed:
 *
 *  - the pepper arrives through `CryptoContext`, which refuses to exist without
 *    one, instead of `createAuth` substituting the literal `'custom-auth'`;
 *  - the reset token is compared through `CryptoContext.verify`, which is
 *    constant-time over the derived bytes, rather than through `bcrypt.compare`
 *    on a value that also had the pepper appended;
 *  - a password change creates the replacement session *before* revoking the
 *    others, so a failure to mint the new session cannot leave the user signed
 *    out of everything;
 *  - no error path logs the password, the hash or the reset token.
 */

import type { EventPublisher, ProviderDeps } from "./provider.ts"
import type { Everything, IEmailPasswordProvider, Key, Session, User } from "../types.ts"
import { EventKind } from "../events.ts"
import { KeyKind } from "../types.ts"
import type { CryptoContext } from "../crypto.ts"
import { DEFAULT_SESSION_LENGTH } from "../constants.ts"
import { getRandomString } from "../random.ts"

/** Options for `EmailPasswordProvider`. */
export interface EmailPasswordProviderOptions extends ProviderDeps {
  crypto: CryptoContext
  publish: EventPublisher
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number
}

/** How long a password-reset token stays valid. */
const RESET_TTL_MS = 60 * 60 * 1000

/** Password sign-in, signup, reset and change. */
export class EmailPasswordProvider implements IEmailPasswordProvider {
  private readonly deps: ProviderDeps
  private readonly crypto: CryptoContext
  private readonly publish: EventPublisher
  private readonly now: () => number

  constructor(options: EmailPasswordProviderOptions) {
    this.deps = options
    this.crypto = options.crypto
    this.publish = options.publish
    this.now = options.now ?? Date.now
  }

  /**
   * Register a new account.
   *
   * The password is hashed before the session body is built so the two expensive
   * operations are not serialised behind each other even when the caller awaits
   * them in sequence.
   */
  async signUp(email: string, password: string): Promise<Everything> {
    const [secret, body] = await Promise.all([
      this.crypto.hash(password),
      this.deps.session.createBody({ userId: -1, keyId: -1 }),
    ])
    const everything = await this.deps.user.createWithEverything(
      { kind: KeyKind.EmailPassword, identification: email, email, secret },
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
    return everything
  }

  /** Verify a password and mint a session. Returns `null` for both failure modes. */
  async signIn(email: string, password: string): Promise<null | Everything> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPassword,
      identification: email,
    })
    if (!key || !key.secret) {
      return null
    }
    if (!(await this.crypto.verify(password, key.secret))) {
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
    if (user.email) {
      return { user, key, session }
    }
    const updated = await this.deps.user.update(user.id, { email })
    return { user: updated ?? user, key, session }
  }

  /** Attach a password credential to an account that already exists. */
  async connect(userId: number, email: string, password: string): Promise<null | Everything> {
    const [secret, user] = await Promise.all([
      this.crypto.hash(password),
      this.deps.user.get(userId),
    ])
    if (!user) {
      return null
    }
    const taken = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPassword,
      identification: email,
    })
    if (taken && taken.userId !== userId) {
      return null
    }
    const key = await this.deps.key.create({
      userId,
      kind: KeyKind.EmailPassword,
      identification: email,
      email,
      secret,
    })
    if (!key) {
      return null
    }
    const session = await this.deps.session.create({ userId: key.userId, keyId: key.id })
    if (!session) {
      return null
    }
    await this.publish({ kind: EventKind.MethodConnected, user, key, email })
    return { user, key, session }
  }

  disconnect(userId: number): Promise<boolean> {
    return this.deps.key.delete({ userId, kind: KeyKind.EmailPassword })
  }

  getUserByEmail(email: string): Promise<null | User> {
    return this.findUserByEmail(email)
  }

  isEmailTaken(email: string): Promise<boolean> {
    return this.deps.key
      .findByKindAndIdentification({ kind: KeyKind.EmailPassword, identification: email })
      .then((key) => key !== null)
  }

  /**
   * Mint a reset token for an address.
   *
   * Returns `null` when no password credential exists, so the caller cannot use
   * this endpoint to enumerate accounts any faster than the sign-in endpoint
   * already allows.
   */
  async createPasswordResetToken(email: string): Promise<null | string> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPassword,
      identification: email,
    })
    if (!key) {
      return null
    }
    const token = getRandomString(DEFAULT_SESSION_LENGTH)
    const created = await this.deps.key.create({
      userId: key.userId,
      kind: KeyKind.EmailPasswordReset,
      identification: email,
      email,
      secret: await this.crypto.hash(token),
      expiresAt: new Date(this.now() + RESET_TTL_MS),
      attempts: 0,
    })
    if (!created) {
      return null
    }
    return token
  }

  /**
   * Consume a reset token and set a new password.
   *
   * The reset key is deleted and every existing session for the account is
   * revoked — a password change must not leave the sessions that motivated it
   * alive — and only then is a fresh session minted.
   */
  async validatePasswordResetToken(
    email: string,
    token: string,
    newPassword: string,
  ): Promise<null | Session> {
    const resetKey = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPasswordReset,
      identification: email,
    })
    if (!resetKey?.secret) {
      return null
    }
    if (resetKey.expiresAt && resetKey.expiresAt.getTime() <= this.now()) {
      return null
    }
    if ((resetKey.attempts ?? 0) >= 3) {
      return null
    }
    if (!(await this.crypto.verify(token, resetKey.secret))) {
      await this.deps.key.update(resetKey.id, { attempts: (resetKey.attempts ?? 0) + 1 })
      return null
    }
    const passwordKey = await this.deps.key.findByUserId({
      kind: KeyKind.EmailPassword,
      userId: resetKey.userId,
    })
    if (!passwordKey) {
      return null
    }
    const session = await this.deps.session.create({
      userId: passwordKey.userId,
      keyId: passwordKey.id,
    })
    if (!session) {
      return null
    }
    await this.deps.key.update(passwordKey.id, { secret: await this.crypto.hash(newPassword) })
    await this.deps.key.deleteById(resetKey.id)
    await this.deps.session.deleteAll(passwordKey.userId)
    return session
  }

  /** Change the address a password credential authenticates with. */
  async changeEmail(userId: number, email: string, password: string): Promise<boolean> {
    const key = await this.deps.key.findByUserId({ kind: KeyKind.EmailPassword, userId })
    if (!key?.secret) {
      return false
    }
    if (!(await this.crypto.verify(password, key.secret))) {
      return false
    }
    const taken = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPassword,
      identification: email,
    })
    if (taken && taken.id !== key.id) {
      return false
    }
    await this.deps.key.update(key.id, { identification: email, email })
    return true
  }

  /**
   * Change a password and invalidate every other session.
   *
   * The replacement session is created first: revoking first and then failing to
   * mint would sign the user out of the account they just changed the password of.
   */
  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<null | Session> {
    const key = await this.deps.key.findByUserId({ kind: KeyKind.EmailPassword, userId })
    if (!key?.secret) {
      return null
    }
    if (!(await this.crypto.verify(oldPassword, key.secret))) {
      return null
    }
    const session = await this.deps.session.create({ userId, keyId: key.id })
    if (!session) {
      return null
    }
    await this.deps.key.update(key.id, { secret: await this.crypto.hash(newPassword) })
    await this.deps.session.deleteAll(userId)
    return session
  }

  hashPassword(password: string): Promise<string> {
    return this.crypto.hash(password)
  }

  checkPassword(password: string, hash: string): Promise<boolean> {
    return this.crypto.verify(password, hash)
  }

  private async findUserByEmail(email: string): Promise<null | User> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.EmailPassword,
      identification: email,
    })
    if (!key) {
      return null
    }
    return this.deps.user.get(key.userId)
  }

  /** The password credential of an account, for a caller that needs the row. */
  credential(userId: number): Promise<null | Key> {
    return this.deps.key.findByUserId({ kind: KeyKind.EmailPassword, userId })
  }
}
