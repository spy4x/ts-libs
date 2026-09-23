import { assertEquals } from "@std/assert"
import type { ICacheStorage } from "@ts-libs/platform/cache"
import type { RedisKvStore } from "./mod.ts"

// `server/kv` and `platform/cache` were extracted side by side in wave 6 (#75), so the store could
// not import the interface it is meant to satisfy. This assignment is the check: `deno task
// ts:check` fails if `RedisKvStore` ever stops being usable as the cache's storage.
const asCacheStorage = (store: RedisKvStore): ICacheStorage => store

Deno.test("RedisKvStore can be handed to the cache as its ICacheStorage", () => {
  assertEquals(typeof asCacheStorage, "function")
})
