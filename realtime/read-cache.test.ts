import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import { ConnectionLostError, RequestTimeoutError } from "./client-transport.ts"
import { RealtimeRequestError } from "./errors.ts"
import {
  cachedRead,
  createLocalReads,
  createReadCache,
  isProxyAnswer,
  isRefusal,
  readCopy,
  ReadRefused,
} from "./read-cache.ts"
import type { ReadCache } from "./read-cache.ts"
import { createMemoryReadCache } from "./testing.ts"

/** A browser's IndexedDB with nothing in it, so each case starts clean. */
function freshFactory(): IDBFactory {
  return new IDBFactory() as unknown as IDBFactory
}

/** A clock the test moves by hand. */
function handClock(start: number) {
  const clock = { time: start, now: () => clock.time }
  return clock
}

const lost = () => Promise.reject(new ConnectionLostError(`socket closed`))
const answer = <T>(value: T) => () => Promise.resolve(value)

describe("cachedRead", () => {
  it("returns the last answer and its time when the server is unreachable", async () => {
    const clock = handClock(1000)
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory(), clock })
    await cachedRead(cache, "groups", answer(["a", "b"]))
    clock.time = 5000

    const offline = await cachedRead<string[]>(cache, "groups", lost)

    expect(offline).toEqual({ value: ["a", "b"], fresh: false, savedAt: 1000 })
  })

  it("answers from the copy when fetch itself fails", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer([1]))

    const offline = await cachedRead(cache, "groups", () => Promise.reject(new TypeError("fetch")))

    expect(offline.value).toEqual([1])
    expect(offline.fresh).toBe(false)
  })

  it("answers from the copy when the server does not answer in time", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer([1]))

    const late = await cachedRead(
      cache,
      "groups",
      () => Promise.reject(new RequestTimeoutError("frame-1", 15_000)),
    )

    expect(late).toEqual({ value: [1], fresh: false, savedAt: expect.any(Number) })
  })

  it("throws the connection error when the server is unreachable and nothing is saved", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })

    await expect(cachedRead(cache, "groups", lost)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("throws the connection error when the server is unreachable and the copy cannot be read", async () => {
    const broken = {
      get: () => Promise.reject(new Error("blocked")),
      set: () => Promise.resolve(0),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }

    await expect(cachedRead(broken, "groups", lost)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("keeps a copy per key", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer(["g"]))

    await expect(cachedRead(cache, "members", lost)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("replaces the copy with every answer and marks the answer fresh", async () => {
    const clock = handClock(1000)
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory(), clock })
    await cachedRead(cache, "groups", answer(["old"]))
    clock.time = 2000

    const fresh = await cachedRead(cache, "groups", answer(["new"]))
    const offline = await cachedRead(cache, "groups", lost)

    expect(fresh).toEqual({ value: ["new"], fresh: true, savedAt: 2000 })
    expect(offline).toEqual({ value: ["new"], fresh: false, savedAt: 2000 })
  })

  it("neither returns nor replaces the copy when the server refuses the read", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer(["mine"]))

    for (const code of ["unauthorized", "forbidden"] as const) {
      const refused = () => Promise.reject(new RealtimeRequestError(code, "no"))
      await expect(cachedRead(cache, "groups", refused)).rejects.toMatchObject({ code })
    }

    expect((await readCopy(cache, "groups"))?.value).toEqual(["mine"])
  })

  it("throws any other error and leaves the copy alone", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer(["kept"]))

    await expect(cachedRead(cache, "groups", () => Promise.reject(new Error("boom"))))
      .rejects.toThrow("boom")
    expect((await readCopy(cache, "groups"))?.value).toEqual(["kept"])
  })

  it("still returns the answer when the device cannot save it", async () => {
    const cache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error("disk full")),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }

    const result = await cachedRead(cache, "groups", answer(["x"]))

    expect(result.value).toEqual(["x"])
    expect(result.fresh).toBe(true)
  })

  it("writes nothing to IndexedDB when no cache is given", async () => {
    let touched = 0
    const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        touched++
        return undefined
      },
    })
    try {
      const result = await cachedRead(undefined, "groups", answer(["x"]))
      await expect(cachedRead(undefined, "groups", lost)).rejects.toBeInstanceOf(
        ConnectionLostError,
      )
      expect(await readCopy(undefined, "groups")).toBeUndefined()
      expect(result.value).toEqual(["x"])
      expect(result.fresh).toBe(true)
    } finally {
      if (had) Object.defineProperty(globalThis, "indexedDB", had)
      else delete (globalThis as { indexedDB?: unknown }).indexedDB
    }

    expect(touched).toBe(0)
  })
})

