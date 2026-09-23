/**
 * The Redis helper of the integration tier (#75): proves `redisSettings` points at a
 * reachable container, and that a key written under a unique prefix reads back and is
 * gone after cleanup.
 *
 * `uniqueKeyPrefix` (from `isolation.ts`) already fits Redis keys — it produces a
 * `<prefix>/<suffix>` string, and Redis treats a key as an opaque byte string, so no
 * separate Redis-only unique-name helper is needed here.
 */

import { assertEquals, assertNotEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { RedisClient } from "@iuioiua/redis"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"

describe("redis", () => {
  it("writes a key under a unique prefix and reads it back, then deletes it", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const key = `${uniqueKeyPrefix("it_redis")}/greeting`
    const connection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
    const client = new RedisClient(connection)

    try {
      await client.sendCommand(["SET", key, "hello from the integration tier"])
      assertEquals(await client.sendCommand(["GET", key]), "hello from the integration tier")
    } finally {
      // Delete only this test's own key. Never FLUSHDB or FLUSHALL: several
      // worktrees share this Redis container at the same time.
      await client.sendCommand(["DEL", key])
      connection.close()
    }
  })

  it("never returns the same key prefix twice", () => {
    assertNotEquals(uniqueKeyPrefix("it_redis"), uniqueKeyPrefix("it_redis"))
  })
})
