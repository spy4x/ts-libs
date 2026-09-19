/**
 * Shared-store limiter backend: the `RateLimitStore` port plus adapters.
 *
 * The limiter core in `memory.ts` never imports a backend. {@link createKvStore} implements the
 * port over a one-method {@link RateLimitKv} port, and {@link denoKvBackend} is the ~15-line
 * adapter that binds it to `Deno.Kv`. Deno KV, Redis and Postgres therefore all reach the limiter
 * through the same three operations (`read`, `write`, `delete`), and a Redis client is not a
 * dependency of the limiter — which is what adopting `rate-limit-redis` would have cost.
 *
 * Every entry is self-describing: `{ events, expiresAt }`. Deno KV has no TTL, so expiry is
 * enforced on read and the key is deleted when it is found stale; the optional backend TTL
 * (`expireIn`) shortens how long the debris survives. Values are timestamp arrays, never counter
 * sums, because only timestamps can answer "when does the window have room again" — see the
 * sliding-window reasoning in `memory.ts`.
 */

import { type Clock, type RateLimitStore, systemClock } from "./memory.ts"

/** One key's recorded window, with the moment it stops mattering. */
export interface RateLimitKvEntry {
  /** Accepted-request timestamps in milliseconds, oldest first. */
  events: number[]
  /** Epoch milliseconds after which the entry is stale and must be ignored. */
  expiresAt: number
}

/** Minimal key/value port. A real backend plus a fake in tests satisfy this and nothing more. */
export interface RateLimitKv {
  /** Read the entry at `key`, or `undefined` when absent. */
  get(key: string): Promise<unknown>
  /** Write `value` at `key`, optionally asking the backend to drop it after `expireIn`. */
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>
  /** Remove `key`. */
  delete(key: string): Promise<void>
}

/** Options for {@link createKvStore}. */
export interface KvStoreOptions {
  /** Backend to persist entries in. */
  backend: RateLimitKv
  /** Key namespace, so one backend can host several limiters. Defaults to `"ratelimit"`. */
  keyPrefix?: string
  /** Clock used for expiry decisions. Defaults to {@link systemClock}. */
  clock?: Clock
}

/** A stored entry is usable while it is an object with a numeric `expiresAt` and an `events` array. */
function isEntry(value: unknown): value is RateLimitKvEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { events?: unknown; expiresAt?: unknown }
  return Array.isArray(candidate.events) && typeof candidate.expiresAt === "number"
}

/**
 * Build a `RateLimitStore` over any {@link RateLimitKv}.
 *
 * Read-modify-write is not atomic: two isolates can read the same pre-write value, so the effective
 * limit under cross-instance concurrency is `limit + (concurrent isolates - 1)`. This is the
 * documented trade — a cross-instance lock per request would serialise the API on the limiter, and
 * a limiter that errs by one request is preferable to one that is down.
 */
export function createKvStore(options: KvStoreOptions): RateLimitStore {
  return new RateLimitStoreOverKv(options)
}

/** `RateLimitStore` implementation backed by a {@link RateLimitKv}. */
export class RateLimitStoreOverKv implements RateLimitStore {
  private readonly backend: RateLimitKv
  private readonly keyPrefix: string
  private readonly clock: Clock

  constructor(options: KvStoreOptions) {
    this.backend = options.backend
    this.keyPrefix = options.keyPrefix ?? "ratelimit"
    this.clock = options.clock ?? systemClock
  }

  /** Key as it is stored, exposed so tests and operators can inspect the namespace. */
  keyFor(key: string): string {
    return `${this.keyPrefix}:${key}`
  }

  async read(key: string, now: number = this.clock()): Promise<number[] | undefined> {
    const stored = await this.backend.get(this.keyFor(key))
    if (!isEntry(stored) || stored.expiresAt <= now) {
      // A stale entry is deleted rather than left to rot: Deno KV has no TTL, so read is the only
      // moment this package can notice.
      if (stored !== undefined) await this.backend.delete(this.keyFor(key))
      return undefined
    }
    // Events at or before the window cutoff are dropped by the limiter, which knows the window.
    return stored.events
  }

  async write(key: string, events: number[], now: number, ttlMs: number): Promise<void> {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 1
    const entry: RateLimitKvEntry = { events: [...events], expiresAt: now + ttl }
    await this.backend.set(this.keyFor(key), entry, { expireIn: ttl })
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.keyFor(key))
  }
}

/**
 * The three `Deno.Kv` operations this adapter needs.
 *
 * Spelled out rather than taken from `Deno.Kv`: those types live in `lib.deno.unstable.d.ts` and are
 * only loaded when the `unstable` compiler option is set, which this workspace does not set — a
 * module that referenced `Deno.Kv` would not type-check in CI at all. A real `Deno.Kv` satisfies
 * this interface structurally, so `denoKvBackend(await Deno.openKv())` type-checks for the caller
 * who does have the flag.
 */
export interface DenoKvLike {
  /** Read a key. `value` is null when it is absent. */
  get(key: readonly string[]): Promise<{ value: unknown }>
  /** Write a key, optionally expiring it after `expireIn` milliseconds. */
  set(key: readonly string[], value: unknown, options?: { expireIn?: number }): Promise<unknown>
  /** Remove a key. */
  delete(key: readonly string[]): Promise<void>
}

/**
 * Deno KV adapter.
 *
 * ~15 lines by construction: `get` returns `{ value }`, `set` takes `expireIn` in milliseconds, and
 * `delete` matches the port. Because it consumes that port rather than the `Deno` global, it is
 * covered against a fake handle under the repo's exact test grants, which are
 * `--no-prompt --allow-read --allow-env` — see `denoKvBackend`'s cases in `kv.test.ts`.
 *
 * `Deno.openKv()` itself is the one call in this package with no test: it needs `--unstable-kv`
 * plus a writable path, neither of which the root `test` task grants.
 *
 * @param kv Open handle. The caller owns its lifetime and must `close()` it.
 * @param namespace First key segment, so two apps can share one KV database.
 */
export function denoKvBackend(kv: DenoKvLike, namespace = "rate-limit"): RateLimitKv {
  const key = (id: string): string[] => [namespace, id]
  return {
    async get(id: string): Promise<unknown> {
      const result = await kv.get(key(id))
      return result.value ?? undefined
    },
    async set(id: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      const expireIn = options?.expireIn
      await kv.set(key(id), value, expireIn === undefined ? {} : { expireIn })
    },
    async delete(id: string): Promise<void> {
      await kv.delete(key(id))
    },
  }
}
