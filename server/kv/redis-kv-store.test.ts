/**
 * The one behaviour of `RedisKvStore` that needs no network: `connect` validates its
 * `keyPrefix` argument before it ever calls `Deno.connect`. Everything else needs a
 * real Redis and lives in `redis-kv-store.integration.test.ts`.
 */
import { assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { RedisKvStore } from "./redis-kv-store.ts"

describe("RedisKvStore.connect", () => {
  it("refuses an empty keyPrefix without touching the network", async () => {
    // Port 0 is never a listening address; if this reached Deno.connect it would
    // reject with a connection error, not the TypeError this asserts.
    await assertRejects(() => RedisKvStore.connect("127.0.0.1", 0, ""), TypeError)
  })
})
