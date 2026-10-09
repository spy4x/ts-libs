import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import { createDatabaseOpener, idbRequest, idbTransactionDone } from "./indexeddb.ts"

function opener(indexedDB: IDBFactory, version: number) {
  return createDatabaseOpener({
    name: "db",
    version,
    indexedDB: indexedDB as unknown as globalThis.IDBFactory,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains("a")) db.createObjectStore("a")
    },
  })
}

/** A connection of another tab that never closes for a newer version. */
function stubbornConnection(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("db", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("a")
    request.onsuccess = () => resolve(request.result as unknown as IDBDatabase)
    request.onerror = () => reject(request.error)
  })
}

describe("createDatabaseOpener", () => {
  it("fails instead of waiting for ever when an older connection blocks a newer version", async () => {
    const indexedDB = new IDBFactory()
    await stubbornConnection(indexedDB)

    await expect(opener(indexedDB, 2)()).rejects.toThrow("blocked")
  })

  it("opens the newer version once the blocking connection has closed", async () => {
    const indexedDB = new IDBFactory()
    const old = await stubbornConnection(indexedDB)
    const open = opener(indexedDB, 2)
    await expect(open()).rejects.toThrow("blocked")

    old.close()

    expect((await open()).version).toBe(2)
  })

  it("closes its own connection when another tab opens a newer version, so that tab is not blocked", async () => {
    const indexedDB = new IDBFactory()
    const first = await opener(indexedDB, 1)()

    const second = await opener(indexedDB, 2)()

    expect(second.version).toBe(2)
    expect(() => first.transaction("a")).toThrow()
  })

  it("opens a fresh connection after the old one was closed for a newer version", async () => {
    const indexedDB = new IDBFactory()
    const open = opener(indexedDB, 2)
    const before = await open()
    const upgraded = await opener(indexedDB, 3)()

    expect(upgraded.version).toBe(3)
    await expect(open()).rejects.toThrow() // version 2 is older than the database: a VersionError
    expect(before.version).toBe(2)
  })
})

describe("idbTransactionDone", () => {
  it("rejects when the transaction aborts", async () => {
    const db = await opener(new IDBFactory(), 1)()
    const transaction = db.transaction("a", "readwrite")
    const done = idbTransactionDone(transaction)

    transaction.abort()

    await expect(done).rejects.toThrow()
  })

  it("reports no unhandled rejection when a caller awaited a failing request instead", async () => {
    const db = await opener(new IDBFactory(), 1)()
    const transaction = db.transaction("a", "readwrite")
    idbTransactionDone(transaction)
    const store = transaction.objectStore("a")
    store.add("x", 1)

    await expect(idbRequest(store.add("y", 1))).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})
