/**
 * The Redis helper of the integration tier (#75): proves `redisSettings` points at a
 * reachable container, and that a key written under a unique prefix reads back and is
 * actually gone after cleanup.
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
  it("writes a key under a unique prefix, reads it back, and deletes it", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const key = `${uniqueKeyPrefix("it_redis")}/greeting`
    const connection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
    const client = new RedisClient(connection)

    try {
      await client.sendCommand(["SET", key, "hello from the integration tier"])
      assertEquals(await client.sendCommand(["GET", key]), "hello from the integration tier")

      // Prove the deletion, not just perform it: DEL reports how many keys it
      // removed, and EXISTS confirms the key is actually gone afterwards.
      assertEquals(await client.sendCommand(["DEL", key]), 1)
      assertEquals(await client.sendCommand(["EXISTS", key]), 0)
    } finally {
      try {
        // Safety net: deletes only this test's own key, and does nothing once
        // the key is already gone. Never FLUSHDB or FLUSHALL — several
        // worktrees share this Redis container at the same time.
        await client.sendCommand(["DEL", key])
      } finally {
        connection.close()
      }
    }
  })
})

// Needs no container: `uniqueKeyPrefix` is the isolation helper itself, not a call
// against Redis. Kept beside the Redis test it backs, not inside the "redis" describe,
// so a reader does not mistake it for something that exercises the container.
it("uniqueKeyPrefix returns a different prefix on every call (no container needed)", () => {
  assertNotEquals(uniqueKeyPrefix("it_redis"), uniqueKeyPrefix("it_redis"))
})
