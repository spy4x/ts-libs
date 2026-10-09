/**
 * A durable copy of CalDAV calendars and their objects in IndexedDB, for browser apps. It satisfies
 * {@link CalDavSyncStore} from `@spy4x/caldav/sync` and adds the reads and single-object writes an
 * app needs around a sync run. It has no framework, signals or wording of its own.
 *
 * Layout: calendars are keyed by `href`; objects are keyed by `href` and indexed by
 * `calendarHref`. The cached object type is generic, so an app can keep parsed fields next to the
 * raw iCalendar text.
 *
 * The default database name is `caldav-cache`, not `caldav-tasks`. An app that used to keep its
 * cache in Dexie may still have a `caldav-tasks` database at a higher IndexedDB version, and
 * opening it at version 1 would fail. A fresh name sidesteps that; the old database stays unused
 * (an app can delete it with `indexedDB.deleteDatabase`). The cache is only a copy of the
 * server, so rebuilding it costs one sync. A database of the same name that holds other object
 * stores (an older schema) is upgraded by dropping those stores and creating this layout, without
 * throwing.
 *
 * @module
 */

import {
  createDatabaseOpener,
  idbRequest,
  idbTransactionDone,
} from "@spy4x/platform/browser/indexeddb"
import type {
  CalDavSyncStore,
  StoredCalendar,
  SyncCalendar,
  SyncChanges,
  SyncObject,
  SyncObjectVersion,
} from "./sync.ts"

/** The part of a cached object the store reads. Extra fields are kept untouched. */
export interface CachedObject {
  /** The object's address, its key. */
  href: string
  /** The address of the calendar it belongs to; indexed. */
  calendarHref: string
  /** The version it was fetched at, as {@link SyncObject.etag}. */
  etag: string | null
}

/** Options of {@link createIndexedDbCalDavCache}. */
export interface IndexedDbCalDavCacheOptions {
  /** The database name. Defaults to `caldav-cache`. One per user when the data belongs to one. */
  name?: string
  /** The schema version. Defaults to 1. Raising it empties the cache. */
  version?: number
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
}

/** Options for a cache of a richer object type: it must say how to build one. */
export interface IndexedDbCalDavCacheCustomOptions<T extends CachedObject>
  extends IndexedDbCalDavCacheOptions {
  /**
   * Builds the cached object for an object a sync run delivers, for example by parsing its `ics`.
   * It must set `calendarHref`.
   */
  fromSyncObject: (object: SyncObject, calendarHref: string) => T
}