describe("readCopy", () => {
  it("returns the copy at once, marked as a copy, and undefined when there is none", async () => {
    const clock = handClock(42)
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory(), clock })
    expect(await readCopy(cache, "groups")).toBeUndefined()
    await cachedRead(cache, "groups", answer(["a"]))

    expect(await readCopy(cache, "groups")).toEqual({ value: ["a"], fresh: false, savedAt: 42 })
  })

  it("returns undefined instead of throwing when the device cannot read", async () => {
    const broken = {
      get: () => Promise.reject(new Error("blocked")),
      set: () => Promise.resolve(0),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }

    expect(await readCopy(broken, "groups")).toBeUndefined()
  })
})

describe("ReadCache.clear", () => {
  it("deletes every copy of a user and leaves another user's untouched", async () => {
    const indexedDB = freshFactory()
    const alice = createReadCache({ name: "reads:alice", indexedDB })
    const bob = createReadCache({ name: "reads:bob", indexedDB })
    await cachedRead(alice, "groups", answer(["a1"]))
    await cachedRead(alice, "members", answer(["a2"]))
    await cachedRead(bob, "groups", answer(["b1"]))

    await alice.clear()

    expect(await readCopy(alice, "groups")).toBeUndefined()
    expect(await readCopy(alice, "members")).toBeUndefined()
    expect((await readCopy(bob, "groups"))?.value).toEqual(["b1"])
  })

  it("keeps nothing from a read that answers after the copies were deleted", async () => {
    const indexedDB = freshFactory()
    const cache = createReadCache({ name: "reads:u1", indexedDB })
    let answerLate!: (value: string[]) => void
    const slow = new Promise<string[]>((resolve) => answerLate = resolve)
    const pending = cachedRead(cache, "groups", () => slow)

    await cache.clear()
    answerLate(["late"])
    await pending

    expect(await readCopy(createReadCache({ name: "reads:u1", indexedDB }), "groups"))
      .toBeUndefined()
  })

  it("returns the time from a set after clear when storage is blocked", async () => {
    const blocked = {
      open() {
        throw new Error(`storage is blocked`)
      },
    } as unknown as IDBFactory
    const cache = createReadCache({ name: "reads:u1", indexedDB: blocked, clock: handClock(7000) })
    await expect(cache.clear()).rejects.toThrow(`storage is blocked`)

    expect(await cache.set("groups", ["late"])).toBe(7000)
  })

  it("survives a restart: a cache opened again reads the saved copy", async () => {
    const indexedDB = freshFactory()
    await cachedRead(createReadCache({ name: "reads:u1", indexedDB }), "groups", answer(["a"]))

    const after = createReadCache({ name: "reads:u1", indexedDB })

    expect((await readCopy(after, "groups"))?.value).toEqual(["a"])
  })
})

describe("ReadCache.delete", () => {
  it("drops one key and leaves the others", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })
    await cachedRead(cache, "groups", answer([1]))
    await cachedRead(cache, "notes", answer([2]))

    await cache.delete("groups")

    expect(await readCopy(cache, "groups")).toBeUndefined()
    expect((await readCopy(cache, "notes"))?.value).toEqual([2])
  })

  it("does nothing for a key with no copy", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })

    await cache.delete("missing")

    expect(await readCopy(cache, "missing")).toBeUndefined()
  })
})

