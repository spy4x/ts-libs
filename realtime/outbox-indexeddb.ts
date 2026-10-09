/**
 * The durable {@link OutboxStore}: the offline queue kept in IndexedDB, so a write made offline
 * survives a closed tab, a restart and a reload. It behaves as {@link createMemoryOutboxStore}
 * does, which `outbox-store-contract.test.ts` proves by running one suite against both.
 *
 * One database per signed-in user: name it for the user, as the outbox lock is named
 * (`outbox:${userId}`), because a queue must never be sent as someone else.
 *
 * Browsers may evict the storage of a site that is not installed as an app after a week without a
 * visit (Safari does). Ask for persistent storage with `requestPersistentStorage` from
 * `@spy4x/platform/browser/persistent-storage` once the first write is queued.
 *
 * @module
 */

import {
  createDatabaseOpener,
  idbRequest,
  idbTransactionDone,
} from "@spy4x/platform/browser/indexeddb"
import type { OutboxEntry, OutboxStore } from "./outbox.ts"

/** Options of {@link createIndexedDbOutboxStore}. */
export interface IndexedDbOutboxStoreOptions {
  /** The database name, for example `outbox:${userId}`. */
  name: string
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
}

const ENTRIES = "entries"

/**
 * An outbox store over IndexedDB. `seq` is the object store's auto-incremented key, so entries
 * read back in send order, a saved entry keeps its place, and a number is never reused after its
 * entry is removed.
 */
export function createIndexedDbOutboxStore<P, S>(
  options: IndexedDbOutboxStoreOptions,
): OutboxStore<P, S> {
  const open = createDatabaseOpener({
    name: options.name,
    version: 1,
    indexedDB: options.indexedDB,
    upgrade(db) {
      db.createObjectStore(ENTRIES, { keyPath: "seq", autoIncrement: true })
    },
  })
  type Entry = OutboxEntry<P, S>
  return {
    async readOutbox() {
      const db = await open()
      return await idbRequest(db.transaction(ENTRIES).objectStore(ENTRIES).getAll()) as Entry[]
    },
    async putEntry(entry) {
      const db = await open()
      const transaction = db.transaction(ENTRIES, "readwrite")
      const done = idbTransactionDone(transaction)
      const { seq, ...rest } = entry
      // Without a `seq` the store assigns the next one; with one it replaces that entry.
      const key = await idbRequest(
        transaction.objectStore(ENTRIES).put(seq === undefined ? rest : { ...rest, seq }),
      )
      await done
      return { ...rest, seq: key as number } as Entry
    },
    async removeEntry(seq) {
      const db = await open()
      const transaction = db.transaction(ENTRIES, "readwrite")
      const done = idbTransactionDone(transaction)
      transaction.objectStore(ENTRIES).delete(seq)
      await done
    },
  }
}
