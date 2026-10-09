// The `OutboxStore` contract, written once and run against both implementations:
// `outbox.test.ts` runs it on `createMemoryOutboxStore`, and `outbox-indexeddb.test.ts` on the
// IndexedDB store. The memory store is documented as having "the behaviour of the IndexedDB one
// that the queue relies on"; this suite is where that sentence is proven.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeOutboxStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { OutboxEntry, OutboxStore } from "./outbox.ts"

interface Payload {
  title: string
}

interface Server {
  version: number
}

/** A pending entry; the store assigns `seq`. */
export function pendingEntry(entityId: string, title = entityId): OutboxEntry<Payload, Server> {
  return {
    key: `key-${entityId}`,
    entityId,
    kind: "update",
    payload: { title },
    baseVersion: 1,
    attempted: false,
    status: "pending",
    queuedAt: "2026-10-09T00:00:00.000Z",
  }
}

/** Opens a store that is empty and belongs to this case alone. */
export type OpenOutboxStore = () => OutboxStore<Payload, Server>

/** Registers the contract suite for one implementation. */
export function describeOutboxStoreContract(name: string, open: OpenOutboxStore): void {
  describe(`${name} as an outbox store`, () => {
    it("starts empty", async () => {
      expect(await open().readOutbox()).toEqual([])
    })

    it("gives a new entry the next sequence number and answers it with that number", async () => {
      const store = open()
      const first = await store.putEntry(pendingEntry("a"))
      const second = await store.putEntry(pendingEntry("b"))

      expect(typeof first.seq).toBe("number")
      expect(second.seq!).toBeGreaterThan(first.seq!)
      expect(first.entityId).toBe("a")
    })

    it("reads entries back whole, in the order they were first saved", async () => {
      const store = open()
      await store.putEntry(pendingEntry("a"))
      await store.putEntry(pendingEntry("b"))
      await store.putEntry(pendingEntry("c"))

      const entries = await store.readOutbox()
      expect(entries.map((e) => e.entityId)).toEqual(["a", "b", "c"])
      expect(entries[1]).toEqual({ ...pendingEntry("b"), seq: entries[1].seq })
    })

    it("replaces an entry saved again with its sequence number, keeping its place", async () => {
      const store = open()
      const a = await store.putEntry(pendingEntry("a"))
      await store.putEntry(pendingEntry("b"))

      const saved = await store.putEntry({ ...a, payload: { title: "edited" }, attempted: true })

      expect(saved.seq).toBe(a.seq)
      const entries = await store.readOutbox()
      expect(entries.map((e) => [e.entityId, e.payload.title, e.attempted])).toEqual([
        ["a", "edited", true],
        ["b", "b", false],
      ])
    })

    it("removes an entry and leaves the others", async () => {
      const store = open()
      const a = await store.putEntry(pendingEntry("a"))
      await store.putEntry(pendingEntry("b"))

      await store.removeEntry(a.seq!)

      expect((await store.readOutbox()).map((e) => e.entityId)).toEqual(["b"])
    })

    it("does nothing when asked to remove an entry that is not there", async () => {
      const store = open()
      await store.putEntry(pendingEntry("a"))

      await store.removeEntry(999)

      expect((await store.readOutbox()).length).toBe(1)
    })

    it("never reuses the sequence number of a removed entry", async () => {
      const store = open()
      const a = await store.putEntry(pendingEntry("a"))
      await store.removeEntry(a.seq!)

      const b = await store.putEntry(pendingEntry("b"))

      expect(b.seq!).toBeGreaterThan(a.seq!)
    })

    it("keeps a conflict with its server snapshot", async () => {
      const store = open()
      const saved = await store.putEntry({
        ...pendingEntry("a"),
        status: "conflict",
        conflict: { reason: "version", message: "changed", server: { version: 7 } },
      })

      expect((await store.readOutbox())[0].conflict).toEqual({
        reason: "version",
        message: "changed",
        server: { version: 7 },
      })
      expect(saved.status).toBe("conflict")
    })

    it("hands out copies, so changing a result does not change the store", async () => {
      const store = open()
      const saved = await store.putEntry(pendingEntry("a"))
      saved.payload.title = "changed after saving"
      const read = await store.readOutbox()
      read[0].payload.title = "changed after reading"

      expect((await store.readOutbox())[0].payload.title).toBe("a")
    })
  })
}
