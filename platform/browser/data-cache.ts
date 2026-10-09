/**
 * A durable copy of the last data the server sent, so a page opens with it and shows it with no
 * network. Items are grouped in scopes, for example one per signed-in user or per calendar, and a
 * scope is replaced as a whole when a full answer arrives (an item the server dropped goes too).
 *
 * It holds server state only. Writes made offline wait in the outbox
 * (`@spy4x/realtime/outbox-indexeddb`) and the app layers them on top of what this cache returns.
 *
 * One database per signed-in user: name it for the user, and `clear` every scope at sign-out.
 *
 * Items read back in order of their id (a string comparison), not in the order they were stored; sort in the app.
 */

import { createDatabaseOpener, idbRequest, idbTransactionDone } from "./indexeddb.ts"

/** Options of {@link createDataCache}. */
export interface DataCacheOptions<T> {
  /** The database name, for example `data:${userId}`. */
  name: string
  /** The unique id of an item within its scope. */
  getId(item: T): string
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
}

/** The durable cache: see the module documentation. Items must be structured-cloneable. */
export interface DataCache<T> {
  /** Every item of the scope, in order of id. An unknown scope has none. */
  read(scope: string): Promise<T[]>
  /** One item, or `undefined` when the scope has none with that id. */
  get(scope: string, id: string): Promise<T | undefined>
  /** Makes the scope hold exactly `items`, in one transaction. */
  replace(scope: string, items: readonly T[]): Promise<void>
  /** Adds the item, or replaces the one with the same id. */
  put(scope: string, item: T): Promise<void>
  /** Removes one item. Does nothing when it is not there. */
  delete(scope: string, id: string): Promise<void>
  /** Removes every item of the scope. Other scopes stay. */
  clear(scope: string): Promise<void>
}

const ITEMS = "items"
const BY_SCOPE = "byScope"

interface Row<T> {
  scope: string
  id: string
  item: T
}

/** A data cache over IndexedDB. */
export function createDataCache<T>(options: DataCacheOptions<T>): DataCache<T> {
  const open = createDatabaseOpener({
    name: options.name,
    version: 1,
    indexedDB: options.indexedDB,
    upgrade(db) {
      const items = db.createObjectStore(ITEMS, { keyPath: ["scope", "id"] })
      items.createIndex(BY_SCOPE, "scope")
    },
  })

  /**
   * Runs `work` in a read-write transaction and resolves when it has committed. `work` may await
   * IndexedDB requests of this transaction and nothing else, or the transaction commits early.
   */
  async function write(work: (items: IDBObjectStore) => Promise<void> | void): Promise<void> {
    const db = await open()
    const transaction = db.transaction(ITEMS, "readwrite")
    const done = idbTransactionDone(transaction)
    try {
      await work(transaction.objectStore(ITEMS))
    } catch (error) {
      transaction.abort()
      await done.catch(() => {})
      throw error
    }
    await done
  }

  const row = (scope: string, item: T): Row<T> => ({ scope, id: options.getId(item), item })

  /** Deletes every item of the scope inside the transaction of `items`. */
  async function deleteScope(items: IDBObjectStore, scope: string): Promise<void> {
    const keys = await idbRequest(items.index(BY_SCOPE).getAllKeys(scope))
    for (const key of keys) items.delete(key)
  }

  return {
    async read(scope) {
      const db = await open()
      const rows = await idbRequest(
        db.transaction(ITEMS).objectStore(ITEMS).index(BY_SCOPE).getAll(scope),
      ) as Row<T>[]
      return rows.map((r) => r.item)
    },
    async get(scope, id) {
      const db = await open()
      const found = await idbRequest(
        db.transaction(ITEMS).objectStore(ITEMS).get([scope, id]),
      ) as Row<T> | undefined
      return found?.item
    },
    replace: (scope, items) =>
      // An item whose id cannot be read aborts the transaction: the scope stays as it was.
      write(async (store) => {
        await deleteScope(store, scope)
        for (const item of items) store.put(row(scope, item))
      }),
    async put(scope, item) {
      const r = row(scope, item)
      await write((store) => void store.put(r))
    },
    delete: (scope, id) => write((store) => void store.delete([scope, id])),
    clear: (scope) => write((store) => deleteScope(store, scope)),
  }
}
