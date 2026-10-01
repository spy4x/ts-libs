// The `RateLimitRedisStore` contract, written once and run against both implementations:
// `redis-store-fake.test.ts` runs it on the in-memory fake in the unit tier, and
// `redis-store-contract.integration.test.ts` runs it on a real `RedisKvStore` against Redis. The
// rate-limit adapter's tests run on the fake, so a case the fake gets wrong here is a case those
// tests get wrong too.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeRedisStoreContract`.

import { assertRejects, assertStrictEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { RateLimitRedisStore } from "./rate-limit-kv.ts"

/** A store, a way to read the expiry it gave a key, and how to dispose of it. */
export interface RedisStoreFixture {
  store: RateLimitRedisStore
  /** Seconds left on the key as the server reports them, or `null` for a key with no expiry. */
  ttlSec(key: string): Promise<number | null>
  /** Removes every key this fixture wrote and releases the connection. */
  close(): Promise<void>
}

/** Opens a fresh fixture for one case. */
export type OpenRedisStore = () => Promise<RedisStoreFixture>

async function withFixture(
  open: OpenRedisStore,
  body: (fixture: RedisStoreFixture) => Promise<void>,
): Promise<void> {
  const fixture = await open()
  try {
    await body(fixture)
  } finally {
    await fixture.close()
  }
}

/** Registers the contract suite for one implementation. */
export function describeRedisStoreContract(name: string, open: OpenRedisStore): void {
  describe(`${name} (redis store contract)`, () => {
    it("get answers null for a key nobody wrote", async () => {
      await withFixture(open, async ({ store }) => {
        assertStrictEquals(await store.get("missing"), null)
      })
    })

    it("a written value reads back, and a second write replaces it", async () => {
      await withFixture(open, async ({ store }) => {
        await store.set("k", "first", 60)
        assertStrictEquals(await store.get("k"), "first")
        await store.setWithoutExpiry("k", "second")
        assertStrictEquals(await store.get("k"), "second")
      })
    })

    it("an empty string and non-ASCII text read back unchanged", async () => {
      await withFixture(open, async ({ store }) => {
        await store.setWithoutExpiry("empty", "")
        await store.setWithoutExpiry("text", "żółć 日本語 ✓")
        assertStrictEquals(await store.get("empty"), "")
        assertStrictEquals(await store.get("text"), "żółć 日本語 ✓")
      })
    })

    it("set gives the key an expiry in whole seconds", async () => {
      await withFixture(open, async ({ store, ttlSec }) => {
        await store.set("k", "v", 3600)
        const left = await ttlSec("k")
        assertStrictEquals(left !== null && left > 3590 && left <= 3600, true)
      })
    })

    it("setWithoutExpiry gives the key no expiry", async () => {
      await withFixture(open, async ({ store, ttlSec }) => {
        await store.setWithoutExpiry("k", "v")
        assertStrictEquals(await ttlSec("k"), null)
      })
    })

    it("setWithoutExpiry drops the expiry an earlier set gave", async () => {
      await withFixture(open, async ({ store, ttlSec }) => {
        await store.set("k", "v", 3600)
        await store.setWithoutExpiry("k", "v2")
        assertStrictEquals(await ttlSec("k"), null)
      })
    })

    it("set puts an expiry on a key that had none", async () => {
      await withFixture(open, async ({ store, ttlSec }) => {
        await store.setWithoutExpiry("k", "v")
        await store.set("k", "v2", 3600)
        const left = await ttlSec("k")
        assertStrictEquals(left !== null && left > 3590, true)
      })
    })

    it("set refuses an expiry that is not a positive whole number of seconds", async () => {
      await withFixture(open, async ({ store }) => {
        for (const bad of [0, -1, 1.5, NaN, Infinity]) {
          await assertRejects(() => store.set("k", "v", bad), RangeError)
        }
        assertStrictEquals(await store.get("k"), null)
      })
    })

    it("del removes only its own key and is not an error for a missing one", async () => {
      await withFixture(open, async ({ store }) => {
        await store.setWithoutExpiry("a", "1")
        await store.setWithoutExpiry("b", "2")
        await store.del("a")
        await store.del("never-written")
        assertStrictEquals(await store.get("a"), null)
        assertStrictEquals(await store.get("b"), "2")
      })
    })
  })
}
