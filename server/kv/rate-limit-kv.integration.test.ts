/**
 * `redisRateLimitKv` against a real Redis (Valkey speaks the same protocol). Every key sits
 * under a unique prefix and is deleted in a `finally`; nothing flushes the database.
 */
import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { RedisClient } from "@iuioiua/redis"
import { createKvStore } from "@spy4x/platform/rate-limit/kv"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore } from "./redis-kv-store.ts"
import { redisRateLimitKv } from "./rate-limit-kv.ts"

describe("redisRateLimitKv against a real server", () => {
  it("shares one limiter window between two connections and expires it in Redis", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)
    const prefix = uniqueKeyPrefix("it_rl")
    const a = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    let b: RedisKvStore | undefined
    let raw: Deno.Conn | undefined
    try {
      b = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
      raw = await Deno.connect({ hostname: settings.hostname, port: settings.port })
      const first = createKvStore({ backend: redisRateLimitKv(a), keyPrefix: `rl` })
      const second = createKvStore({ backend: redisRateLimitKv(b), keyPrefix: `rl` })
      await first.write(`client`, [1000, 2000], 2000, 30_500)
      assertEquals(await second.read(`client`, 2500), [1000, 2000])

      // 30.5 s rounds up to 31 s; read the real TTL the server holds.
      const client = new RedisClient(raw)
      const ttl = await client.sendCommand(["TTL", `${prefix}:rl:client`])
      assertEquals(ttl, 31)

      await second.delete(`client`)
      assertEquals(await first.read(`client`, 2500), undefined)

      // A key without expireIn has no TTL, and a foreign non-JSON key reads as absent.
      const kv = redisRateLimitKv(a)
      await a.set(`forever`, `{"ok":true}`, 3600)
      assertEquals(await client.sendCommand(["TTL", `${prefix}:forever`]), 3600)
      await kv.set(`forever`, { ok: true }) // replaces the earlier value and drops its expiry
      assertEquals(await client.sendCommand(["TTL", `${prefix}:forever`]), -1)
      await a.setWithoutExpiry(`foreign`, `not json {`)
      assertEquals(await kv.get(`foreign`), undefined)
    } finally {
      try {
        await a.reset()
      } finally {
        raw?.close()
        await a.close()
        await b?.close()
      }
    }
  })
})
