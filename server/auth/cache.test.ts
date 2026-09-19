/**
 * Security fix 5: the cache multiplied a millisecond TTL by 1000 and discarded
 * cached falsy values.
 *
 * `roley/src/lib/server/cache.ts` read its TTL option in seconds, wrote `ttl * 1000`
 * into a store whose own default came from `ONE_WEEK_AS_MS` (`:23`, `:36`), and
 * read with `if (fromCache)` (`:38`). Two consequences:
 *
 *  - a "one week" entry lived about 19 years, so a revoked session, a changed
 *    permission or a stale user row stayed cached for the life of the process;
 *  - a cached `0`, `false`, `""` or `null` was treated as a miss, so the wrapped
 *    function re-ran on every call — the cache silently did not cache the values a
 *    permission check is most likely to produce, and the *result* was still wrong
 *    in the other direction: a deliberately cached "no" was recomputed as often as
 *    it was asked.
 *
 * The assertions here are about units and about the miss marker:
 *
 *  - the store receives exactly the millisecond value it was asked for, so a
 *    reintroduced `* 1000` fails;
 *  - every falsy value is returned from the cache on the second call, so a
 *    reintroduced truthiness check fails;
 *  - expiry is decided by the injected clock, so the TTL is honoured in real terms.
 */

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert"
import {
  CacheAccess,
  cacheItems,
  type CacheStore,
  type CacheValue,
  createTenantCache,
  DEFAULT_TTL_MS,
  MemoryCacheStore,
  TenantCache,
} from "./cache.ts"
import type { Clock } from "./cache.ts"

/** Records every `set`, so a test can assert the unit the store was handed. */
class RecordingStore implements CacheStore {
  readonly writes: Array<{ key: string; value: CacheValue; ttlMs: number }> = []
  private readonly inner: MemoryCacheStore

  constructor(clock?: Clock) {
    this.inner = new MemoryCacheStore(clock)
  }

  get(key: string): Promise<CacheValue | undefined> {
    return this.inner.get(key)
  }

  set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    this.writes.push({ key, value, ttlMs })
    return this.inner.set(key, value, ttlMs)
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }
}

