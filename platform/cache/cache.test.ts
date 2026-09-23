import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import {
  buildMethods,
  CacheService,
  type ICacheStorage,
  reviveIsoDatesEndingInAt,
} from "./cache.ts"

/**
 * Test-only fake. Not exported by the package: the template this suite was ported from kept its
 * equivalent (`MemoryCacheStorage`) local to the test file too, and `server/kv` is where a real,
 * published `ICacheStorage` (over Redis) belongs.
 */
class MemoryCacheStorage implements ICacheStorage {
  private values = new Map<string, string>()
  /** `set` calls this suite made, as `[key, ttlSec]`, so a test can assert on the TTL storage saw. */
  setCalls: Array<[string, number]> = []

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null)
  }

  set(key: string, value: string, ttlSec: number): Promise<void> {
    this.setCalls.push([key, ttlSec])
    this.values.set(key, value)
    return Promise.resolve()
  }

  del(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }

  reset(): Promise<void> {
    this.values.clear()
    return Promise.resolve()
  }
}

describe("CacheService", () => {
  it("returns null for a key that was never set", async () => {
    const cache = new CacheService(new MemoryCacheStorage())

    expect(await cache.get("missing")).toBeNull()
  })

  it("round-trips a value through get/set", async () => {
    const cache = new CacheService(new MemoryCacheStorage())

    await cache.set("greeting", { text: "hi" }, 60)

    expect(await cache.get("greeting")).toEqual({ text: "hi" })
  })

  it("deletes a key", async () => {
    const cache = new CacheService(new MemoryCacheStorage())
    await cache.set("greeting", "hi", 60)

    await cache.delete("greeting")

    expect(await cache.get("greeting")).toBeNull()
  })

  it("clears every key on reset", async () => {
    const cache = new CacheService(new MemoryCacheStorage())
    await cache.set("a", 1, 60)
    await cache.set("b", 2, 60)

    await cache.reset()

    expect(await cache.get("a")).toBeNull()
    expect(await cache.get("b")).toBeNull()
  })

  it("does not revive an ISO date string by default", async () => {
    const cache = new CacheService(new MemoryCacheStorage())

    await cache.set("session", { expiresAt: new Date(0).toISOString() }, 60)

    const session = await cache.get<{ expiresAt: string }>("session")
    expect(typeof session?.expiresAt).toBe("string")
  })

  it("revives dates ending in At when reviveIsoDatesEndingInAt is opted into", async () => {
    const cache = new CacheService(new MemoryCacheStorage(), {
      reviver: reviveIsoDatesEndingInAt,
    })
    const expiredAt = new Date(Date.now() - 1_000)

    await cache.set("session", {
      id: 1,
      expiresAt: expiredAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, 60)

    const session = await cache.get<{ expiresAt: Date }>("session")

    expect(session?.expiresAt).toBeInstanceOf(Date)
    expect(session && session.expiresAt < new Date()).toBe(true)
  })

  it("rounds a sub-second TTL up to one second before it reaches storage", async () => {
    const storage = new MemoryCacheStorage()
    const cache = new CacheService(storage)

    await cache.set("key", "value", 0.2)

    expect(storage.setCalls).toEqual([["key", 1]])
  })

  it("rejects a zero or negative TTL instead of forwarding it to storage", async () => {
    const cache = new CacheService(new MemoryCacheStorage())

    await expect(cache.set("key", "value", 0)).rejects.toThrow(RangeError)
    await expect(cache.set("key", "value", -5)).rejects.toThrow(RangeError)
  })

  describe("wrap", () => {
    it("calls fn on a miss and caches the result", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      let calls = 0

      const first = await cache.wrap("key", () => {
        calls += 1
        return Promise.resolve("computed")
      }, 60)
      const second = await cache.wrap("key", () => {
        calls += 1
        return Promise.resolve("computed-again")
      }, 60)

      expect(first).toBe("computed")
      expect(second).toBe("computed")
      expect(calls).toBe(1)
    })

    it("does not cache a falsy result by default", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      let calls = 0

      await cache.wrap("key", () => {
        calls += 1
        return Promise.resolve(0)
      }, 60)
      await cache.wrap("key", () => {
        calls += 1
        return Promise.resolve(0)
      }, 60)

      expect(calls).toBe(2)
    })

    it("caches a falsy result when shouldSaveFalsy is true", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      let calls = 0

      await cache.wrap(
        "key",
        () => {
          calls += 1
          return Promise.resolve(0)
        },
        60,
        { shouldSaveFalsy: true },
      )
      await cache.wrap(
        "key",
        () => {
          calls += 1
          return Promise.resolve(0)
        },
        60,
        { shouldSaveFalsy: true },
      )

      expect(calls).toBe(1)
    })

    it("treats an explicitly cached null as a hit, not a miss", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      await cache.set("key", null, 60)
      let calls = 0

      const result = await cache.wrap("key", () => {
        calls += 1
        return Promise.resolve("computed")
      }, 60)

      expect(result).toBeNull()
      expect(calls).toBe(0)
    })

    it("coalesces concurrent calls for the same key into one fn call", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      let calls = 0
      // Resolves after a microtask, regardless of which `wrap` call's `fn` invocation reaches it
      // first — avoiding a race against exactly when `wrap`'s internal `await` lands.
      const gate = new Promise<string>((resolve) => queueMicrotask(() => resolve("computed")))
      const fn = () => {
        calls += 1
        return gate
      }

      const [first, second] = await Promise.all([
        cache.wrap("key", fn, 60),
        cache.wrap("key", fn, 60),
      ])

      expect(first).toBe("computed")
      expect(second).toBe("computed")
      expect(calls).toBe(1)
    })

    it("rejects every waiting caller and caches nothing when fn rejects", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      const failing = () => Promise.reject(new Error("boom"))

      const first = cache.wrap("key", failing, 60)
      const second = cache.wrap("key", failing, 60)

      await expect(first).rejects.toThrow("boom")
      await expect(second).rejects.toThrow("boom")
      expect(await cache.get("key")).toBeNull()
    })

    it("retries fn on the next call after a rejection", async () => {
      const cache = new CacheService(new MemoryCacheStorage())
      let calls = 0
      const fn = () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error("boom"))
        return Promise.resolve("computed")
      }

      await expect(cache.wrap("key", fn, 60)).rejects.toThrow("boom")
      const result = await cache.wrap("key", fn, 60)

      expect(result).toBe("computed")
      expect(calls).toBe(2)
    })
  })
})

