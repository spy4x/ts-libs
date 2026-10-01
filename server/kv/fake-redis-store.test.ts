// In-memory `RateLimitRedisStore` for the unit tier. Not a test file in itself: it is named
// `*.test.ts` only so the root `publish.exclude` pattern keeps it out of the published package, and
// it registers no tests. `redis-store-fake.test.ts` holds it to the same contract the integration
// tier runs on a real `RedisKvStore`.

import type { RateLimitRedisStore } from "./rate-limit-kv.ts"

/** A fake store and the rows behind it. */
export interface FakeRedisStore extends RateLimitRedisStore {
  /** The stored rows by key. `ttlSec` is `null` for a key that never expires. */
  data: Map<string, { value: string; ttlSec: number | null }>
}

/**
 * A store that keeps values and the expiry each was given, but never lets a key expire: no test
 * waits for a clock. It refuses a `ttlSec` that is not a positive integer, as `RedisKvStore` does.
 */
export function createFakeRedisStore(): FakeRedisStore {
  const data = new Map<string, { value: string; ttlSec: number | null }>()
  return {
    data,
    get: (key) => Promise.resolve(data.get(key)?.value ?? null),
    set: (key, value, ttlSec) => {
      if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
        return Promise.reject(new RangeError(`ttlSec must be a positive integer, got ${ttlSec}`))
      }
      data.set(key, { value, ttlSec })
      return Promise.resolve()
    },
    setWithoutExpiry: (key, value) => {
      data.set(key, { value, ttlSec: null })
      return Promise.resolve()
    },
    del: (key) => {
      data.delete(key)
      return Promise.resolve()
    },
  }
}
