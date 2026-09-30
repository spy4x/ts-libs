/**
 * `createRedisRateLimitStore` against a real Redis (Valkey speaks the same protocol). Every key
 * sits under a unique prefix and is deleted in a `finally`; nothing flushes the database.
 */
import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { RedisClient } from "@iuioiua/redis"
import { createStoreLimiter } from "@spy4x/platform/rate-limit"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore } from "./redis-kv-store.ts"
import { createRedisRateLimitStore } from "./redis-rate-limit-store.ts"

const T0 = 1_700_000_000_000

/** Opens `count` separate connections under one prefix, like `count` API instances. */
async function connectInstances(count: number, prefix: string): Promise<RedisKvStore[]> {
  const settings = redisSettings()
  const stores: RedisKvStore[] = []
  try {
    for (let i = 0; i < count; i++) {
      stores.push(await RedisKvStore.connect(settings.hostname, settings.port, prefix))
    }
  } catch (error) {
    for (const store of stores) store.close()
    throw error
  }
  return stores
}

async function closeAll(stores: RedisKvStore[]): Promise<void> {
  try {
    await stores[0]?.reset()
  } finally {
    for (const store of stores) store.close()
  }
}

describe("createRedisRateLimitStore against a real server", () => {
  it("accepts exactly the limit when four instances burst in lockstep, round after round", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(4, uniqueKeyPrefix("it_rl_atomic"))
    try {
      const limit = 10
      const limiters = stores.map((store) =>
        createStoreLimiter(createRedisRateLimitStore(store), {
          windowMs: 60_000,
          limit,
          clock: () => T0,
        })
      )
      for (let round = 0; round < 5; round++) {
        const key = `client:${round}`
        // 4 instances x 8 simultaneous requests = 32 attempts for 10 slots.
        const decisions = await Promise.all(
          limiters.flatMap((limiter) => Array.from({ length: 8 }, () => limiter.check(key))),
        )
        assertEquals(decisions.filter((d) => d.allowed).length, limit, `round ${round}`)
      }
    } finally {
      await closeAll(stores)
    }
  })

  it("lets the window slide with the injected clock and reports when room returns", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(2, uniqueKeyPrefix("it_rl_slide"))
    try {
      let now = T0
      const store = createRedisRateLimitStore(stores[0])
      const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock: () => now })

      assertEquals((await limiter.check(`k`)).allowed, true)
      now = T0 + 10_000
      const second = await limiter.check(`k`)
      assertEquals(second.allowed, true)
      const rejected = await limiter.check(`k`)
      assertEquals(rejected.allowed, false)
      assertEquals(rejected.allowed ? 0 : rejected.retryAfterMs, 50_000)

      now = T0 + 60_000 // the first event is exactly windowMs old and leaves the window
      const third = await limiter.check(`k`)
      assertEquals(third.allowed, true)
      assertEquals(await store.read(`k`), [T0 + 10_000, T0 + 60_000])

      // A second instance sees the same window.
      const other = createRedisRateLimitStore(stores[1])
      assertEquals(await other.read(`k`), [T0 + 10_000, T0 + 60_000])
    } finally {
      await closeAll(stores)
    }
  })

  it("counts two requests in the same millisecond as two events", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(1, uniqueKeyPrefix("it_rl_same_ms"))
    try {
      const store = createRedisRateLimitStore(stores[0])
      assertEquals((await store.consume!(`k`, T0, 1000, 3)).events, [T0])
      assertEquals((await store.consume!(`k`, T0, 1000, 3)).events, [T0, T0])
    } finally {
      await closeAll(stores)
    }
  })

  it("releases the event at the given time, or the newest one without a time", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(1, uniqueKeyPrefix("it_rl_release"))
    try {
      const store = createRedisRateLimitStore(stores[0])
      for (const at of [T0, T0 + 1, T0 + 2]) await store.consume!(`k`, at, 60_000, 5)
      await store.release!(`k`, T0 + 1)
      assertEquals(await store.read(`k`), [T0, T0 + 2])
      await store.release!(`k`)
      assertEquals(await store.read(`k`), [T0])
    } finally {
      await closeAll(stores)
    }
  })

  it("keeps a rejected request out of the window and leaves the key's expiry alone", async () => {
    await requireReachable(redisSettings().address)
    const settings = redisSettings()
    const prefix = uniqueKeyPrefix("it_rl_reject")
    const stores = await connectInstances(1, prefix)
    let raw: Deno.Conn | undefined
    try {
      raw = await Deno.connect({ hostname: settings.hostname, port: settings.port })
      const client = new RedisClient(raw)
      const store = createRedisRateLimitStore(stores[0])
      assertEquals((await store.consume!(`k`, T0, 60_000, 1)).allowed, true)
      const pttl = async () =>
        await client.sendCommand(["PTTL", `${prefix}:ratelimit-atomic:k`]) as number
      await new Promise((resolve) => setTimeout(resolve, 20)) // let real time pass on the TTL
      const before = await pttl()
      assertEquals(before > 0 && before <= 60_000, true)

      const rejected = await store.consume!(`k`, T0 + 1, 60_000, 1)
      assertEquals(rejected, { allowed: false, events: [T0] })
      assertEquals(await pttl() <= before, true)
    } finally {
      raw?.close()
      await closeAll(stores)
    }
  })

  it("supports read, write and delete for the limiter's refund path", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(1, uniqueKeyPrefix("it_rl_rwd"))
    try {
      const store = createRedisRateLimitStore(stores[0])
      assertEquals(await store.read(`k`), undefined)
      await store.write(`k`, [T0, T0, T0 + 5], T0 + 5, 60_000)
      assertEquals(await store.read(`k`), [T0, T0, T0 + 5])
      await store.write(`k`, [T0 + 5], T0 + 5, 60_000)
      assertEquals(await store.read(`k`), [T0 + 5])
      await store.delete(`k`)
      assertEquals(await store.read(`k`), undefined)

      const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 1, clock: () => T0 })
      const first = await limiter.check(`r`)
      assertEquals(first.allowed, true)
      assertEquals((await limiter.check(`r`)).allowed, false)
      await limiter.refund(`r`, first.allowed ? first.at : undefined)
      assertEquals((await limiter.check(`r`)).allowed, true)
    } finally {
      await closeAll(stores)
    }
  })

  it("keeps the window at or under the limit when refunds run alongside checks on four instances", async () => {
    await requireReachable(redisSettings().address)
    const stores = await connectInstances(4, uniqueKeyPrefix("it_rl_refund"))
    try {
      const limit = 3
      const limiters = stores.map((store) =>
        createStoreLimiter(createRedisRateLimitStore(store), { windowMs: 60_000, limit })
      )
      const reader = createRedisRateLimitStore(stores[0])
      for (let round = 0; round < 20; round++) {
        const key = `client:${round}`
        // One recorded request to refund; each racing check has its own timestamp.
        assertEquals((await limiters[0].check(key, T0)).allowed, true)
        // The refund is issued last so the other instances' checks are already in flight or
        // recorded when it runs; it must take out only the event at T0.
        const racing = [
          ...Array.from({ length: 8 }, (_, i) => limiters[i % 4].check(key, T0 + 1 + i)),
          limiters[1].refund(key, T0),
        ]
        const settled = await Promise.all(racing)
        const accepted = settled.slice(0, 8).filter((d) =>
          (d as { allowed: boolean }).allowed
        ).length
        const held = await reader.read(key)
        // Every accepted racing request is still recorded, the refunded one is gone, and the
        // window never holds more than the limit.
        assertEquals(held?.length, accepted, `round ${round}`)
        assertEquals((held?.length ?? 0) <= limit, true, `round ${round}`)
        assertEquals(held?.includes(T0), false, `round ${round}`)
      }
    } finally {
      await closeAll(stores)
    }
  })

  it("stretches the key's expiry to cover an event dated ahead of now", async () => {
    await requireReachable(redisSettings().address)
    const settings = redisSettings()
    const prefix = uniqueKeyPrefix("it_rl_future")
    const stores = await connectInstances(1, prefix)
    let raw: Deno.Conn | undefined
    try {
      raw = await Deno.connect({ hostname: settings.hostname, port: settings.port })
      const client = new RedisClient(raw)
      const store = createRedisRateLimitStore(stores[0])
      // This event is 30 s ahead of the next caller's clock; the key must outlive it by windowMs.
      await store.consume!(`k`, T0 + 30_000, 60_000, 5)
      await store.consume!(`k`, T0, 60_000, 5)
      const pttl = await client.sendCommand(["PTTL", `${prefix}:ratelimit-atomic:k`]) as number
      assertEquals(pttl > 60_000 && pttl <= 90_000, true, `pttl ${pttl}`)
    } finally {
      raw?.close()
      await closeAll(stores)
    }
  })
})