describe("createMemoryReadCache", () => {
  it("keeps a copy with its time, and a second cache over the same map finds it", async () => {
    const entries = new Map()
    await cachedRead(createMemoryReadCache(() => 7, entries), "groups", answer(["a"]))

    const found = await readCopy(createMemoryReadCache(() => 9, entries), "groups")

    expect(found).toEqual({ value: ["a"], fresh: false, savedAt: 7 })
  })

  it("deletes one key", async () => {
    const cache = createMemoryReadCache()
    await cache.set("a", 1)
    await cache.set("b", 2)

    await cache.delete("a")

    expect(await cache.get("a")).toBeUndefined()
    expect((await cache.get("b"))?.value).toBe(2)
  })

  it("stores nothing after clear, so a late answer cannot come back", async () => {
    const cache = createMemoryReadCache()
    await cache.clear()

    await cache.set("a", 1)

    expect(await cache.get("a")).toBeUndefined()
  })

  it("deletes every copy on clear", async () => {
    const entries = new Map()
    const cache = createMemoryReadCache(() => 1, entries)
    await cache.set("a", 1)

    await cache.clear()

    expect(await cache.get("a")).toBeUndefined()
    expect(await createMemoryReadCache(() => 1, entries).get("a")).toBeUndefined()
  })

  it("returns a clone, so changing what was read does not alter the cache", async () => {
    const cache = createMemoryReadCache()
    await cache.set("a", [1])
    ;(await cache.get<number[]>("a"))!.value.push(2)

    expect((await cache.get("a"))?.value).toEqual([1])
  })

  it("stores a copy, so a later change to the value does not alter it", async () => {
    const cache = createMemoryReadCache()
    const list = [1]
    await cache.set("a", list)
    list.push(2)

    expect((await cache.get("a"))?.value).toEqual([1])
  })
})

describe("ReadRefused", () => {
  it("carries the status, the code and a string failure as its message", () => {
    const refused = new ReadRefused("No access", 403, "FORBIDDEN")

    expect(refused).toBeInstanceOf(Error)
    expect([refused.name, refused.message, refused.status, refused.code]).toEqual([
      "ReadRefused",
      "No access",
      403,
      "FORBIDDEN",
    ])
  })

  it("keeps a failure that is not a string and gives a general message", () => {
    const failure = { list: "No" }
    const refused = new ReadRefused(failure, 500)

    expect(refused.failure).toBe(failure)
    expect(refused.message).toBe("The server refused the read")
  })
})

describe("isProxyAnswer", () => {
  it("takes a 5xx, a 404 or a 429 without an error code for a proxy's", () => {
    for (const status of [502, 500, 404, 429]) {
      expect(isProxyAnswer(new ReadRefused("x", status))).toBe(true)
      expect(isProxyAnswer(new ReadRefused("x", status, null))).toBe(true)
    }
  })

  it("takes an answer with an error code, a 401 or a 403 for the API's", () => {
    expect(isProxyAnswer(new ReadRefused("x", 500, "BROKEN"))).toBe(false)
    expect(isProxyAnswer(new ReadRefused("x", 404, "GROUP_NOT_FOUND"))).toBe(false)
    expect(isProxyAnswer(new ReadRefused("x", 401))).toBe(false)
    expect(isProxyAnswer(new ReadRefused("x", 403))).toBe(false)
  })

  it("answers false for anything that is not a ReadRefused", () => {
    expect(isProxyAnswer(new TypeError("Failed to fetch"))).toBe(false)
    expect(isProxyAnswer({ status: 502 })).toBe(false)
  })
})