/** Thrown when the cache cannot be opened: IndexedDB missing, blocked or refused (private window). */
export class IndexedDbUnavailableError extends Error {
  override name = `IndexedDbUnavailableError`
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** A calendar and object cache over IndexedDB. */
export interface IndexedDbCalDavCache<
  C extends SyncCalendar = SyncCalendar,
  T extends CachedObject = CachedObject & SyncObject,
> extends CalDavSyncStore<C> {
  /** Every cached object, of every calendar. */
  listObjects(): Promise<T[]>
  /** Every cached object of one calendar. */
  listObjects(calendarHref: string): Promise<T[]>
  /** Stores one object, replacing the one with the same `href`. */
  putObject(object: T): Promise<void>
  /** Removes one object. A missing `href` is not an error. */
  deleteObject(href: string): Promise<void>
  /** Closes the connection. Later calls open a new one. */
  close(): void
}

const CALENDARS = `calendars`
const OBJECTS = `objects`
const BY_CALENDAR = `calendarHref`

/**
 * Creates the cache. Nothing is opened until the first call. A call rejects with
 * {@link IndexedDbUnavailableError} when storage cannot be opened, and the next call tries again.
 */
export function createIndexedDbCalDavCache<C extends SyncCalendar = SyncCalendar>(
  options?: IndexedDbCalDavCacheOptions,
): IndexedDbCalDavCache<C, CachedObject & SyncObject>
/** With a cached object type of your own, `fromSyncObject` is required. */
export function createIndexedDbCalDavCache<C extends SyncCalendar, T extends CachedObject>(
  options: IndexedDbCalDavCacheCustomOptions<T>,
): IndexedDbCalDavCache<C, T>
export function createIndexedDbCalDavCache<C extends SyncCalendar, T extends CachedObject>(
  options: IndexedDbCalDavCacheOptions & {
    fromSyncObject?: (object: SyncObject, calendarHref: string) => T
  } = {},
): IndexedDbCalDavCache<C, T> {
  const name = options.name ?? `caldav-cache`
  const fromSyncObject = options.fromSyncObject ??
    ((object: SyncObject, calendarHref: string) => ({ ...object, calendarHref }) as unknown as T)
  const makeOpener = () =>
    createDatabaseOpener({
      name,
      version: options.version ?? 1,
      indexedDB: options.indexedDB,
      upgrade(db) {
        for (const existing of Array.from(db.objectStoreNames)) db.deleteObjectStore(existing)
        db.createObjectStore(CALENDARS, { keyPath: `href` })
        db.createObjectStore(OBJECTS, { keyPath: `href` }).createIndex(BY_CALENDAR, BY_CALENDAR)
      },
    })
  let openRaw = makeOpener()
  let connection: IDBDatabase | undefined
  const open = async (): Promise<IDBDatabase> => {
    try {
      return connection = await openRaw()
    } catch (cause) {
      throw new IndexedDbUnavailableError(
        `Cannot open the CalDAV cache "${name}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      )
    }
  }

  /** Runs `work` in one readwrite transaction over both stores and waits for the commit. */
  const write = async (
    work: (calendars: IDBObjectStore, objects: IDBObjectStore) => Promise<void> | void,
  ): Promise<void> => {
    const db = await open()
    const transaction = db.transaction([CALENDARS, OBJECTS], `readwrite`)
    const done = idbTransactionDone(transaction)
    try {
      await work(transaction.objectStore(CALENDARS), transaction.objectStore(OBJECTS))
    } catch (error) {
      try {
        transaction.abort()
      } catch { /* already finished */ }
      await done.catch(() => {})
      throw error
    }
    await done
  }

  const keysOfCalendar = (objects: IDBObjectStore, calendarHref: string) =>
    idbRequest(objects.index(BY_CALENDAR).getAllKeys(calendarHref))

  return {
    async listCalendars() {
      const db = await open()
      return await idbRequest(
        db.transaction(CALENDARS).objectStore(CALENDARS).getAll(),
      ) as StoredCalendar<C>[]
    },
    async listObjects(calendarHref?: string) {
      const db = await open()
      const objects = db.transaction(OBJECTS).objectStore(OBJECTS)
      return await idbRequest(
        calendarHref === undefined
          ? objects.getAll()
          : objects.index(BY_CALENDAR).getAll(calendarHref),
      ) as T[]
    },
    async listVersions(calendarHref): Promise<SyncObjectVersion[]> {
      const db = await open()
      const found = await idbRequest(
        db.transaction(OBJECTS).objectStore(OBJECTS).index(BY_CALENDAR)
          .getAll(calendarHref),
      ) as T[]
      return found.map(({ href, etag }) => ({ href, etag }))
    },
    replaceCalendars(calendars) {
      return write(async (calendarStore, objectStore) => {
        const keep = new Set(calendars.map((calendar) => calendar.href))
        const stored = await idbRequest(calendarStore.getAllKeys()) as string[]
        for (const href of stored) {
          if (keep.has(href)) continue
          for (const key of await keysOfCalendar(objectStore, href)) objectStore.delete(key)
          calendarStore.delete(href)
        }
        for (const calendar of calendars) calendarStore.put(calendar)
      })
    },
    applyChanges(calendar: StoredCalendar<C>, changes: SyncChanges) {
      return write((calendarStore, objectStore) => {
        for (const href of changes.remove) objectStore.delete(href)
        for (const object of changes.upsert) {
          objectStore.put(fromSyncObject(object, calendar.href))
        }
        calendarStore.put(calendar)
      })
    },
    async putObject(object) {
      const db = await open()
      const transaction = db.transaction(OBJECTS, `readwrite`)
      const done = idbTransactionDone(transaction)
      transaction.objectStore(OBJECTS).put(object)
      await done
    },
    async deleteObject(href) {
      const db = await open()
      const transaction = db.transaction(OBJECTS, `readwrite`)
      const done = idbTransactionDone(transaction)
      transaction.objectStore(OBJECTS).delete(href)
      await done
    },
    close() {
      connection?.close()
      connection = undefined
      // An explicit close does not tell the opener, which would hand out the closed connection.
      openRaw = makeOpener()
    },
  }
}
