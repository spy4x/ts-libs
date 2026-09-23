/**
 * `RedisKvStore` against a real Redis.
 *
 * Every key this test writes is scoped under a unique prefix (`uniqueKeyPrefix`) and
 * `reset()` at the end deletes only that prefix's keys — never `FLUSHDB` or
 * `FLUSHALL`, since this Redis container is shared with every other worktree's run.
 */
import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore } from "./redis-kv-store.ts"

describe("RedisKvStore against a real server", () => {
  it("sets, gets, deletes and resets within its own prefix only", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv")
    const outsidePrefix = uniqueKeyPrefix("it_kv_outside")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    const sentinel = await RedisKvStore.connect(settings.hostname, settings.port, outsidePrefix)

    try {
      assertEquals(await store.get("missing"), null)

      await store.set("greeting", "hello from the integration tier", 60)
      assertEquals(await store.get("greeting"), "hello from the integration tier")

      // A key outside this store's prefix, written directly through a second store so
      // `reset()` below can be shown to leave it alone.
      await sentinel.set("bystander", "still here", 60)

      await store.del("greeting")
      assertEquals(await store.get("greeting"), null)

      await store.set("a", "1", 60)
      await store.set("b", "2", 60)
      await store.reset()
      assertEquals(await store.get("a"), null)
      assertEquals(await store.get("b"), null)

      // reset() only ever touched this store's own prefix.
      assertEquals(await sentinel.get("bystander"), "still here")
    } finally {
      await sentinel.reset()
      store.close()
      sentinel.close()
    }
  })

  it("rejects a ttlSec of zero or below rather than sending it to Redis", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_ttl")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)

    try {
      await assertRejects(() => store.set("key", "value", 0), RangeError)
      await assertRejects(() => store.set("key", "value", -1), RangeError)
      // Never reached Redis: nothing was written under this prefix.
      assertEquals(await store.get("key"), null)
    } finally {
      store.close()
    }
  })

  it("close() is safe to call more than once", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_close")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    store.close()
    store.close()
  })
})
