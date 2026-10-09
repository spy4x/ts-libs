/**
 * A durable copy of the last data the server sent, so a page opens with it and shows it with no
 * network. Items are grouped in scopes, for example one per signed-in user or per calendar, and a
 * scope is replaced as a whole when a full answer arrives (an item the server dropped goes too).
 *
 * It holds server state only. Writes made offline wait in the outbox
 * (`@spy4x/realtime/outbox-indexeddb`) and the app layers them on top of what this cache returns.
 *
 * One database per signed-in user: name it for the user, and `clearAll` at sign-out.
 *
 * Items read back in the order `replace` wrote them (the server's order). An item added later by
 * `put` follows the others, and a `put` of an item already there keeps its place.
 *
 * @module
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

/** One step of {@link DataCache.batch}. */
export type DataCacheOp<T> =
  /** Adds the item to the scope, or replaces the one with the same id (keeping its place). */
  | { op: "put"; scope: string; item: T }
  /** Removes one item. Does nothing when it is not there. */
  | { op: "delete"; scope: string; id: string }
  /** Makes the scope hold exactly `items`, in that order. */
  | { op: "replace"; scope: string; items: readonly T[] }
  /** Removes every item of the scope. */
  | { op: "clear"; scope: string }

/** The durable cache: see the module documentation. Items must be structured-cloneable. */
export interface DataCache<T> {
  /** Every item of the scope, in the order described above. An unknown scope has none. */
  read(scope: string): Promise<T[]>
  /** One item, or `undefined` when the scope has none with that id. */
  get(scope: string, id: string): Promise<T | undefined>
  /** Every scope that holds at least one item. */
  scopes(): Promise<string[]>
  /**
   * Applies the steps in order, across items and scopes, in one transaction: all of them or none
   * (an item whose id cannot be read, or a full disk, leaves the cache as it was). This is how a
   * sync answer ("these calendars, these changed objects, these removed") lands without a reader
   * seeing it half applied.
   */
  batch(ops: readonly DataCacheOp<T>[]): Promise<void>
  /** Makes the scope hold exactly `items`, in one transaction. */
  replace(scope: string, items: readonly T[]): Promise<void>
  /** Adds the item, or replaces the one with the same id. */
  put(scope: string, item: T): Promise<void>
  /** Removes one item. Does nothing when it is not there. */
  delete(scope: string, id: string): Promise<void>
  /** Removes every item of the scope. Other scopes stay. */
  clear(scope: string): Promise<void>
  /** Removes every item of every scope, for example at sign-out. */
  clearAll(): Promise<void>
}

const ITEMS = "items"
const BY_SCOPE = "byScope"

interface Row<T> {
  scope: string
  id: string
  /** Place in the scope: ascending, not necessarily without gaps. */
  position: number
  item: T
}

/** What a transaction knows of one scope: where each item sits, and the next free place. */
interface ScopePlaces {
  positions: Map<string, number>
  next: number
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
   * IndexedDB requests of this transaction and nothing else, or the transaction commits early. If
   * it throws, the transaction is aborted and nothing is written.
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

  /** Deletes every item of the scope inside the transaction of `items`. */
  async function deleteScope(items: IDBObjectStore, scope: string): Promise<void> {
    const keys = await idbRequest(items.index(BY_SCOPE).getAllKeys(scope))
    for (const key of keys) items.delete(key)
  }

  async function applyAll(store: IDBObjectStore, ops: readonly DataCacheOp<T>[]): Promise<void> {
    const places = new Map<string, ScopePlaces>()
    /** Reads a scope's places once per transaction, and keeps them current as steps apply. */
    async function placesOf(scope: string): Promise<ScopePlaces> {
      let found = places.get(scope)
      if (!found) {
        const rows = await idbRequest(store.index(BY_SCOPE).getAll(scope)) as Row<T>[]
        found = { positions: new Map(), next: 0 }
        for (const row of rows) {
          found.positions.set(row.id, row.position)
          found.next = Math.max(found.next, row.position + 1)
        }
        places.set(scope, found)
      }
      return found
    }
    const emptied = (scope: string) => places.set(scope, { positions: new Map(), next: 0 })
    for (const step of ops) {
      if (step.op === "put") {
        const id = options.getId(step.item)
        const scope = await placesOf(step.scope)
        const position = scope.positions.get(id) ?? scope.next++
        scope.positions.set(id, position)
        store.put({ scope: step.scope, id, position, item: step.item } satisfies Row<T>)
      } else if (step.op === "delete") {
        store.delete([step.scope, step.id])
        places.get(step.scope)?.positions.delete(step.id)
      } else if (step.op === "replace") {
        await deleteScope(store, step.scope)
        emptied(step.scope)
        const scope = places.get(step.scope)!
        for (const item of step.items) {
          const id = options.getId(item)
          const position = scope.positions.get(id) ?? scope.next++
          scope.positions.set(id, position)
          store.put({ scope: step.scope, id, position, item } satisfies Row<T>)
        }
      } else {
        await deleteScope(store, step.scope)
        emptied(step.scope)
      }
    }
  }

  const batch = (ops: readonly DataCacheOp<T>[]) => write((store) => applyAll(store, ops))

  return {
    async read(scope) {
      const db = await open()
      const rows = await idbRequest(
        db.transaction(ITEMS).objectStore(ITEMS).index(BY_SCOPE).getAll(scope),
      ) as Row<T>[]
      return rows.sort((a, b) => a.position - b.position).map((r) => r.item)
    },
    async get(scope, id) {
      const db = await open()
      const found = await idbRequest(
        db.transaction(ITEMS).objectStore(ITEMS).get([scope, id]),
      ) as Row<T> | undefined
      return found?.item
    },
    async scopes() {
      const db = await open()
      const cursor = db.transaction(ITEMS).objectStore(ITEMS).index(BY_SCOPE)
        .openKeyCursor(null, "nextunique")
      return await new Promise<string[]>((resolve, reject) => {
        const found: string[] = []
        cursor.onsuccess = () => {
          const at = cursor.result
          if (!at) return resolve(found)
          found.push(at.key as string)
          at.continue()
        }
        cursor.onerror = () => reject(cursor.error)
      })
    },
    batch,
    replace: (scope, items) => batch([{ op: "replace", scope, items }]),
    put: (scope, item) => batch([{ op: "put", scope, item }]),
    delete: (scope, id) => batch([{ op: "delete", scope, id }]),
    clear: (scope) => batch([{ op: "clear", scope }]),
    clearAll: () => write((store) => void store.clear()),
  }
}
