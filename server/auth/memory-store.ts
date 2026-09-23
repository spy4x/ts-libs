/**
 * `MemoryAuthStore`: an in-memory {@link AuthStore} for unit tests.
 *
 * It enforces every rule the Postgres tables enforce — unique (method, subject), one owner per
 * proven address, no key without a user — and the same input checks, and the contract suite in
 * `store-contract.test.ts` runs against both stores to keep it that way. Each method does all its
 * reading and writing synchronously before it returns its promise, so two calls never interleave:
 * that is what makes it as atomic as the single statements and transactions of the Postgres store.
 *
 * Every row goes in and comes out as a copy, as it would through a database driver.
 *
 * Not re-exported from `@ts-libs/server/auth`: a test double does not belong on the production
 * entry point. Import it from `@ts-libs/server/auth/memory-store`.
 *
 * @module
 */

import { type Clock, systemClock } from "@ts-libs/platform/universal/time"
import {
  AuthConflictError,
  type AuthKey,
  type AuthUser,
  ChallengeOutcome,
  type NewAuthKey,
} from "./model.ts"
import type { AttemptChallengeInput, AuthStore, IssueChallengeInput } from "./store.ts"
import {
  checkAttemptChallenge,
  checkDate,
  checkIssueChallenge,
  checkNewKey,
  checkSecret,
  isStoreId,
} from "./input.ts"

/** Options for {@link MemoryAuthStore}. */
export interface MemoryAuthStoreOptions {
  /** Time source for `createdAt` and `updatedAt`. Defaults to the host clock. */
  clock?: Clock
}

interface ChallengeRow {
  secretHash: string
  attempts: number
  expiresAt: Date
}

/** An in-memory {@link AuthStore} with the same constraints and atomicity as the Postgres store. */
export class MemoryAuthStore implements AuthStore {
  readonly #clock: Clock
  readonly #users = new Map<number, AuthUser>()
  readonly #keys = new Map<number, AuthKey>()
  /** Proven address → the user who owns it. */
  readonly #owners = new Map<string, number>()
  /** `purpose` NUL `subject` → challenge. */
  readonly #challenges = new Map<string, ChallengeRow>()
  #nextUserId = 1
  #nextKeyId = 1

  constructor(options: MemoryAuthStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock
  }

  findUser(id: number): Promise<AuthUser | null> {
    return settle(() => {
      const user = isStoreId(id) ? this.#users.get(id) : undefined
      return user ? structuredClone(user) : null
    })
  }

