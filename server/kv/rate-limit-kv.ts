/**
 * Adapter that lets the platform rate limiter keep its windows in Redis, so several API
 * instances share one limit.
 *
 * Redis and Valkey speak the same protocol; {@link RedisKvStore} works against either.
 *
 * @module
 */
import type { RateLimitKv } from "@spy4x/platform/rate-limit/kv"

/** The part of {@link RedisKvStore} the adapter needs. A fake satisfies it in tests. */
export interface RateLimitRedisStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  setWithoutExpiry(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
}

/**
 * Turn a Redis store into the `RateLimitKv` port that `createKvStore` from
 * `@spy4x/platform/rate-limit/kv` takes.
 *
 * - Values are stored as JSON.
 * - `expireIn` is in milliseconds and Redis counts seconds, so it is rounded up: a 1 ms
 *   expiry becomes 1 second, never 0 (which Redis refuses). Without `expireIn` the key
 *   never expires. A non-positive or non-finite `expireIn` throws `RangeError`.
 * - A value JSON cannot represent (`undefined`, a function, a cycle, a `BigInt`) throws
 *   `TypeError` from `set` instead of storing `null` or nothing.
 * - `get` returns `undefined` for a key that is absent and also for a key whose content is
 *   not valid JSON, for example one another application wrote under the same name. The
 *   limiter treats that as "no history" and overwrites it on the next request; throwing
 *   would turn one foreign key into an error on every request for that client.
 *
 * Not atomic across instances: the platform store reads a window, adds an event and writes
 * it back with plain `GET` and `SET`. When two instances read the same window at once, both
 * accept the request and the later write overwrites the earlier one, so an accepted request
 * can be missing from the record. That repeats for as long as requests overlap: for a client
 * whose requests reach every instance in lockstep bursts, the effective limit approaches
 * `limit x instances`. The limit is shared but not exact; an exact one needs an atomic store
 * (tracked in https://github.com/spy4x/ts-libs/issues/303).
 *
 * @param store An open `RedisKvStore` (the caller keeps ownership and closes it).
 */
export function redisRateLimitKv(store: RateLimitRedisStore): RateLimitKv {
  return {
    async get(key: string): Promise<unknown> {
      const raw = await store.get(key)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void> {
      const json = JSON.stringify(value) as string | undefined
      if (json === undefined) {
        throw new TypeError(`rate-limit value for "${key}" is not JSON-serialisable`)
      }
      const expireIn = options?.expireIn
      if (expireIn === undefined) {
        await store.setWithoutExpiry(key, json)
        return
      }
      if (!Number.isFinite(expireIn) || expireIn <= 0) {
        throw new RangeError(`expireIn must be a positive number of milliseconds, got ${expireIn}`)
      }
      await store.set(key, json, Math.ceil(expireIn / 1000))
    },
    async delete(key: string): Promise<void> {
      await store.del(key)
    },
  }
}