describe("isRefusal", () => {
  it("is true for a REST read answered 401 or 403, with or without a code", () => {
    for (const status of [401, 403]) {
      expect(isRefusal(new ReadRefused("x", status))).toBe(true)
      expect(isRefusal(new ReadRefused("x", status, "NO"))).toBe(true)
    }
  })

  it("is true for a 404 with an error code, and false for one without", () => {
    expect(isRefusal(new ReadRefused("x", 404, "GROUP_NOT_FOUND"))).toBe(true)
    expect(isRefusal(new ReadRefused("x", 404))).toBe(false)
  })

  it("is false for a struggling server or a proxy's answer", () => {
    expect(isRefusal(new ReadRefused("x", 500, "BROKEN"))).toBe(false)
    expect(isRefusal(new ReadRefused("x", 502))).toBe(false)
    expect(isRefusal(new ReadRefused("x", 429))).toBe(false)
  })

  it("is true for a socket read refused unauthorized, forbidden or not_found, and no other", () => {
    for (const code of ["unauthorized", "forbidden", "not_found"] as const) {
      expect(isRefusal(new RealtimeRequestError(code, "no"))).toBe(true)
    }
    expect(isRefusal(new RealtimeRequestError("internal", "boom"))).toBe(false)
    expect(isRefusal(new ConnectionLostError("socket closed"))).toBe(false)
    expect(isRefusal(new Error("forbidden"))).toBe(false)
  })
})

