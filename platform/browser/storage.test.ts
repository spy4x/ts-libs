import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import { makeStorage, memoryStorage, type StorageLike } from "./storage.ts"

const themeSchema = type("'light'|'dark'")
const profileSchema = type({ name: "string", age: "number" })

describe("memoryStorage", () => {
  it("behaves like the Storage interface it stands in for", () => {
    const storage = memoryStorage()
    expect(storage.getItem("missing")).toBeNull()
    storage.setItem("a", "1")
    expect(storage.getItem("a")).toBe("1")
    expect(storage.size).toBe(1)
    storage.removeItem("a")
    expect(storage.getItem("a")).toBeNull()
    expect(storage.size).toBe(0)
  })
})

describe("makeStorage without a schema", () => {
  it("round-trips a JSON value", () => {
    const storage = memoryStorage()
    const store = makeStorage<{ count: number }>(storage, "counter")
    expect(store.set({ count: 3 }).status).toBe("ok")
    expect(store.get()).toEqual({ status: "ok", value: { count: 3 } })
  })

  it("reports a missing key rather than returning null", () => {
    expect(makeStorage<number>(memoryStorage(), "absent").get()).toEqual({ status: "missing" })
  })

  it("deletes the key", () => {
    const storage = memoryStorage({ key: "1" })
    makeStorage<number>(storage, "key").del()
    expect(storage.getItem("key")).toBeNull()
  })

  it("reports unparseable content as invalid and evicts it", () => {
    const storage = memoryStorage({ broken: "{not json" })
    const store = makeStorage<number>(storage, "broken")
    const result = store.get()
    expect(result.status).toBe("invalid")
    expect(storage.getItem("broken")).toBeNull()
  })
})

describe("makeStorage with a schema", () => {
  it("infers the value type from the schema and round-trips a valid value", () => {
    const store = makeStorage(memoryStorage(), "theme", { schema: themeSchema })
    const written = store.set("dark")
    expect(written).toEqual({ status: "ok", value: "dark" })
    expect(store.get()).toEqual({ status: "ok", value: "dark" })
  })

  it("rejects an invalid value on write, so a bad writer cannot persist", () => {
    const storage = memoryStorage()
    const store = makeStorage(storage, "theme", { schema: themeSchema })
    // The cast is the point: this is exactly the mistake the write-side check catches.
    const result = store.set("blue" as unknown as "light")
    expect(result.status).toBe("invalid")
    expect(storage.getItem("theme")).toBeNull()
  })

  it("keeps the stored value when a later write is invalid, instead of erasing it", () => {
    // A half-filled form submitting an invalid value must not cost the user their last-saved
    // theme. Before the fix, `set`'s failure path deleted the key through the same `reject` a
    // failed `get` uses — correct for a read, where the stored value itself is bad, but wrong for
    // a write, where the value that failed was never persisted and the old one is still good.
    const storage = memoryStorage()
    const store = makeStorage(storage, "theme", { schema: themeSchema })
    expect(store.set("dark")).toEqual({ status: "ok", value: "dark" })

    const result = store.set("blue" as unknown as "light")

    expect(result.status).toBe("invalid")
    expect(store.get()).toEqual({ status: "ok", value: "dark" })
    expect(storage.getItem("theme")).toBe(`"dark"`)
  })

  it("describes the write failure through the validation envelope, not a bespoke map", () => {
    // `@ts-libs/validation` builds `description` from arktype's own issues.
    const store = makeStorage(memoryStorage(), "profile", { schema: profileSchema })
    const result = store.set(
      { name: "Ada", age: "old" } as unknown as { name: string; age: number },
    )
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.reason).toContain("age")
  })

  it("evicts and reports a stored value that no longer matches its schema", () => {
    const storage = memoryStorage({ theme: `"blue"` })
    const store = makeStorage(storage, "theme", { schema: themeSchema })
    const result = store.get()
    expect(result.status).toBe("invalid")
    expect(storage.getItem("theme")).toBeNull()
  })

  it("evicts a stored value that is not JSON at all", () => {
    const storage = memoryStorage({ theme: "dark" })
    const store = makeStorage(storage, "theme", { schema: themeSchema })
    expect(store.get().status).toBe("invalid")
    expect(storage.getItem("theme")).toBeNull()
  })

  it("reports a missing key without invoking the schema", () => {
    expect(makeStorage(memoryStorage(), "theme", { schema: themeSchema }).get()).toEqual({
      status: "missing",
    })
  })

  it("calls onReject with the key and reason before evicting", () => {
    const rejections: [string, string][] = []
    const storage = memoryStorage({ theme: `"blue"` })
    makeStorage(storage, "theme", {
      schema: themeSchema,
      onReject: (key, reason) => rejections.push([key, reason]),
    }).get()
    expect(rejections.length).toBe(1)
    expect(rejections[0][0]).toBe("theme")
    expect(rejections[0][1]).toContain("blue")
  })

  const allowsUndeclared =
    "keeps an undeclared key when the schema allows it, not strict by default"
  it(allowsUndeclared, () => {
    // `@ts-libs/validation` deliberately does not call `configure({ onUndeclaredKey: "reject" })`,
    // so strictness is the schema's decision and this wrapper must not invent one. An undeclared key
    // survives, which is the behaviour arktype itself has.
    const store = makeStorage(memoryStorage(), "profile", { schema: profileSchema })
    const written = store.set({ name: "Ada", age: 36, nickname: "A" } as {
      name: string
      age: number
    })
    expect(written.status).toBe("ok")
    expect(store.get()).toEqual({ status: "ok", value: { name: "Ada", age: 36, nickname: "A" } })
  })

  it("rejects an undeclared key when the caller's own schema says to", () => {
    // The wrapper passes the schema through untouched, so a caller opts into strictness on its own
    // schema rather than relying on a global. No global arktype config is read or written here.
    const strict = profileSchema.onUndeclaredKey("reject")
    const storage = memoryStorage()
    const store = makeStorage(storage, "profile", { schema: strict })
    const result = store.set({ name: "Ada", age: 36, nickname: "A" } as {
      name: string
      age: number
    })
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.reason).toContain("nickname")
    expect(storage.getItem("profile")).toBeNull()
  })

  it("leaves the stored value alone on a valid write", () => {
    const storage = memoryStorage()
    const store = makeStorage(storage, "theme", { schema: themeSchema })
    store.set("light")
    expect(storage.getItem("theme")).toBe(`"light"`)
  })
})

describe("makeStorage storage port", () => {
  it("accepts any Storage-shaped object, including a namespaced adapter", () => {
    const backing = memoryStorage()
    const touched: string[] = []
    const namespaced: StorageLike = {
      getItem: (key) => backing.getItem(`app:${key}`),
      setItem: (key, value) => {
        touched.push(key)
        backing.setItem(`app:${key}`, value)
      },
      removeItem: (key) => void backing.removeItem(`app:${key}`),
    }
    const store = makeStorage(namespaced, "theme", { schema: themeSchema })
    store.set("dark")
    expect(backing.getItem("app:theme")).toBe(`"dark"`)
    expect(store.get()).toEqual({ status: "ok", value: "dark" })
    expect(touched).toEqual(["theme"])
  })

  it("never reads a global, so it is safe under SSR", () => {
    // The source constructed `new StorageHelper(localStorage)` at module scope, which throws on any
    // runtime without a `localStorage` global. This module was imported at the top of this file
    // with plain `makeStorage(memoryStorage(), …)` calls and no global present in between.
    const store = makeStorage<number>(memoryStorage({ n: "1" }), "n")
    expect(store.get()).toEqual({ status: "ok", value: 1 })
  })
})
