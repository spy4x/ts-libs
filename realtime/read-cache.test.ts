import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import { ConnectionLostError } from "./client-transport.ts"
import { RealtimeRequestError } from "./errors.ts"
import { cachedRead, createReadCache, readCopy } from "./read-cache.ts"

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

  it("throws the connection error when the server is unreachable and nothing is saved", async () => {
    const cache = createReadCache({ name: "reads:u1", indexedDB: freshFactory() })

    await expect(cachedRead(cache, "groups", lost)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("throws the connection error when the server is unreachable and the copy cannot be read", async () => {
    const broken = {
      get: () => Promise.reject(new Error("blocked")),
      set: () => Promise.resolve(0),
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

  it("survives a restart: a cache opened again reads the saved copy", async () => {
    const indexedDB = freshFactory()
    await cachedRead(createReadCache({ name: "reads:u1", indexedDB }), "groups", answer(["a"]))

    const after = createReadCache({ name: "reads:u1", indexedDB })

    expect((await readCopy(after, "groups"))?.value).toEqual(["a"])
  })
})
