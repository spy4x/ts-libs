/**
 * The Deno KV {@link OAuthStore}: keeps connected clients signed in across restarts and deploys,
 * with nothing to run beside the app. Open the database on a mounted volume:
 *
 * ```ts
 * const kv = await Deno.openKv("/data/oauth.kv") // needs --unstable-kv
 * const store = new KvOAuthStore(kv)
 * ```
 * @module
 */

import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import {
  type AccessTokenRecord,
  type ApprovalCodeRecord,
  type CodeRecord,
  type GrantRecord,
  type OAuthStore,
  OAuthStoreContentionError,
  type PendingAuthorization,
  type RefreshTokenRecord,
} from "./model.ts"

/** One read from {@link OAuthKv.get}: `versionstamp` is `null` when the key is absent. */
export interface OAuthKvEntry {
  value: unknown
  versionstamp: string | null
}

/** The part of a `Deno.AtomicOperation` that {@link KvOAuthStore} uses. */
export interface OAuthKvAtomic {
  /** Fail the commit unless each key still has this versionstamp (`null`: still absent). */
  check(...checks: { key: readonly string[]; versionstamp: string | null }[]): OAuthKvAtomic
  /** Write a key, deleted by the database `expireIn` milliseconds later. */
  set(key: readonly string[], value: unknown, options?: { expireIn?: number }): OAuthKvAtomic
  /** Remove a key. */
  delete(key: readonly string[]): OAuthKvAtomic
  /** Apply every mutation, or none when a check fails (`ok: false`). */
  commit(): Promise<{ ok: boolean }>
}

/**
 * The part of a `Deno.Kv` handle that {@link KvOAuthStore} uses.
 *
 * Spelled out rather than taken from `Deno.Kv`: those types are only loaded with the `unstable`
 * compiler option, which this workspace does not set. A real `Deno.Kv` satisfies it structurally,
 * so `new KvOAuthStore(await Deno.openKv(path))` type-checks for an app run with `--unstable-kv`.
 */
export interface OAuthKv {
  /** Read a key. */
  get(key: readonly string[]): Promise<OAuthKvEntry>
  /** Start an atomic operation. */
  atomic(): OAuthKvAtomic
  /** Every entry whose key starts with `prefix`. */
  list(selector: { prefix: readonly string[] }): AsyncIterable<{ key: readonly unknown[] }>
}

/** Options for {@link KvOAuthStore}. */
export interface KvOAuthStoreOptions {
  /**
   * First parts of every key this store writes, so one database can hold other data or several
   * stores. Defaults to `["mcp-oauth"]`.
   */
  prefix?: readonly string[]
  /** Sets each record's `expireIn` and decides when a revocation has lapsed. Defaults to the system clock. */
  clock?: Clock
}

/**
 * How many times a read-check-write loop retries after a conflicting write before it gives up.
 * Each retry follows another request's successful commit to the same key, so a real burst ends long
 * before this.
 */
const MAX_ATTEMPTS = 32

/** Mutations per atomic operation in {@link KvOAuthStore.revokeGrant}, well under Deno KV's limits. */
const DELETE_BATCH = 100

const ACCESS = "access"
const REFRESH = "refresh"
const GRANTS = "grants"
const ATTEMPTS = "attempts"
const APPROVAL = "approval"

