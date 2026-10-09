import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import { createOutbox, createPromiseLock } from "./outbox.ts"
import { createIndexedDbOutboxStore } from "./outbox-indexeddb.ts"
import { describeOutboxStoreContract, pendingEntry } from "./outbox-store-contract.test.ts"

/** A browser's IndexedDB with nothing in it, so each case starts clean. */
function freshFactory(): IDBFactory {
  return new IDBFactory()
}

describeOutboxStoreContract("createIndexedDbOutboxStore", () =>
  createIndexedDbOutboxStore({
    name: "outbox:contract",
    indexedDB: freshFactory() as unknown as IDBFactory,
  }))

describe("createIndexedDbOutboxStore durability", () => {
  it("returns the queue to a store opened again after a restart", async () => {
    const indexedDB = freshFactory()
    const before = createIndexedDbOutboxStore({ name: "outbox:u1", indexedDB })
    const a = await before.putEntry(pendingEntry("a"))
    await before.putEntry(pendingEntry("b"))

    const after = createIndexedDbOutboxStore({ name: "outbox:u1", indexedDB })

    expect((await after.readOutbox()).map((e) => e.entityId)).toEqual(["a", "b"])
    const c = await after.putEntry(pendingEntry("c"))
    expect(c.seq!).toBeGreaterThan(a.seq! + 1)
  })

  it("keeps one user's queue apart from another's", async () => {
    const indexedDB = freshFactory()
    const alice = createIndexedDbOutboxStore({ name: "outbox:alice", indexedDB })
    const bob = createIndexedDbOutboxStore({ name: "outbox:bob", indexedDB })

    await alice.putEntry(pendingEntry("a"))

    expect(await bob.readOutbox()).toEqual([])
  })

  it("rejects with the browser's reason when storage cannot be opened", async () => {
    const broken = {
      open() {
        throw new Error("storage is blocked")
      },
    } as unknown as IDBFactory
    const store = createIndexedDbOutboxStore({ name: "outbox:u1", indexedDB: broken })

    await expect(store.readOutbox()).rejects.toThrow("storage is blocked")
  })

  it("opens again after a failed open", async () => {
    const real = freshFactory()
    let blocked = true
    const flaky = {
      open: (name: string, version?: number) => {
        if (blocked) throw new Error("storage is blocked")
        return real.open(name, version)
      },
    } as unknown as IDBFactory
    const store = createIndexedDbOutboxStore({ name: "outbox:u1", indexedDB: flaky })
    await expect(store.readOutbox()).rejects.toThrow("storage is blocked")

    blocked = false

    expect(await store.readOutbox()).toEqual([])
  })

  it("lets the outbox send, after a restart, a write queued while offline", async () => {
    const indexedDB = freshFactory()
    const ports = (online: boolean, sent: string[]) => ({
      store: createIndexedDbOutboxStore<{ title: string }, { version: number }>({
        name: "outbox:u1",
        indexedDB,
      }),
      lock: createPromiseLock(),
      canSend: () => online,
      classify: () => ({ kind: "unreachable" as const }),
      fetchServer: () => Promise.resolve(null),
      send: (command: { entityId: string }) => {
        sent.push(command.entityId)
        return Promise.resolve({ version: 2 })
      },
    })
    const offline = createOutbox(ports(false, []))
    await offline.submit({
      kind: "update",
      entityId: "n",
      payload: { title: "Written offline" },
      version: 1,
    })

    const sent: string[] = []
    const restarted = createOutbox(ports(true, sent))
    await restarted.reload()
    await restarted.flush()

    expect(sent).toEqual(["n"])
    expect(restarted.entries()).toEqual([])
  })
})
