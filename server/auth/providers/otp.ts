/**
 * Email one-time-password provider.
 *
 * The source's `check()` verified the code and then returned a session without
 * touching the key (`roley/providers/otp.ts:97-139`). There was no expiry, no
 * attempt counter and no consumption, so:
 *
 *  - a code stayed valid until the next one was requested — indefinitely;
 *  - a leaked or shoulder-surfed code could be replayed forever, each replay
 *    minting a fresh session;
 *  - a wrong guess cost the attacker nothing, so six digits fell to exhaustive
 *    search;
 *  - the key outlived the session it had authorised.
 *
 * This port adds the three missing properties and makes each one observable:
 * `expiresAt` is written with the code and checked before it is, `attempts`
 * counts every failed verification and locks the key at `maxAttempts`, and a
 * successful `check` **deletes the key**. The replay test is the most important
 * test in the package.
 *
 * The code itself comes from `getRandomOtp`, which draws from the platform CSPRNG
 * with rejection sampling. The source drew its digits from the engine's
 * non-cryptographic generator.
 *
 * A link that already exists for the address is reused rather than duplicated:
 * `findByKindAndIdentification` is the keyed lookup that makes that true.
 */

import type { EventPublisher, ProviderDeps } from "./provider.ts"
import type { Everything, IOtpProvider, Key } from "../types.ts"
import { EventKind } from "../events.ts"
import { KeyKind } from "../types.ts"
import type { CryptoContext } from "../crypto.ts"
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_OTP_LENGTH, DEFAULT_OTP_TTL_MS } from "../constants.ts"
import { getRandomOtp, type RandomByteSource } from "../random.ts"

/** Options for `OtpProvider`. */
export interface OtpProviderOptions extends ProviderDeps {
  crypto: CryptoContext
  publish: EventPublisher
  /** Code lifetime in milliseconds. */
  ttlMs?: number
  /** Failed verifications of one code before the key locks out. */
  maxAttempts?: number
  /** Digits in a generated code. */
  otpLength?: number
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Random byte source, for tests. Defaults to the platform CSPRNG. */
  randomSource?: RandomByteSource
}

/** Email one-time passwords, with a deadline, a lockout and delete-on-use. */
export class OtpProvider implements IOtpProvider {
  /** The credential kind this provider owns, for the account-linking handlers. */
  readonly keyKind = KeyKind.Otp
  private readonly deps: ProviderDeps
  private readonly crypto: CryptoContext
  private readonly publish: EventPublisher
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly otpLength: number
  private readonly now: () => number
  private readonly randomSource: RandomByteSource | undefined

  constructor(options: OtpProviderOptions) {
    this.deps = options
    this.crypto = options.crypto
    this.publish = options.publish
    this.ttlMs = options.ttlMs ?? DEFAULT_OTP_TTL_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.otpLength = options.otpLength ?? DEFAULT_OTP_LENGTH
    this.now = options.now ?? Date.now
    this.randomSource = options.randomSource
  }

  /** A fresh code. Never logged, never stored raw. */
  generateOtp(): Promise<string> {
    return Promise.resolve(
      getRandomOtp({ length: this.otpLength, source: this.randomSource }),
    )
  }

  /**
   * Start or restart the OTP flow for `email`, creating the account when the
   * address is unknown. Returns the raw code, which the caller emails.
   */
  async signUp(email: string): Promise<string> {
    const code = await this.generateOtp()
    const credential = await this.newCredential(code)

    const existing = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.Otp,
      identification: email,
    })
    if (existing) {
      await this.deps.key.update(existing.id, credential)
      return code
    }
    const sibling = await this.deps.key.findByIdentification(email)
    if (sibling && sibling.kind !== KeyKind.Otp) {
      const key = await this.deps.key.create({
        userId: sibling.userId,
        kind: KeyKind.Otp,
        identification: email,
        email,
        ...credential,
      })
      if (!key) {
        throw new Error("otp key was not created")
      }
      const user = await this.deps.user.get(sibling.userId)
      if (!user) {
        throw new Error("user for the existing key was not found")
      }
      await this.publish({ kind: EventKind.MethodConnected, user, key, email })
      return code
    }

    const body = await this.deps.session.createBody({ userId: -1, keyId: -1 })
    const everything = await this.deps.user.createWithEverything(
      { kind: KeyKind.Otp, identification: email, ...credential },
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
    return code
  }

  /** Restart the OTP flow for an address that already has an OTP key. */
  async signIn(email: string): Promise<string> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.Otp,
      identification: email,
    })
    if (!key) {
      throw new Error("no otp key for this address")
    }
    const code = await this.generateOtp()
    await this.deps.key.update(key.id, await this.newCredential(code))
    return code
  }

  /**
   * Verify a code and consume it.
   *
   * Order matters: the deadline and the lockout are checked *before* the code, so
   * a locked-out key cannot be probed further even with a correct guess. Every
   * failed verification increments `attempts`, so the (maxAttempts + 1)-th
   * attempt fails whether or not it is right.
   */
  async check(email: string, otp: string): Promise<null | Everything> {
    const key = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.Otp,
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
    if (!(await this.crypto.verify(otp, key.secret))) {
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
    // Consume. Removing this line makes the code replayable forever, which is the
    // single most important behaviour in this package.
    await this.deps.key.deleteById(key.id)
    return { user, key, session }
  }

  /** Move the OTP key to a new address and invalidate the outstanding code. */
  async changeEmail(userId: number, newEmail: string): Promise<string> {
    const key = await this.deps.key.findByUserId({ userId, kind: KeyKind.Otp })
    if (!key) {
      throw new Error("no otp key for this user")
    }
    const other = await this.deps.key.findByIdentification(newEmail)
    if (other && other.userId !== userId) {
      throw new Error("address already belongs to another account")
    }
    const code = await this.generateOtp()
    await this.deps.key.update(key.id, {
      identification: newEmail,
      ...await this.newCredential(code),
    })
    return code
  }

  /** Attach an OTP key to an existing account. */
  async connect(userId: number, email: string): Promise<Everything> {
    const existing = await this.deps.key.findByUserId({ userId, kind: KeyKind.Otp })
    if (existing) {
      throw new Error("otp key already exists for this user")
    }
    const key = await this.deps.key.create({
      userId,
      kind: KeyKind.Otp,
      identification: email,
      email,
      ...await this.newCredential(await this.generateOtp()),
    })
    if (!key) {
      throw new Error("otp key was not created")
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
    return this.deps.key.delete({ userId, kind: KeyKind.Otp })
  }

  private async newCredential(
    code: string,
  ): Promise<{ secret: string; expiresAt: Date; attempts: number }> {
    return {
      secret: await this.crypto.hash(code),
      expiresAt: new Date(this.now() + this.ttlMs),
      attempts: 0,
    }
  }

  /** The key an account authenticates with, for a caller that needs the row. */
  existing(userId: number): Promise<null | Key> {
    return this.deps.key.findByUserId({ userId, kind: KeyKind.Otp })
  }
}
