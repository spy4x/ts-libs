import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  createKvStore,
  type RateLimitKv,
  type RateLimitKvEntry,
  RateLimitStoreOverKv,
} from "./kv.ts"
import { createStoreLimiter } from "./memory.ts"

/** Fixed start instant. Nothing here reads `Date.now()`. */
const T0 = 1_700_000_000_000

/** Manual clock. */
function fakeClock(start = T0): { clock: () => number; advance: (ms: number) => void } {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/**
 * Stand-in for `Deno.Kv`.
 *
 * Deno KV is the one backend this package cannot exercise in CI: the root `test` task grants
 * `--allow-read --allow-env` and nothing else, so `Deno.openKv()` — which wants `--unstable-kv`
 * plus a writable path — cannot be called from a test. The fake implements exactly the port the
 * adapter implements, records the TTL it was handed, and can be made to drop values the way a real
 * backend's expiry would.
 */
function fakeKv(): RateLimitKv & {
  entries: Map<string, { value: unknown; expireIn?: number }>
  expireAll(): void
} {
  const entries = new Map<string, { value: unknown; expireIn?: number }>()
  return {
    entries,
    expireAll: () => entries.clear(),
    get: (key: string) => Promise.resolve(entries.get(key)?.value),
    set: (key: string, value: unknown, options?: { expireIn?: number }) => {
      entries.set(key, { value, expireIn: options?.expireIn })
      return Promise.resolve()
    },
    delete: (key: string) => {
      entries.delete(key)
      return Promise.resolve()
    },
  }
}

/** The stored entry for `key`, or `undefined`. */
function entryOf(kv: ReturnType<typeof fakeKv>, key: string): RateLimitKvEntry | undefined {
  return kv.entries.get(key)?.value as RateLimitKvEntry | undefined
}

describe("createKvStore", () => {
  it("namespaces keys so two limiters can share a backend", async () => {
    const kv = fakeKv()
    const store = new RateLimitStoreOverKv({ backend: kv, keyPrefix: "ratelimit" })

    await store.write("ip:203.0.113.9", [T0], T0, 1000)
    assertEquals([...kv.entries.keys()], ["ratelimit:ip:203.0.113.9"])
    assertEquals(store.keyFor("ip:203.0.113.9"), "ratelimit:ip:203.0.113.9")
  })

  it("round-trips recorded timestamps", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0, T0 + 100], T0 + 100, 5000)
    assertEquals(await store.read("a", T0 + 200), [T0, T0 + 100])
  })

  it("returns undefined for a key that was never written", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    assertEquals(await store.read("absent", T0), undefined)
  })

  it("treats an entry past its expiry as absent and deletes it", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 1000)
    assertEquals(await store.read("a", T0 + 999), [T0])
    assertEquals(await store.read("a", T0 + 1000), undefined)
    assertEquals(kv.entries.has("ratelimit:a"), false)
  })

  it("hands the backend a TTL covering the window", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 60_000)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 60_000)
  })

  it("never asks the backend for a zero or negative TTL", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 0)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 1)
    await store.write("a", [T0], T0, Number.NaN)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 1)
  })

  it("ignores a value that is not an entry", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await kv.set("ratelimit:a", 42)
    assertEquals(await store.read("a", T0), undefined)
  })

  it("deletes a key", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 1000)
    await store.delete("a")
    assertEquals(kv.entries.size, 0)
  })

  it("stores everything below one namespace prefix", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv, keyPrefix: "auth" })

    await store.write("user:42", [T0], T0, 1000)
    assertEquals([...kv.entries.keys()], ["auth:user:42"])
    assertEquals(entryOf(kv, "auth:user:42")?.events, [T0])
  })
})

describe("StoreRateLimiter over the KV store", () => {
  it("enforces the limit across instances sharing one backend", async () => {
    const kv = fakeKv()
    const { clock } = fakeClock()
    const store = createKvStore({ backend: kv, clock })
    const first = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock })
    const second = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock })

    assertEquals((await first.check("user:42")).allowed, true)
    assertEquals((await second.check("user:42")).allowed, true)
    assertEquals((await first.check("user:42")).allowed, false)
    assertEquals((await second.check("user:42")).allowed, false)
  })

  it("lets a key through again once the stored entry has expired", async () => {
    const kv = fakeKv()
    const { clock, advance } = fakeClock()
    const store = createKvStore({ backend: kv, clock })
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 1, clock })

    assertEquals((await limiter.check("a")).allowed, true)
    assertEquals((await limiter.check("a")).allowed, false)

    advance(2000)
    kv.expireAll()
    assertEquals((await limiter.check("a")).allowed, true)
  })
})