/**
 * Keeps every record in Deno KV under `[...prefix, kind, key]`, with `expireIn` set from the
 * record's `expiresAt`, so the database drops it once it has expired.
 *
 * - `takePending`, `takeApprovalCode`, `consumeCode` and `consumeRefreshToken` read the record,
 *   then commit their change with a versionstamp check and retry on a conflict. Of two concurrent
 *   calls, only one sees the record unused.
 * - `saveAccessToken` and `saveRefreshToken` read the grant's revocation key and commit the token
 *   with a check on it, so a token is never saved after `revokeGrant` has started for its grant.
 * - Every token also writes an index key `[...prefix, "grant", grantId, kind, key]` in the same
 *   commit; `revokeGrant` lists it to find the grant's tokens.
 * - Grant records live under `[...prefix, "grants", grantId]`, saved with the same revocation check
 *   as tokens and deleted by `revokeGrant`.
 * - Password attempts live under `[...prefix, "attempts", key]` as a list of times, updated with a
 *   versionstamp check, so the owner-password lockout survives a restart.
 * - One-time approval codes live under `[...prefix, "approval", key]`.
 *
 * Pending consents have no count cap, unlike `MemoryOAuthStore`'s `maxPending`: they live on disk,
 * not in the process's memory, and Deno KV deletes each once its consent page expires. Anyone can
 * create one with `GET /authorize`, so put a rate limiter in front of that route to bound the disk
 * they take. The caller owns the handle and closes it.
 */
export class KvOAuthStore implements OAuthStore {
  readonly #kv: OAuthKv
  readonly #prefix: readonly string[]
  readonly #clock: Clock

  /**
   * @param kv An open `Deno.Kv` handle, or anything that implements {@link OAuthKv}.
   * @throws {TypeError} When `prefix` has a part that is not text.
   */
  constructor(kv: OAuthKv, options: KvOAuthStoreOptions = {}) {
    const prefix = options.prefix ?? ["mcp-oauth"]
    if (!prefix.every((part) => typeof part === "string")) {
      throw new TypeError("prefix must contain only strings")
    }
    this.#kv = kv
    this.#prefix = [...prefix]
    this.#clock = options.clock ?? systemClock
  }

  savePending(key: string, record: PendingAuthorization): Promise<void> {
    return this.#put(this.#key("pending", key), record)
  }

  takePending(key: string): Promise<PendingAuthorization | undefined> {
    return this.#take<PendingAuthorization>(this.#key("pending", key), "takePending")
  }

  saveCode(key: string, record: CodeRecord): Promise<void> {
    return this.#put(this.#key("code", key), record)
  }

  consumeCode(key: string): Promise<CodeRecord | undefined> {
    return this.#consume<CodeRecord>(this.#key("code", key), "consumeCode")
  }

  saveAccessToken(key: string, record: AccessTokenRecord): Promise<boolean> {
    return this.#saveToken(ACCESS, key, record)
  }

  findAccessToken(key: string): Promise<AccessTokenRecord | undefined> {
    return this.#find<AccessTokenRecord>(this.#key(ACCESS, key))
  }