describe("createLocalReads", () => {
  /** A device in memory that holds `["saved"]` under `list`, taken at 100. */
  async function device() {
    const cache = createMemoryReadCache(() => 100)
    await cache.set("list", ["saved"])
    return { cache, reads: createLocalReads(() => cache) }
  }

  const refused = (status: number, code?: string) => () =>
    Promise.reject(new ReadRefused("No", status, code))

  it("keeps every answer and returns it as fresh", async () => {
    const { cache, reads } = await device()

    const result = await reads.through("list", answer(["new"]))

    expect(result).toEqual({ value: ["new"], fresh: true, savedAt: 100 })
    expect((await cache.get("list"))?.value).toEqual(["new"])
  })

  it("answers from the copy when the server is unreachable", async () => {
    const { reads } = await device()

    expect(await reads.through("list", lost)).toEqual({
      value: ["saved"],
      fresh: false,
      savedAt: 100,
    })
  })

  for (const status of [502, 404, 429, 500]) {
    it(`answers a ${status} without an error code from the copy and keeps it`, async () => {
      const { cache, reads } = await device()

      expect((await reads.through("list", refused(status))).value).toEqual(["saved"])
      expect((await cache.get("list"))?.value).toEqual(["saved"])
    })
  }

  it("rejects a proxy's answer when the device holds no copy", async () => {
    const reads = createLocalReads(() => createMemoryReadCache())

    await expect(reads.through("list", refused(502))).rejects.toBeInstanceOf(ReadRefused)
  })

  for (
    const [status, code] of [[401], [403], [401, "NO"], [403, "NO"], [404, "NOT_FOUND"]] as const
  ) {
    it(`deletes the copy when the server answers ${status}${code ? ` with a code` : ``}`, async () => {
      const { cache, reads } = await device()

      await expect(reads.through("list", refused(status, code))).rejects.toBeInstanceOf(
        ReadRefused,
      )
      expect(await cache.get("list")).toBeUndefined()
    })
  }

  it("deletes the copy when a socket read is refused", async () => {
    const { cache, reads } = await device()

    await expect(
      reads.through("list", () => Promise.reject(new RealtimeRequestError("forbidden", "no"))),
    ).rejects.toBeInstanceOf(RealtimeRequestError)
    expect(await cache.get("list")).toBeUndefined()
  })

  it("keeps the copy and shows the error when a struggling server answers with a code", async () => {
    const { cache, reads } = await device()

    await expect(reads.through("list", refused(500, "BROKEN"))).rejects.toThrow("No")
    expect((await cache.get("list"))?.value).toEqual(["saved"])
  })

  it("hands over the saved copy alone, as it was taken", async () => {
    const { reads } = await device()

    expect(await reads.copy("list")).toEqual({ value: ["saved"], fresh: false, savedAt: 100 })
    expect(await reads.copy("other")).toBeUndefined()
  })

  it("keeps nothing and only reads when there is no cache", async () => {
    const reads = createLocalReads(() => undefined)

    expect((await reads.through("list", answer([1]))).value).toEqual([1])
    expect(await reads.copy("list")).toBeUndefined()
    await expect(reads.through("list", lost)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("asks for the cache at every read, so a new user's cache is used", async () => {
    const first = createMemoryReadCache()
    const second = createMemoryReadCache()
    await first.set("list", ["first user"])
    await second.set("list", ["second user"])
    let current: ReadCache | undefined = first
    const reads = createLocalReads(() => current)
    const before = await reads.through<string[]>("list", lost)
    current = second

    expect([before.value, (await reads.through<string[]>("list", lost)).value]).toEqual([
      ["first user"],
      ["second user"],
    ])
  })

  it("paints the copy early and then gives way to the answer", async () => {
    const { reads } = await device()
    let release!: (value: string[]) => void
    const slow = new Promise<string[]>((resolve) => release = resolve)
    const painted: unknown[] = []

    const reading = reads.through("list", () => slow, (copy) => void painted.push(copy?.value))
    await new Promise((resolve) => setTimeout(resolve, 0))
    release(["new"])

    expect((await reading).value).toEqual(["new"])
    expect(painted).toStrictEqual([["saved"]])
  })

  it("takes back an early paint when the server then refuses the read", async () => {
    const { reads } = await device()
    let reject!: (error: unknown) => void
    const slow = new Promise<string[]>((_, fail) => reject = fail)
    const painted: unknown[] = []

    const reading = reads.through("list", () => slow, (copy) => void painted.push(copy?.value))
    await new Promise((resolve) => setTimeout(resolve, 0))
    reject(new ReadRefused("No", 403))

    await expect(reading).rejects.toBeInstanceOf(ReadRefused)
    expect(painted).toStrictEqual([["saved"], undefined])
  })

  it("does not ask a screen that did not paint the copy to take it back", async () => {
    const { reads } = await device()
    let reject!: (error: unknown) => void
    const slow = new Promise<string[]>((_, fail) => reject = fail)
    const painted: unknown[] = []

    const reading = reads.through("list", () => slow, (copy) => {
      painted.push(copy?.value)
      return false
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    reject(new ReadRefused("No", 403))

    await expect(reading).rejects.toBeInstanceOf(ReadRefused)
    expect(painted).toStrictEqual([["saved"]])
  })

  it("does not paint a copy the device hands over only after the server refused the read", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => release = resolve)
    const cache = createMemoryReadCache()
    await cache.set("members:g-1", ["Ann"])
    const slow: ReadCache = { ...cache, get: async (key) => (await held, await cache.get(key)) }
    const painted: unknown[] = []

    await createLocalReads(() => slow).through(
      "members:g-1",
      () => Promise.reject(new Error("forbidden")),
      (copy) => void painted.push(copy?.value),
    ).catch(() => {})
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(painted).toStrictEqual([])
  })

  describe("over a saved copy the device cannot read just now", () => {
    /** A device that holds a copy, fails to read it, and counts what it is asked to delete. */
    async function unreadable() {
      const cache = createMemoryReadCache(() => 0)
      await cache.set("list", ["saved"])
      const deleted: string[] = []
      const reads = createLocalReads(() => ({
        ...cache,
        get: () => Promise.reject(new Error("the device cannot read")),
        delete: (key) => (deleted.push(key), cache.delete(key)),
      }))
      const answered = (status: number, code?: string) =>
        reads.through("list", refused(status, code)).catch((error) => error)
      return { answered, deleted }
    }

    it("does not delete it on a 404 without the API's error code", async () => {
      const { answered, deleted } = await unreadable()

      expect(await answered(404)).toBeInstanceOf(ReadRefused)
      expect(deleted).toEqual([])
    })

    it("deletes it on a 404 with the API's error code", async () => {
      const { answered, deleted } = await unreadable()

      expect(await answered(404, "GROUP_NOT_FOUND")).toBeInstanceOf(ReadRefused)
      expect(deleted).toEqual(["list"])
    })
  })

  it("still rejects with the refusal when the device cannot delete the copy", async () => {
    const { cache } = await device()
    const reads = createLocalReads(() => ({
      ...cache,
      delete: () => Promise.reject(new Error("the device cannot delete")),
    }))

    await expect(reads.through("list", refused(403))).rejects.toBeInstanceOf(ReadRefused)
  })
})
