/**
 * The few IndexedDB plumbing pieces every durable browser store needs: a lazily opened database,
 * and promises for a request and for a transaction. The stores built on them
 * (`browser/data-cache`, `@spy4x/realtime/outbox-indexeddb`) hold the schema and the queries.
 *
 * Nothing touches a global at import time: the factory is a parameter, defaulting to
 * `globalThis.indexedDB` only when a database is opened.
 *
 * @module
 */

/** How to open one database. */
export interface DatabaseSpec {
  /** The database name; one per user when the data belongs to a user. */
  name: string
  /** The schema version. Raise it when `upgrade` changes. */
  version: number
  /** Creates or migrates the object stores. Runs inside the version-change transaction. */
  upgrade(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction): void
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
}

/**
 * Returns a function that opens the database on first use and returns the same connection after.
 *
 * Opening fails loudly (private windows, blocked site data and an open blocked by another tab's
 * older connection all reject) and the next call tries again, so a store recovers when the browser allows storage later. When another tab upgrades the
 * database, or the browser closes the connection, the next call opens a fresh one.
 */
export function createDatabaseOpener(spec: DatabaseSpec): () => Promise<IDBDatabase> {
  let opened: Promise<IDBDatabase> | undefined
  return () => {
    if (opened) return opened
    const factory = spec.indexedDB ?? globalThis.indexedDB
    if (!factory) {
      return Promise.reject(new Error(`IndexedDB is not available, cannot open "${spec.name}"`))
    }
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false
      const request = factory.open(spec.name, spec.version)
      request.onupgradeneeded = (event) =>
        spec.upgrade(request.result, event.oldVersion, request.transaction!)
      request.onsuccess = () => {
        const db = request.result
        if (blocked) {
          // The caller was already told it failed; do not keep a connection nobody holds.
          db.close()
          return
        }
        const forget = () => {
          if (opened === attempt) opened = undefined
        }
        db.onversionchange = () => {
          db.close()
          forget()
        }
        db.onclose = forget
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      // Another tab holds an older version open and did not close it. Waiting could stall every
      // caller for good (the outbox opens its store inside its lock), so fail and let the next
      // call try again.
      request.onblocked = () => {
        blocked = true
        reject(new Error(`Opening "${spec.name}" is blocked by a tab that holds an older version`))
      }
    })
    opened = attempt
    attempt.catch(() => {
      if (opened === attempt) opened = undefined
    })
    return attempt
  }
}

/** Resolves a request's result, or rejects with its error. */
export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Resolves when a transaction has committed, rejects when it aborts or fails. */
export function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error(`Transaction aborted`))
  })
  // A caller that awaits a failed request first never reaches `done`: do not report it unhandled.
  done.catch(() => {})
  return done
}