describe("buildMethods", () => {
  it("namespaces keys with the given prefix", async () => {
    const storage = new MemoryCacheStorage()
    const users = buildMethods<{ id: number }>(new CacheService(storage), "user", 60)

    expect(users.key(1)).toBe("user_1")
    await users.set(1, { id: 1 })
    expect(storage.setCalls[0][0]).toBe("user_1")
  })

  it("accepts a string id", async () => {
    const sessions = buildMethods<{ token: string }, string>(
      new CacheService(new MemoryCacheStorage()),
      "session",
      60,
    )

    await sessions.set("abc", { token: "abc" })

    expect(await sessions.get("abc")).toEqual({ token: "abc" })
  })

  it("deletes by id", async () => {
    const users = buildMethods<{ id: number }>(
      new CacheService(new MemoryCacheStorage()),
      "user",
      60,
    )
    await users.set(1, { id: 1 })

    await users.delete(1)

    expect(await users.get(1)).toBeNull()
  })

  it("validates a get/wrap hit against the schema and throws on mismatch", async () => {
    const storage = new MemoryCacheStorage()
    const cacheService = new CacheService(storage)
    const userSchema = type({ id: "number", name: "string" })
    const users = buildMethods<{ id: number; name: string }>(
      cacheService,
      "user",
      60,
      userSchema,
    )
    // Write a value the schema no longer accepts, bypassing buildMethods' own (schema-less) set.
    await cacheService.set("user_1", { id: 1 }, 60)

    let threw = false
    try {
      await users.get(1)
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
  })

  it("wrapMany caches under prefix_listPrefix without validating the array", async () => {
    const storage = new MemoryCacheStorage()
    const users = buildMethods<{ id: number }>(new CacheService(storage), "user", 60)

    const result = await users.wrapMany("all", () => Promise.resolve([{ id: 1 }, { id: 2 }]))

    expect(result).toEqual([{ id: 1 }, { id: 2 }])
    expect(storage.setCalls[0][0]).toBe("user_all")
  })
})
