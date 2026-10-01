// A real `RedisKvStore` held to the `RateLimitRedisStore` contract the unit tier runs on the
// in-memory store (`redis-store-fake.test.ts`). Every key sits under a unique prefix and is removed
// by the store's own scoped `reset`; nothing flushes the database.

import { RedisClient } from "@iuioiua/redis"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { describeRedisStoreContract } from "./redis-store-contract.test.ts"
import { RedisKvStore } from "./redis-kv-store.ts"

describeRedisStoreContract("RedisKvStore", async () => {
  const settings = redisSettings()
  await requireReachable(settings.address)
  const prefix = uniqueKeyPrefix("it_store")
  const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
  let raw: Deno.Conn | undefined
  try {
    raw = await Deno.connect({ hostname: settings.hostname, port: settings.port })
  } catch (error) {
    await store.close()
    throw error
  }
  const client = new RedisClient(raw)
  return {
    store,
    ttlSec: async (key) => {
      const ttl = await client.sendCommand(["TTL", `${prefix}:${key}`]) as number
      return ttl === -1 ? null : ttl
    },
    close: async () => {
      try {
        await store.reset()
      } finally {
        raw?.close()
        await store.close()
      }
    },
  }
})
