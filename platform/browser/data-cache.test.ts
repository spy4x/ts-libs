import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import { createDataCache, type DataCache } from "./data-cache.ts"

interface Task {
  id: string
  title: string
}

const task = (id: string, title = id): Task => ({ id, title })

function open(indexedDB: IDBFactory = new IDBFactory(), name = "data:u1"): DataCache<Task> {
  return createDataCache<Task>({
    name,
    getId: (t) => t.id,
    indexedDB: indexedDB as unknown as globalThis.IDBFactory,
  })
}

describe("createDataCache", () => {
  it("reads nothing from a scope that was never written", async () => {
    expect(await open().read("calendar-1")).toEqual([])
  })

  it("replaces a scope with exactly the items given", async () => {
    const cache = open()
    await cache.replace("cal", [task("a"), task("b")])

    await cache.replace("cal", [task("b", "B2"), task("c")])

    expect(await cache.read("cal")).toEqual([task("b", "B2"), task("c")])
  })

  it("empties a scope when it is replaced with no items", async () => {
    const cache = open()
    await cache.replace("cal", [task("a")])

    await cache.replace("cal", [])

    expect(await cache.read("cal")).toEqual([])
  })

  it("keeps other scopes when one is replaced, cleared or changed", async () => {
    const cache = open()
    await cache.replace("one", [task("a")])
    await cache.replace("two", [task("x"), task("y")])

    await cache.replace("one", [task("b")])
    await cache.put("one", task("c"))
    await cache.delete("one", "b")
    await cache.clear("one")

    expect(await cache.read("one")).toEqual([])
    expect(await cache.read("two")).toEqual([task("x"), task("y")])
  })

  it("keeps a scope whose name is a prefix of another's apart", async () => {
    const cache = open()
    await cache.replace("cal", [task("a")])
    await cache.replace("cal-2", [task("b")])

    expect(await cache.read("cal")).toEqual([task("a")])
    await cache.clear("cal")
    expect(await cache.read("cal-2")).toEqual([task("b")])
  })

  it("adds an item and replaces the one with the same id", async () => {
    const cache = open()
    await cache.put("cal", task("a"))
    await cache.put("cal", task("b"))

    await cache.put("cal", task("a", "A2"))

    expect(await cache.read("cal")).toEqual([task("a", "A2"), task("b")])
  })

  it("deletes one item, and ignores an item that is not there", async () => {
    const cache = open()
    await cache.replace("cal", [task("a"), task("b")])

    await cache.delete("cal", "a")
    await cache.delete("cal", "nothing")

    expect(await cache.read("cal")).toEqual([task("b")])
  })

  it("gets one item by id", async () => {
    const cache = open()
    await cache.replace("cal", [task("a", "A")])

    expect(await cache.get("cal", "a")).toEqual(task("a", "A"))
    expect(await cache.get("cal", "b")).toBeUndefined()
    expect(await cache.get("other", "a")).toBeUndefined()
  })

  it("returns items in the order replace wrote them, not in order of id", async () => {
    const cache = open()
    await cache.replace("cal", [task("c"), task("a"), task("b")])

    expect((await cache.read("cal")).map((t) => t.id)).toEqual(["c", "a", "b"])
  })

  it("puts a new item after the others and keeps the place of one put again", async () => {
    const cache = open()
    await cache.replace("cal", [task("c"), task("a")])

    await cache.put("cal", task("b"))
    await cache.put("cal", task("c", "C2"))

    expect(await cache.read("cal")).toEqual([task("c", "C2"), task("a"), task("b")])
  })

  it("starts the order again when a scope is replaced", async () => {
    const cache = open()
    await cache.replace("cal", [task("a"), task("b")])

    await cache.replace("cal", [task("b"), task("a")])

    expect((await cache.read("cal")).map((t) => t.id)).toEqual(["b", "a"])
  })

  it("lists the scopes that hold items", async () => {
    const cache = open()
    await cache.replace("one", [task("a")])
    await cache.replace("two", [task("b")])
    await cache.replace("empty", [task("c")])
    await cache.clear("empty")

    expect((await cache.scopes()).sort()).toEqual(["one", "two"])
  })

  it("clears every scope at once", async () => {
    const cache = open()
    await cache.replace("one", [task("a")])
    await cache.replace("two", [task("b")])

    await cache.clearAll()

    expect(await cache.scopes()).toEqual([])
    expect(await cache.read("one")).toEqual([])
  })

  it("stays usable after clearAll", async () => {
    const cache = open()
    await cache.clearAll()

    await cache.put("cal", task("a"))

    expect(await cache.read("cal")).toEqual([task("a")])
  })

  it("removes every item of every scope on finish", async () => {
    const cache = open()
    await cache.replace("one", [task("a")])
    await cache.replace("two", [task("b")])

    await cache.finish()

    expect(await cache.scopes()).toEqual([])
    expect(await cache.read("one")).toEqual([])
    expect(await cache.get("two", "b")).toBeUndefined()
  })

  const writers: Record<string, (cache: DataCache<Task>) => Promise<void>> = {
    batch: (cache) => cache.batch([{ op: "put", scope: "cal", item: task("late") }]),
    replace: (cache) => cache.replace("cal", [task("late")]),
    put: (cache) => cache.put("cal", task("late")),
    delete: (cache) => cache.delete("cal", "a"),
    clear: (cache) => cache.clear("cal"),
  }
  for (const [name, call] of Object.entries(writers)) {
    it(`writes nothing with ${name} after finish`, async () => {
      const indexedDB = new IDBFactory()
      const finished = open(indexedDB)
      await finished.finish()
      // The next user's cache, here on the same database, shows what the finished one changes.
      const other = open(indexedDB)
      await other.replace("cal", [task("a"), task("b")])

      await call(finished)

      expect(await other.read("cal")).toEqual([task("a"), task("b")])
    })
  }

  it("does not start a write that was waiting for the database when finish was called", async () => {
    const read: string[] = []
    const cache = createDataCache<Task>({
      name: "data:u1",
      getId: (t) => (read.push(t.id), t.id),
      indexedDB: new IDBFactory() as unknown as globalThis.IDBFactory,
    })

    const put = cache.put("cal", task("late"))
    const finish = cache.finish()
    await Promise.all([put, finish])

    expect(read).toEqual([])
    expect(await cache.read("cal")).toEqual([])
  })

  it("removes a write whose transaction was already open when finish was called", async () => {
    let finish: Promise<void> | undefined
    const cache: DataCache<Task> = createDataCache<Task>({
      name: "data:u1",
      // The cache reads the id inside the put's transaction, so finish is called while it is open.
      getId: (t) => (finish ??= cache.finish(), t.id),
      indexedDB: new IDBFactory() as unknown as globalThis.IDBFactory,
    })

    await cache.put("cal", task("late"))
    await finish

    expect(finish).toBeDefined()
    expect(await cache.read("cal")).toEqual([])
  })

  it("leaves no database behind when a write comes after finish and deleteDatabase", async () => {
    const indexedDB = new IDBFactory()
    const cache = open(indexedDB)
    await cache.put("cal", task("a"))
    await cache.finish()
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("data:u1")
      request.onsuccess = resolve
      request.onerror = reject
    })
    expect(await indexedDB.databases()).toEqual([])

    await cache.put("cal", task("late"))

    expect(await indexedDB.databases()).toEqual([])
  })

  it("finishes one instance only: another on the same database still writes", async () => {
    const indexedDB = new IDBFactory()
    await open(indexedDB).finish()

    const next = open(indexedDB)
    await next.put("cal", task("a"))

    expect(await next.read("cal")).toEqual([task("a")])
  })

  it("applies puts, deletes and replaces across scopes in one batch, in order", async () => {
    const cache = open()
    await cache.replace("cal-1", [task("a"), task("b")])
    await cache.replace("old", [task("z")])

    await cache.batch([
      { op: "put", scope: "cal-1", item: task("a", "A2") },
      { op: "delete", scope: "cal-1", id: "b" },
      { op: "put", scope: "cal-1", item: task("c") },
      { op: "replace", scope: "cal-2", items: [task("x"), task("y")] },
      { op: "clear", scope: "old" },
    ])

    expect(await cache.read("cal-1")).toEqual([task("a", "A2"), task("c")])
    expect(await cache.read("cal-2")).toEqual([task("x"), task("y")])
    expect(await cache.scopes()).toEqual(["cal-1", "cal-2"])
  })

  it("keeps order within a batch that replaces a scope and then puts into it", async () => {
    const cache = open()

    await cache.batch([
      { op: "replace", scope: "cal", items: [task("b"), task("a")] },
      { op: "put", scope: "cal", item: task("c") },
      { op: "put", scope: "cal", item: task("b", "B2") },
    ])

    expect(await cache.read("cal")).toEqual([task("b", "B2"), task("a"), task("c")])
  })

  it("applies none of a batch when one step fails", async () => {
    const cache = createDataCache<Task>({
      name: "data:u1",
      getId: (t) => {
        if (!t.id) throw new Error("item without id")
        return t.id
      },
      indexedDB: new IDBFactory() as unknown as globalThis.IDBFactory,
    })
    await cache.replace("cal", [task("a")])

    await expect(cache.batch([
      { op: "put", scope: "cal", item: task("b") },
      { op: "replace", scope: "other", items: [task("x")] },
      { op: "clear", scope: "cal" },
      { op: "put", scope: "cal", item: task("") },
    ])).rejects.toThrow("item without id")

    expect(await cache.read("cal")).toEqual([task("a")])
    expect(await cache.scopes()).toEqual(["cal"])
  })

  it("shows the last data to a cache opened again after a restart", async () => {
    const indexedDB = new IDBFactory()
    await open(indexedDB).replace("cal", [task("a")])

    expect(await open(indexedDB).read("cal")).toEqual([task("a")])
  })

  it("keeps one user's database apart from another's", async () => {
    const indexedDB = new IDBFactory()
    await open(indexedDB, "data:alice").replace("cal", [task("a")])

    expect(await open(indexedDB, "data:bob").read("cal")).toEqual([])
  })

  it("leaves the scope as it was when an item has no usable id", async () => {
    const indexedDB = new IDBFactory()
    const cache = createDataCache<Task>({
      name: "data:u1",
      getId: (t) => {
        if (!t.id) throw new Error("item without id")
        return t.id
      },
      indexedDB: indexedDB as unknown as globalThis.IDBFactory,
    })
    await cache.replace("cal", [task("a")])

    await expect(cache.replace("cal", [task("b"), task("")])).rejects.toThrow("item without id")

    expect(await cache.read("cal")).toEqual([task("a")])
  })

  it("rejects with the browser's reason when storage cannot be opened", async () => {
    const cache = createDataCache<Task>({
      name: "data:u1",
      getId: (t) => t.id,
      indexedDB: {
        open: () => {
          throw new Error("storage is blocked")
        },
      } as unknown as globalThis.IDBFactory,
    })

    await expect(cache.read("cal")).rejects.toThrow("storage is blocked")
  })
})
