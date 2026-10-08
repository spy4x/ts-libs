/**
 * The in-memory {@link OAuthStore}: for tests, and for a single process that accepts that a restart
 * signs every client out.
 * @module
 */

import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import type {
  AccessTokenRecord,
  CodeRecord,
  OAuthStore,
  PendingAuthorization,
  RefreshTokenRecord,
} from "./model.ts"

/** Options for {@link MemoryOAuthStore}. */
export interface MemoryOAuthStoreOptions {
  /** Decides when a record has expired and may be dropped. Defaults to the system clock. */
  clock?: Clock
}

interface Expiring {
  expiresAt: number
}

/**
 * Keeps every record in a `Map`. JavaScript runs each method to its first `await` without
 * interruption and these methods never await, so `consumeCode`, `consumeRefreshToken` and
 * `takePending` are atomic. Records are copied in and out, so a caller cannot edit a stored one.
 * Expired records are dropped whenever a new one is saved. A revoked grant id is kept until its
 * `until`, so a token saved late for it is refused.
 */
export class MemoryOAuthStore implements OAuthStore {
  readonly #clock: Clock
  readonly #pending = new Map<string, PendingAuthorization>()
  readonly #codes = new Map<string, CodeRecord>()
  readonly #access = new Map<string, AccessTokenRecord>()
  readonly #refresh = new Map<string, RefreshTokenRecord>()
  /** Revoked grant ids, each mapped to the epoch milliseconds its refusal lasts until. */
  readonly #revoked = new Map<string, number>()

  constructor(options: MemoryOAuthStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock
  }

  savePending(key: string, record: PendingAuthorization): Promise<void> {
    return this.#save(this.#pending, key, record)
  }

  takePending(key: string): Promise<PendingAuthorization | undefined> {
    const record = this.#pending.get(key)
    this.#pending.delete(key)
    return Promise.resolve(record && structuredClone(record))
  }

  saveCode(key: string, record: CodeRecord): Promise<void> {
    return this.#save(this.#codes, key, record)
  }

  consumeCode(key: string): Promise<CodeRecord | undefined> {
    return Promise.resolve(this.#consume(this.#codes, key))
  }

  saveAccessToken(key: string, record: AccessTokenRecord): Promise<boolean> {
    return this.#saveToken(this.#access, key, record)
  }

  findAccessToken(key: string): Promise<AccessTokenRecord | undefined> {
    const record = this.#access.get(key)
    return Promise.resolve(record && structuredClone(record))
  }

  saveRefreshToken(key: string, record: RefreshTokenRecord): Promise<boolean> {
    return this.#saveToken(this.#refresh, key, record)
  }

  findRefreshToken(key: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.#refresh.get(key)
    return Promise.resolve(record && structuredClone(record))
  }

  consumeRefreshToken(key: string): Promise<RefreshTokenRecord | undefined> {
    return Promise.resolve(this.#consume(this.#refresh, key))
  }

  revokeGrant(grantId: string, until: number): Promise<void> {
    this.#revoked.set(grantId, Math.max(until, this.#revoked.get(grantId) ?? 0))
    for (const map of [this.#access, this.#refresh]) {
      for (const [key, record] of map) {
        if (record.grantId === grantId) map.delete(key)
      }
    }
    return Promise.resolve()
  }

  #consume<T extends { usedAt?: number }>(map: Map<string, T>, key: string): T | undefined {
    const record = map.get(key)
    if (record === undefined) return undefined
    const before = structuredClone(record)
    if (record.usedAt === undefined) record.usedAt = this.#clock.now()
    return before
  }

  #isRevoked(grantId: string): boolean {
    const until = this.#revoked.get(grantId)
    return until !== undefined && until > this.#clock.now()
  }

  #saveToken<T extends Expiring & { grantId: string }>(
    map: Map<string, T>,
    key: string,
    record: T,
  ): Promise<boolean> {
    if (this.#isRevoked(record.grantId)) return Promise.resolve(false)
    this.#prune()
    map.set(key, structuredClone(record))
    return Promise.resolve(true)
  }

  #save<T extends Expiring>(map: Map<string, T>, key: string, record: T): Promise<void> {
    this.#prune()
    map.set(key, structuredClone(record))
    return Promise.resolve()
  }

  #prune(): void {
    const now = this.#clock.now()
    for (const map of [this.#pending, this.#codes, this.#access, this.#refresh]) {
      for (const [key, record] of map as Map<string, Expiring>) {
        if (record.expiresAt <= now) map.delete(key)
      }
    }
    for (const [grantId, until] of this.#revoked) {
      if (until <= now) this.#revoked.delete(grantId)
    }
  }
}
