import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import { browserStorage, makeStorage, memoryStorage, type StorageLike } from "./storage.ts"
import { installLocalStorage } from "./testing.ts"
import { describeStorageContract } from "./storage-contract.test.ts"

const themeSchema = type("'light'|'dark'")
const profileSchema = type({ name: "string", age: "number" })

describeStorageContract("memoryStorage", () => ({
  storage: memoryStorage(),
  prefix: "",
  close: () => {},
}))

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
    // `@spy4x/validation` builds `description` from arktype's own issues.
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
    // `@spy4x/validation` deliberately does not call `configure({ onUndeclaredKey: "reject" })`,
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

/** What a browser throws from every storage call, and from `localStorage` itself, when blocked. */
function blocked(): never {
  throw new DOMException("The operation is insecure.", "SecurityError")
}

/** A store whose `setItem` fails as on a full quota while reads and removals work. */
function fullStorage(initial: Record<string, string> = {}): StorageLike & { full: boolean } {
  const inner = memoryStorage(initial)
  return {
    full: true,
    getItem: (key) => inner.getItem(key),
    setItem(key, value) {
      if (this.full) throw new DOMException("Quota exceeded.", "QuotaExceededError")
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key),
  }
}

describeStorageContract("browserStorage over a working store", () => {
  const inner = memoryStorage()
  return { storage: browserStorage(() => inner), prefix: "", close: () => {} }
})

describeStorageContract("browserStorage over a blocked store", () => ({
  storage: browserStorage(blocked),
  prefix: "",
  close: () => {},
}))

describeStorageContract("browserStorage over a full store", () => {
  const inner = fullStorage()
  return { storage: browserStorage(() => inner), prefix: "", close: () => {} }
})

describe("browserStorage", () => {
  it("reads and writes the global localStorage by default", () => {
    const { kept, restore } = installLocalStorage({ old: "1" })
    try {
      const storage = browserStorage()

      expect(storage.getItem("old")).toBe("1")
      storage.setItem("new", "2")
      expect(kept.getItem("new")).toBe("2")
      storage.removeItem("old")
      expect(kept.getItem("old")).toBeNull()
    } finally {
      restore()
    }
  })

  it("looks the store up on every call, so it is safe to create before storage exists", () => {
    let inner: StorageLike | undefined = undefined
    const storage = browserStorage(() => inner as StorageLike)

    expect(storage.getItem("a")).toBeNull()
    inner = memoryStorage({ a: "1" })
    expect(storage.getItem("a")).toBe("1")
  })

  it("sees a value another writer put in the store after its own write", () => {
    const inner = memoryStorage()
    const storage = browserStorage(() => inner)

    storage.setItem("a", "mine")
    inner.setItem("a", "other tab")

    expect(storage.getItem("a")).toBe("other tab")
  })

  it("never throws when the store is blocked, and remembers what was set", () => {
    const storage = browserStorage(blocked)

    expect(storage.getItem("a")).toBeNull()
    storage.setItem("a", "1")
    expect(storage.getItem("a")).toBe("1")
    storage.removeItem("a")
    expect(storage.getItem("a")).toBeNull()
  })

  it("returns the value a full store refused, not the older one it still holds", () => {
    const inner = fullStorage({ cursor: "old" })
    const storage = browserStorage(() => inner)

    storage.setItem("cursor", "new")

    expect(storage.getItem("cursor")).toBe("new")
    expect(inner.getItem("cursor")).toBe("old")
  })

  it("moves a remembered value back to the store once a write succeeds", () => {
    const inner = fullStorage()
    const storage = browserStorage(() => inner)
    storage.setItem("a", "1")

    inner.full = false
    storage.setItem("a", "2")
    inner.setItem("a", "other tab")

    expect(storage.getItem("a")).toBe("other tab")
  })

  it("removes a key from the store as well as a remembered value", () => {
    const inner = fullStorage({ a: "old" })
    const storage = browserStorage(() => inner)
    storage.setItem("a", "new")

    storage.removeItem("a")

    expect(storage.getItem("a")).toBeNull()
    expect(inner.getItem("a")).toBeNull()
  })

  it("keeps separate memory for each store it creates", () => {
    const first = browserStorage(blocked)
    const second = browserStorage(blocked)

    first.setItem("a", "1")

    expect(second.getItem("a")).toBeNull()
  })
})
