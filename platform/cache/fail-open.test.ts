import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import type { ICacheStorage } from "./cache.ts"
import { CacheService } from "./cache.ts"
import { failOpen } from "./fail-open.ts"

class MemoryCacheStorage implements ICacheStorage {
  protected values = new Map<string, string>()

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null)
  }
  set(key: string, value: string): Promise<void> {
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

/** A storage that keeps its data across an outage, like a server restarted from a snapshot. */
class FlakyCacheStorage extends MemoryCacheStorage {
  down = false
  /** Only `set` fails, like a write that times out while reads still work. */
  failSet = false
  calls = 0

  override get(key: string): Promise<string | null> {
    return this.guard(() => super.get(key))
  }
  override set(key: string, value: string): Promise<void> {
    if (this.failSet) return Promise.reject(new Error("write timed out"))
    return this.guard(() => super.set(key, value))
  }
  override del(key: string): Promise<void> {
    return this.guard(() => super.del(key))
  }
  override reset(): Promise<void> {
    return this.guard(() => super.reset())
  }

  private guard<T>(run: () => Promise<T>): Promise<T> {
    this.calls++
    return this.down ? Promise.reject(new Error("cache down")) : run()
  }
}

function fixture() {
  const storage = new FlakyCacheStorage()
  const reports: string[] = []
  let time = 0
  const cache = failOpen(storage, (operation) => reports.push(operation), 5_000, () => time)
  return { storage, reports, cache, advance: (ms: number) => (time += ms) }
}

describe("failOpen", () => {
  it("treats a failing read as a miss so the caller computes and returns the value", async () => {
    const storage = new FlakyCacheStorage()
    storage.down = true
    const service = new CacheService(failOpen(storage, () => {}))
    let computed = 0

    const value = await service.wrap("user_1", () => Promise.resolve({ id: computed++ }), 60)

    expect(value).toEqual({ id: 0 })
    expect(computed).toBe(1)
    expect(await service.get("user_1")).toBeNull()
  })

  it("reports a failing read or write instead of throwing", async () => {
    const { storage, reports, cache } = fixture()
    await cache.get("warm-up") // a first successful operation clears the cache and trusts it
    storage.down = true

    expect(await cache.get("user_1")).toBeNull()
    await cache.set("user_1", "{}", 60)

    expect(reports).toEqual(["get"])
  })

  it("reports a failing delete instead of throwing", async () => {
    const { storage, reports, cache } = fixture()
    await cache.get("warm-up")
    storage.down = true

    await cache.del("user_1")

    expect(reports).toEqual(["del"])
  })

  it("does not serve a row cached before an outage when its delete was skipped", async () => {
    const { storage, cache, advance } = fixture()
    await cache.get("warm-up")
    await cache.set("user_1", `{"mfa":false}`, 60)
    storage.down = true
    await cache.del("user_1")
    storage.down = false

    expect(await cache.get("user_1")).toBeNull()
    advance(5_000)
    expect(await cache.get("user_1")).toBeNull()
  })

  it("marks the cache untrusted after a failed write so the old row is not served", async () => {
    const { storage, reports, cache, advance } = fixture()
    await cache.set("user_1", `{"mfa":false}`, 60)
    expect(await cache.get("user_1")).toBe(`{"mfa":false}`)

    storage.failSet = true
    await cache.set("user_1", `{"mfa":true}`, 60)
    storage.failSet = false

    expect(reports).toEqual(["set"])
    // Reads work again and storage still holds the old row, but the cache must not hand it out.
    expect(await cache.get("user_1")).toBeNull()
    advance(4_999)
    expect(await cache.get("user_1")).toBeNull()
  })

  it("does not touch storage before the retry is due", async () => {
    const { storage, cache, advance } = fixture()
    storage.down = true
    await cache.get("user_1")
    const callsAfterFailure = storage.calls
    storage.down = false

    advance(4_999)
    await cache.get("user_1")
    await cache.set("user_1", "{}", 60)

    expect(storage.calls).toBe(callsAfterFailure)
  })

  it("trusts storage again only after a reset succeeds, and then stores values", async () => {
    const { storage, reports, cache, advance } = fixture()
    await cache.set("user_1", `{"old":true}`, 60)
    storage.down = true
    await cache.get("user_1")

    advance(5_000)
    await cache.get("user_1") // the reset fails: the server is still down
    expect(reports).toEqual(["get", "reset"])

    storage.down = false
    advance(5_000)
    expect(await cache.get("user_1")).toBeNull() // the reset removed the old row
    await cache.set("user_1", `{"new":true}`, 60)

    expect(await cache.get("user_1")).toBe(`{"new":true}`)
    expect(reports).toEqual(["get", "reset"])
  })

  it("clears what an earlier process left before trusting a new wrapper", async () => {
    const storage = new MemoryCacheStorage()
    await storage.set("user_1", `{"id":1}`)

    expect(await failOpen(storage, () => {}).get("user_1")).toBeNull()
  })

  it("shares one reset between operations that arrive together", async () => {
    const storage = new FlakyCacheStorage()
    const cache = failOpen(storage, () => {})

    await Promise.all([cache.get("a"), cache.get("b"), cache.del("c")])

    expect(storage.calls).toBe(1 + 3) // one reset, then the three operations
  })

  it("passes reset through and lets its failure reach the caller", async () => {
    const { storage, cache } = fixture()
    storage.down = true

    await expect(cache.reset()).rejects.toThrow("cache down")
  })
})
