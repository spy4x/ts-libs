import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createKvStore } from "@spy4x/platform/rate-limit/kv"
import { redisRateLimitKv } from "./rate-limit-kv.ts"
import { createFakeRedisStore as fakeStore } from "./fake-redis-store.test.ts"

describe("redisRateLimitKv", () => {
  it("round-trips a JSON value and reports a missing key as undefined", async () => {
    const store = fakeStore()
    const kv = redisRateLimitKv(store)
    assertEquals(await kv.get("k"), undefined)
    await kv.set("k", { events: [1, 2], expiresAt: 9 })
    assertEquals(await kv.get("k"), { events: [1, 2], expiresAt: 9 })
    await kv.delete("k")
    assertEquals(await kv.get("k"), undefined)
  })

  it("rounds an expireIn in milliseconds up to whole seconds, never to 0", async () => {
    const store = fakeStore()
    const kv = redisRateLimitKv(store)
    await kv.set("a", 1, { expireIn: 1 })
    await kv.set("b", 1, { expireIn: 1000 })
    await kv.set("c", 1, { expireIn: 1001 })
    assertEquals(store.data.get("a")?.ttlSec, 1)
    assertEquals(store.data.get("b")?.ttlSec, 1)
    assertEquals(store.data.get("c")?.ttlSec, 2)
  })

  it("stores a key without expiry when expireIn is absent", async () => {
    const store = fakeStore()
    await redisRateLimitKv(store).set("k", 1)
    assertEquals(store.data.get("k")?.ttlSec, null)
  })

  it("rejects an expireIn that is not a positive finite number", async () => {
    const kv = redisRateLimitKv(fakeStore())
    for (const expireIn of [0, -5, NaN, Infinity]) {
      await assertRejects(() => kv.set("k", 1, { expireIn }), RangeError)
    }
  })

  it("fails loudly on a value JSON cannot represent", async () => {
    const store = fakeStore()
    const kv = redisRateLimitKv(store)
    await assertRejects(() => kv.set("u", undefined), TypeError, "not JSON-serialisable")
    await assertRejects(() => kv.set("f", () => 1), TypeError)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    await assertRejects(() => kv.set("c", cycle), TypeError)
    await assertRejects(() => kv.set("b", 1n), TypeError)
    assertEquals(store.data.size, 0)
  })

  it("treats a stored value that is not JSON as absent instead of throwing", async () => {
    const store = fakeStore()
    store.data.set("foreign", { value: "not json {", ttlSec: null })
    assertEquals(await redisRateLimitKv(store).get("foreign"), undefined)
  })

  it("lets the platform limiter store use it and expire entries through the ttl", async () => {
    const store = fakeStore()
    const limiter = createKvStore({ backend: redisRateLimitKv(store), keyPrefix: "rl" })
    await limiter.write("ip", [100], 100, 60_500)
    assertEquals(await limiter.read("ip", 200), [100])
    assertEquals(store.data.get("rl:ip")?.ttlSec, 61)
  })
})