/** A clock a test moves by hand. */
function manualClock(start = 1_000_000): { now: Clock; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

Deno.test("returns a cached falsy value instead of recomputing it", async () => {
  // Each of these is `falsy`, and each must still be a hit on the second call.
  const falsyValues: CacheValue[] = [0, false, "", null]
  for (const value of falsyValues) {
    const store = new RecordingStore()
    const cache = new TenantCache(store)
    let calls = 0
    const compute = (): Promise<CacheValue> => {
      calls++
      return Promise.resolve(value)
    }
    assertEquals(await cache.wrap("key", compute), value)
    assertEquals(await cache.wrap("key", compute), value)
    assertEquals(await cache.wrap("key", compute), value)
    assertEquals(calls, 1, `${JSON.stringify(value)} must be served from the cache`)
  }
})

Deno.test("distinguishes a cached falsy value from a miss", async () => {
  const cache = new TenantCache(new MemoryCacheStore())
  await cache.set("false", false)
  await cache.set("zero", 0)
  await cache.set("empty", "")
  await cache.set("null", null)
  assertEquals(await cache.get("false"), false)
  assertEquals(await cache.get("zero"), 0)
  assertEquals(await cache.get("empty"), "")
  assertEquals(await cache.get("null"), null)
  // A key that was never written is `undefined`, which is the only miss marker.
  assertEquals(await cache.get("absent"), undefined)
})

Deno.test("never stores undefined, so a miss stays a miss", async () => {
  const store = new RecordingStore()
  const cache = new TenantCache(store)
  let calls = 0
  const result = await cache.wrap("key", () => {
    calls++
    return Promise.resolve(undefined)
  })
  assertEquals(result, undefined)
  assertEquals(store.writes.length, 0, "undefined must not be written")
  await cache.wrap("key", () => {
    calls++
    return Promise.resolve(undefined)
  })
  assertEquals(calls, 2)
})

Deno.test("passes the TTL to the store in milliseconds, unscaled", async () => {
  const store = new RecordingStore()
  const cache = new TenantCache(store)

  await cache.set("explicit", "value", 60_000)
  assertEquals(store.writes[0].ttlMs, 60_000, "a millisecond TTL must reach the store unchanged")

  await cache.set("default", "value")
  assertEquals(store.writes[1].ttlMs, DEFAULT_TTL_MS)

  await cache.wrap("wrapped", () => Promise.resolve("value"), { ttlMs: 1_234 })
  assertEquals(store.writes[2].ttlMs, 1_234)

  // The bug's signature: with `ttl * 1000` restored, the store would see 60_000_000
  // and 5_000 * 1000, so assert the values are exactly what the caller asked for.
  assertFalse(store.writes.some((write) => write.ttlMs > 10 * 60 * 1000))
})

Deno.test("a configured TTL is honoured on the injected clock", async () => {
  const clock = manualClock()
  const cache = new TenantCache(new MemoryCacheStore(clock.now), 60_000)

  await cache.set("key", "value", 60_000)
  clock.advance(59_999)
  assertEquals(await cache.get("key"), "value")
  clock.advance(1)
  assertEquals(await cache.get("key"), undefined, "an entry must expire at its deadline, not later")
})

Deno.test("one week expires in a week, not in nineteen years", async () => {
  const clock = manualClock()
  const store = new MemoryCacheStore(clock.now)
  const cache = new TenantCache(store)
  await cache.set(cacheItems.user.key(1), "user-row", cacheItems.user.ttlMs)

  const oneWeekMs = 7 * 24 * 60 * 60 * 1000
  assertEquals(cacheItems.user.ttlMs, oneWeekMs)
  clock.advance(oneWeekMs - 1)
  assertEquals(await cache.get(cacheItems.user.key(1)), "user-row")
  clock.advance(1)
  assertEquals(await cache.get(cacheItems.user.key(1)), undefined)
})

Deno.test("recomputes after the entry expires", async () => {
  const clock = manualClock()
  const cache = new TenantCache(new MemoryCacheStore(clock.now))
  let calls = 0
  const compute = (): Promise<number> => {
    calls++
    return Promise.resolve(calls)
  }
  assertEquals(await cache.wrap("key", compute, { ttlMs: 1_000 }), 1)
  assertEquals(await cache.wrap("key", compute, { ttlMs: 1_000 }), 1)
  clock.advance(1_000)
  assertEquals(await cache.wrap("key", compute, { ttlMs: 1_000 }), 2)
})

Deno.test("shouldCacheFalsy false leaves a falsy result uncached", async () => {
  const store = new RecordingStore()
  const cache = new TenantCache(store)
  let calls = 0
  const compute = (): Promise<null> => {
    calls++
    return Promise.resolve(null)
  }
  await cache.wrap("key", compute, { shouldCacheFalsy: false })
  await cache.wrap("key", compute, { shouldCacheFalsy: false })
  assertEquals(calls, 2)
  assertEquals(store.writes.length, 0)
})

Deno.test("wrap returns a cached false without consulting the compute function", async () => {
  const cache = new TenantCache(new MemoryCacheStore())
  await cache.set("permission", false)
  let consulted = false
  const result = await cache.wrap("permission", () => {
    consulted = true
    return Promise.resolve(true)
  })
  assertEquals(result, false)
  assertFalse(consulted, "a cached value must short-circuit the compute function")
})

Deno.test("the memory store rejects a non-positive or non-finite TTL", async () => {
  const store = new MemoryCacheStore()
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assertThrows(
      () => store.set("key", "value", ttlMs),
      RangeError,
      undefined,
      `ttlMs ${ttlMs} must be rejected`,
    )
  }
})

Deno.test("cacheItems declares a millisecond TTL for every registered key", () => {
  for (const [name, item] of Object.entries(cacheItems)) {
    assert(typeof item.ttlMs === "number" && item.ttlMs > 0, `${name} needs a TTL`)
    assert(item.ttlMs < 365 * 24 * 60 * 60 * 1000, `${name} must not claim a multi-year TTL`)
    assert(
      item.permission === CacheAccess.Private || item.permission === CacheAccess.Public,
      `${name} needs a visibility`,
    )
  }
  assertEquals(cacheItems.session.key("7:token"), "session:7:token")
  assertEquals(cacheItems.user.permission, CacheAccess.Private)
})

Deno.test("delete removes an entry", async () => {
  const cache = new TenantCache(new MemoryCacheStore())
  await cache.set("key", "value")
  await cache.delete("key")
  assertEquals(await cache.get("key"), undefined)
})

Deno.test("createTenantCache builds a working cache on an injected clock", async () => {
  const clock = manualClock()
  const cache = createTenantCache({ clock: clock.now, defaultTtlMs: 500 })
  await cache.set("key", false)
  assertEquals(await cache.get("key"), false)
  clock.advance(500)
  assertEquals(await cache.get("key"), undefined)
})

Deno.test("the store receives milliseconds even when the caller passes a huge value", async () => {
  // The unit contract in one assertion: whatever number a caller passes is the
  // number the store gets. `ttl * 1000` would make this 86_400_000_000.
  const store = new RecordingStore()
  const cache = new TenantCache(store)
  await cache.set("key", "value", 86_400_000)
  assertEquals(store.writes[0].ttlMs, 86_400_000)
})
