/**
 * The in-memory {@link OAuthStore}: for tests, and for a single process that accepts that a restart
 * signs every client out.
 * @module
 */

import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import type {
  AccessTokenRecord,
  CodeRecord,
  GrantRecord,
  OAuthStore,
  PendingAuthorization,
  RefreshTokenRecord,
} from "./model.ts"

/** Options for {@link MemoryOAuthStore}. */
export interface MemoryOAuthStoreOptions {
  /** Decides when a record has expired and may be dropped. Defaults to the system clock. */
  clock?: Clock
  /**
   * Most pending consents kept at once. `GET /authorize` stores one for anyone who calls it, so
   * without a cap a caller could fill the process's memory. When a new one would pass the cap, the
   * oldest is dropped: its consent page then answers that the request expired. Defaults to
   * {@link DEFAULT_MAX_PENDING}.
   */
  maxPending?: number
}

/** Default {@link MemoryOAuthStoreOptions.maxPending}: at most about 5 MB of pending consents. */
export const DEFAULT_MAX_PENDING = 1_000

interface Expiring {
  expiresAt: number
}

/**
 * Keeps every record in a `Map`. JavaScript runs each method to its first `await` without
 * interruption and these methods never await, so `consumeCode`, `consumeRefreshToken` and
 * `takePending` are atomic. Records are copied in and out, so a caller cannot edit a stored one.
 * Expired records are dropped whenever a new one is saved. A revoked grant id is kept until its
 * `until`, so a token saved late for it is refused. Pending consents are capped at `maxPending`,
 * dropping the oldest first. Password attempts live in memory too, so a restart forgets them: use
 * `KvOAuthStore` where a restart must not reset the owner-password lockout.
 */
export class MemoryOAuthStore implements OAuthStore {
  readonly #clock: Clock
  readonly #maxPending: number
  readonly #pending = new Map<string, PendingAuthorization>()
  readonly #codes = new Map<string, CodeRecord>()
  readonly #access = new Map<string, AccessTokenRecord>()
  readonly #refresh = new Map<string, RefreshTokenRecord>()
  readonly #grants = new Map<string, GrantRecord>()
  /** Revoked grant ids, each mapped to the epoch milliseconds its refusal lasts until. */
  readonly #revoked = new Map<string, number>()
  /** Counted password attempts per key, oldest first, and when the newest leaves its window. */
  readonly #attempts = new Map<string, { at: number[]; expiresAt: number }>()

  /** @throws {RangeError} When `maxPending` is not a positive integer. */
  constructor(options: MemoryOAuthStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new RangeError("maxPending must be a positive integer")
    }
    this.#maxPending = maxPending
  }

  savePending(key: string, record: PendingAuthorization): Promise<void> {
    this.#pending.delete(key)
    this.#prune()
    // A Map iterates in insertion order, so the first key is the oldest consent.
    for (const oldest of this.#pending.keys()) {
      if (this.#pending.size < this.#maxPending) break
      this.#pending.delete(oldest)
    }
    this.#pending.set(key, structuredClone(record))
    return Promise.resolve()
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
    this.#grants.delete(grantId)
    for (const map of [this.#access, this.#refresh]) {
      for (const [key, record] of map) {
        if (record.grantId === grantId) map.delete(key)
      }
    }
    return Promise.resolve()
  }

  saveGrant(record: GrantRecord): Promise<boolean> {
    return this.#saveToken(this.#grants, record.grantId, record)
  }

  listGrants(): Promise<GrantRecord[]> {
    const now = this.#clock.now()
    const grants = [...this.#grants.values()].filter((grant) => grant.expiresAt > now)
    grants.sort((a, b) => a.createdAt - b.createdAt)
    return Promise.resolve(grants.map((grant) => structuredClone(grant)))
  }

  takeAttempt(key: string, at: number, limit: number, windowMs: number): Promise<number> {
    this.#prune()
    const recent = (this.#attempts.get(key)?.at ?? []).filter((time) => time + windowMs > at)
    if (recent.length >= limit) {
      return Promise.resolve(recent[recent.length - limit] + windowMs - at)
    }
    recent.push(at)
    recent.sort((a, b) => a - b)
    this.#attempts.set(key, { at: recent, expiresAt: recent[recent.length - 1] + windowMs })
    return Promise.resolve(0)
  }

  releaseAttempt(key: string, at: number): Promise<void> {
    const entry = this.#attempts.get(key)
    const index = entry?.at.indexOf(at) ?? -1
    if (entry !== undefined && index !== -1) {
      entry.at.splice(index, 1)
      if (entry.at.length === 0) this.#attempts.delete(key)
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
    const maps = [
      this.#pending,
      this.#codes,
      this.#access,
      this.#refresh,
      this.#grants,
      this.#attempts,
    ]
    for (const map of maps) {
      for (const [key, record] of map as Map<string, Expiring>) {
        if (record.expiresAt <= now) map.delete(key)
      }
    }
    for (const [grantId, until] of this.#revoked) {
      if (until <= now) this.#revoked.delete(grantId)
    }
  }
}