  createUserWithKey(key: NewAuthKey): Promise<{ user: AuthUser; key: AuthKey }> {
    return settle(() => {
      const input = checkNewKey(key)
      this.#assertInsertable(null, input)
      const user: AuthUser = { id: this.#nextUserId++, createdAt: this.#now(), deletedAt: null }
      this.#users.set(user.id, user)
      const created = this.#insertKey(user.id, input)
      return { user: structuredClone(user), key: structuredClone(created) }
    })
  }

  addKey(userId: number, key: NewAuthKey): Promise<AuthKey> {
    return settle(() => {
      const input = checkNewKey(key)
      if (!isStoreId(userId) || !this.#users.has(userId)) {
        throw new RangeError(`no auth user with id ${userId}`)
      }
      this.#assertInsertable(userId, input)
      return structuredClone(this.#insertKey(userId, input))
    })
  }

  findKey(method: string, subject: string): Promise<AuthKey | null> {
    return settle(() => {
      const key = this.#findKey(method, subject)
      return key ? structuredClone(key) : null
    })
  }

  findKeyById(id: number): Promise<AuthKey | null> {
    return settle(() => {
      const key = isStoreId(id) ? this.#keys.get(id) : undefined
      return key ? structuredClone(key) : null
    })
  }

  listKeys(userId: number): Promise<AuthKey[]> {
    return settle(() =>
      [...this.#keys.values()]
        .filter((key) => key.userId === userId)
        .sort((a, b) => a.id - b.id)
        .map((key) => structuredClone(key))
    )
  }

  findUserIdByProvenEmail(email: string): Promise<number | null> {
    return settle(() => this.#owners.get(email) ?? null)
  }

  proveKey(keyId: number, now: Date): Promise<AuthKey> {
    return settle(() => {
      checkDate(now, "now")
      const key = isStoreId(keyId) ? this.#keys.get(keyId) : undefined
      if (!key) throw new RangeError(`no auth key with id ${keyId}`)
      if (key.email === null) throw new TypeError("a key with no email cannot be proven")
      this.#assertOwnable(key.userId, key.email)
      this.#claimAddress(key.userId, key.email)
      key.provenAt ??= new Date(now.getTime())
      key.updatedAt = new Date(now.getTime())
      return structuredClone(key)
    })
  }

  updateKeySecret(keyId: number, secret: string): Promise<boolean> {
    return settle(() => {
      checkSecret(secret)
      const key = isStoreId(keyId) ? this.#keys.get(keyId) : undefined
      if (!key) return false
      key.secret = secret
      key.updatedAt = this.#now()
      return true
    })
  }

  deleteKey(userId: number, keyId: number): Promise<boolean> {
    return settle(() => {
      const key = isStoreId(keyId) ? this.#keys.get(keyId) : undefined
      if (!key || key.userId !== userId) return false
      this.#keys.delete(key.id)
      if (key.provenAt !== null && key.email !== null) this.#releaseIfUnproven(userId, key.email)
      return true
    })
  }

  issueChallenge(input: IssueChallengeInput): Promise<void> {
    return settle(() => {
      const { purpose, subject, secretHash, expiresAt, now } = checkIssueChallenge(input)
      const id = challengeId(purpose, subject)
      const previous = this.#challenges.get(id)
      const live = previous !== undefined && previous.expiresAt.getTime() > now.getTime()
      this.#challenges.set(id, {
        secretHash,
        attempts: live ? previous.attempts : 0,
        expiresAt: new Date(expiresAt.getTime()),
      })
    })
  }

  attemptChallenge(input: AttemptChallengeInput): Promise<ChallengeOutcome> {
    return settle(() => {
      const { purpose, subject, secretHash, maxAttempts, now } = checkAttemptChallenge(input)
      const id = challengeId(purpose, subject)
      const challenge = this.#challenges.get(id)
      if (!challenge || challenge.expiresAt.getTime() <= now.getTime()) {
        return ChallengeOutcome.Missing
      }
      if (challenge.attempts >= maxAttempts) return ChallengeOutcome.LockedOut
      if (challenge.secretHash === secretHash) {
        this.#challenges.delete(id)
        return ChallengeOutcome.Matched
      }
      challenge.attempts += 1
      return ChallengeOutcome.WrongGuess
    })
  }

  #now(): Date {
    return new Date(this.#clock.now())
  }

  #findKey(method: string, subject: string): AuthKey | undefined {
    for (const key of this.#keys.values()) {
      if (key.method === method && key.subject === subject) return key
    }
    return undefined
  }

  /**
   * Throws the conflict a new key for `userId` (null: a user not created yet) would hit, before
   * anything changes. A proven key claims its address first, and that claim deletes another user's
   * unproven key carrying the address, so such a key with the same (method, subject) is no conflict.
   */
  #assertInsertable(userId: number | null, key: NewAuthKey): void {
    const email = key.provenAt === null ? null : key.email
    if (email !== null) this.#assertOwnable(userId, email)
    const existing = this.#findKey(key.method, key.subject)
    if (!existing) return
    const evicted = email !== null && existing.userId !== userId && existing.provenAt === null &&
      existing.email === email
    if (!evicted) throw new AuthConflictError("key-exists")
  }

  #assertOwnable(userId: number | null, email: string): void {
    const owner = this.#owners.get(email)
    if (owner !== undefined && owner !== userId) throw new AuthConflictError("email-owned")
  }

  #insertKey(userId: number, input: NewAuthKey): AuthKey {
    if (input.provenAt !== null && input.email !== null) this.#claimAddress(userId, input.email)
    const now = this.#now()
    const key: AuthKey = {
      id: this.#nextKeyId++,
      userId,
      method: input.method,
      subject: input.subject,
      email: input.email,
      secret: input.secret,
      provenAt: input.provenAt === null ? null : new Date(input.provenAt.getTime()),
      createdAt: now,
      updatedAt: new Date(now.getTime()),
    }
    this.#keys.set(key.id, key)
    return key
  }

  /** Makes `userId` the owner of `email` and deletes every other user's unproven claim to it. */
  #claimAddress(userId: number, email: string): void {
    this.#owners.set(email, userId)
    for (const key of [...this.#keys.values()]) {
      if (key.email === email && key.userId !== userId && key.provenAt === null) {
        this.#keys.delete(key.id)
      }
    }
  }

  /** Drops the user's ownership of `email` once none of their keys carries it proven. */
  #releaseIfUnproven(userId: number, email: string): void {
    for (const key of this.#keys.values()) {
      if (key.userId === userId && key.email === email && key.provenAt !== null) return
    }
    if (this.#owners.get(email) === userId) this.#owners.delete(email)
  }
}

function challengeId(purpose: string, subject: string): string {
  return `${purpose}\u0000${subject}`
}

/** Runs `body` now and settles a promise with its result, so a throw becomes a rejection. */
function settle<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (error) {
    return Promise.reject(error)
  }
}