  async deleteAccessToken(key: string): Promise<void> {
    const kvKey = this.#key(ACCESS, key)
    const record = await this.#find<AccessTokenRecord>(kvKey)
    if (record === undefined) return
    await this.#commit(
      this.#kv.atomic().delete(kvKey).delete(this.#key("grant", record.grantId, ACCESS, key)),
    )
  }

  saveRefreshToken(key: string, record: RefreshTokenRecord): Promise<boolean> {
    return this.#saveToken(REFRESH, key, record)
  }

  findRefreshToken(key: string): Promise<RefreshTokenRecord | undefined> {
    return this.#find<RefreshTokenRecord>(this.#key(REFRESH, key))
  }

  consumeRefreshToken(key: string): Promise<RefreshTokenRecord | undefined> {
    return this.#consume<RefreshTokenRecord>(this.#key(REFRESH, key), "consumeRefreshToken")
  }

  async revokeGrant(grantId: string, until: number): Promise<void> {
    // Mark the grant revoked first: from this commit on, a concurrent save fails its check and
    // retries into the refusal, so the listing below cannot miss a token saved after it.
    await this.#markRevoked(grantId, until)

    const doomed: (readonly string[])[] = []
    for await (const { key } of this.#kv.list({ prefix: this.#key("grant", grantId) })) {
      const kind = key[key.length - 2]
      const tokenKey = key[key.length - 1]
      if ((kind !== ACCESS && kind !== REFRESH) || typeof tokenKey !== "string") continue
      doomed.push(this.#key("grant", grantId, kind, tokenKey), this.#key(kind, tokenKey))
    }
    doomed.push(this.#key(GRANTS, grantId))
    for (let start = 0; start < doomed.length; start += DELETE_BATCH) {
      let operation = this.#kv.atomic()
      for (const key of doomed.slice(start, start + DELETE_BATCH)) operation = operation.delete(key)
      await this.#commit(operation)
    }
  }

  async saveGrant(record: GrantRecord): Promise<boolean> {
    const revokedKey = this.#key("revoked", record.grantId)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const revoked = await this.#kv.get(revokedKey)
      if (typeof revoked.value === "number" && revoked.value > this.#clock.now()) return false
      const result = await this.#kv.atomic()
        .check({ key: revokedKey, versionstamp: revoked.versionstamp })
        .set(this.#key(GRANTS, record.grantId), record, {
          expireIn: this.#expireIn(record.expiresAt),
        })
        .commit()
      if (result.ok) return true
    }
    throw contention("saveGrant")
  }

  async listGrants(): Promise<GrantRecord[]> {
    const grants: GrantRecord[] = []
    for await (const { key } of this.#kv.list({ prefix: this.#key(GRANTS) })) {
      const grantId = key[key.length - 1]
      if (typeof grantId !== "string") continue
      const grant = await this.#find<GrantRecord>(this.#key(GRANTS, grantId))
      if (grant !== undefined && grant.expiresAt > this.#clock.now()) grants.push(grant)
    }
    return grants.sort((a, b) => a.createdAt - b.createdAt)
  }

  async takeAttempt(key: string, at: number, limit: number, windowMs: number): Promise<number> {
    const kvKey = this.#key(ATTEMPTS, key)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await this.#kv.get(kvKey)
      const recent = attempts(entry.value).at.filter((time) => time + windowMs > at)
      if (recent.length >= limit) return recent[recent.length - limit] + windowMs - at
      recent.push(at)
      recent.sort((a, b) => a - b)
      const expiresAt = recent[recent.length - 1] + windowMs
      const result = await this.#kv.atomic()
        .check({ key: kvKey, versionstamp: entry.versionstamp })
        .set(kvKey, { at: recent, expiresAt }, { expireIn: this.#expireIn(expiresAt) })
        .commit()
      if (result.ok) return 0
    }
    throw contention("takeAttempt")
  }

  async releaseAttempt(key: string, at: number): Promise<void> {
    const kvKey = this.#key(ATTEMPTS, key)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await this.#kv.get(kvKey)
      const { at: recent, expiresAt } = attempts(entry.value)
      const index = recent.indexOf(at)
      if (index === -1) return
      recent.splice(index, 1)
      const operation = this.#kv.atomic().check({ key: kvKey, versionstamp: entry.versionstamp })
      const result = await (recent.length === 0
        ? operation.delete(kvKey)
        : operation.set(kvKey, { at: recent, expiresAt }, { expireIn: this.#expireIn(expiresAt) }))
        .commit()
      if (result.ok) {
        return
      }
    }
    throw contention("releaseAttempt")
  }

  saveApprovalCode(key: string, record: ApprovalCodeRecord): Promise<void> {
    return this.#put(this.#key(APPROVAL, key), record)
  }

  takeApprovalCode(key: string): Promise<ApprovalCodeRecord | undefined> {
    return this.#take<ApprovalCodeRecord>(this.#key(APPROVAL, key), "takeApprovalCode")
  }

  /** Delete a record and return it, with a versionstamp check so only one caller gets it. */
  async #take<T>(kvKey: readonly string[], method: string): Promise<T | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await this.#kv.get(kvKey)
      if (entry.versionstamp === null) return undefined
      const result = await this.#kv.atomic()
        .check({ key: kvKey, versionstamp: entry.versionstamp })
        .delete(kvKey)
        .commit()
      if (result.ok) return entry.value as T
    }
    throw contention(method)
  }

  async #saveToken(
    kind: typeof ACCESS | typeof REFRESH,
    key: string,
    record: AccessTokenRecord | RefreshTokenRecord,
  ): Promise<boolean> {
    const revokedKey = this.#key("revoked", record.grantId)
    const expireIn = this.#expireIn(record.expiresAt)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const revoked = await this.#kv.get(revokedKey)
      if (typeof revoked.value === "number" && revoked.value > this.#clock.now()) return false
      const result = await this.#kv.atomic()
        .check({ key: revokedKey, versionstamp: revoked.versionstamp })
        .set(this.#key(kind, key), record, { expireIn })
        .set(this.#key("grant", record.grantId, kind, key), true, { expireIn })
        .commit()
      if (result.ok) return true
    }
    throw contention(kind === ACCESS ? "saveAccessToken" : "saveRefreshToken")
  }

  async #consume<T extends { usedAt?: number; expiresAt: number }>(
    kvKey: readonly string[],
    method: string,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await this.#kv.get(kvKey)
      if (entry.versionstamp === null) return undefined
      const record = entry.value as T
      if (record.usedAt !== undefined) return record
      const result = await this.#kv.atomic()
        .check({ key: kvKey, versionstamp: entry.versionstamp })
        .set(kvKey, { ...record, usedAt: this.#clock.now() }, {
          expireIn: this.#expireIn(record.expiresAt),
        })
        .commit()
      if (result.ok) return record
    }
    throw contention(method)
  }

  async #find<T>(kvKey: readonly string[]): Promise<T | undefined> {
    const entry = await this.#kv.get(kvKey)
    return entry.versionstamp === null ? undefined : entry.value as T
  }

  async #markRevoked(grantId: string, until: number): Promise<void> {
    const revokedKey = this.#key("revoked", grantId)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await this.#kv.get(revokedKey)
      if (typeof entry.value === "number" && entry.value >= until) return
      const result = await this.#kv.atomic()
        .check({ key: revokedKey, versionstamp: entry.versionstamp })
        .set(revokedKey, until, { expireIn: this.#expireIn(until) })
        .commit()
      if (result.ok) return
    }
    throw contention("revokeGrant")
  }

  #put(kvKey: readonly string[], record: { expiresAt: number }): Promise<void> {
    return this.#commit(
      this.#kv.atomic().set(kvKey, record, { expireIn: this.#expireIn(record.expiresAt) }),
    )
  }

  async #commit(operation: OAuthKvAtomic): Promise<void> {
    const result = await operation.commit()
    // Only a failed check refuses a commit, and these operations carry none.
    if (!result.ok) throw new Error("KvOAuthStore: Deno KV refused an unchecked write")
  }

  /** Milliseconds until `expiresAt`, at least 1: Deno KV throws on a negative `expireIn`. */
  #expireIn(expiresAt: number): number {
    return Math.max(1, Math.ceil(expiresAt - this.#clock.now()))
  }

  #key(...parts: string[]): readonly string[] {
    return [...this.#prefix, ...parts]
  }
}

/** The attempts stored under one key: none when the key is absent or malformed. */
function attempts(value: unknown): { at: number[]; expiresAt: number } {
  const stored = value as { at?: unknown; expiresAt?: unknown } | null
  const at = Array.isArray(stored?.at) ? stored.at.filter((time) => typeof time === "number") : []
  const expiresAt = typeof stored?.expiresAt === "number" ? stored.expiresAt : 0
  return { at, expiresAt }
}

function contention(method: string): OAuthStoreContentionError {
  return new OAuthStoreContentionError(
    `KvOAuthStore.${method}: gave up after ${MAX_ATTEMPTS} conflicting writes to the same key`,
  )
}
