/**
 * A read cache in front of any list read: every answer from the server is kept on the device, and
 * a read that cannot reach the server answers from that copy, with the time it was taken. It is
 * the "offline-readable" level of ADR 003.
 *
 * - {@link cachedRead} asks the server, keeps the answer and returns it as fresh. When the server
 *   is unreachable (`ConnectionLostError`, or the `TypeError` a failed `fetch` rejects with) it
 *   returns the copy instead, or throws the connection error when there is none. Any other error,
 *   `unauthorized` and `forbidden` included, is thrown and leaves the copy alone: a refused read
 *   never replaces the copy and never returns it.
 * - {@link readCopy} returns the copy alone, at once, so a screen paints before the server answers.
 * - With no cache (`undefined`) {@link cachedRead} only calls `read`: one code path for a store
 *   whether the app has local data or not, and nothing is written to IndexedDB.
 * - {@link ReadCache.clear} deletes every copy of the user. One cache per user: name its database
 *   for the user and clear it at sign-out, and at a start that finds no session.
 *
 * The cache holds server state only. Values must be structured-cloneable. Writes made offline wait
 * in the outbox (`@spy4x/realtime/outbox`), and the app layers them on top of what a read returns.
 *
 * @module
 */

import { createDataCache } from "@spy4x/platform/browser/data-cache"
import { type Clock, createSystemClock } from "./clock.ts"
import { ConnectionLostError } from "./client-transport.ts"

/** What a read answered, and how old it is. */
export interface ReadResult<T> {
  value: T
  /** `true` when the server answered just now, `false` when `value` is a saved copy. */
  fresh: boolean
  /** Epoch milliseconds when `value` was taken from the server. For a fresh answer: now. */
  savedAt: number
}

/** Options of {@link createReadCache}. */
export interface ReadCacheOptions {
  /** The database name, for example `reads:${userId}`. One database per user. */
  name: string
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
  /** The time source for `savedAt`. Defaults to the system clock. */
  clock?: Pick<Clock, "now">
}

/** The copies of one user: see the module documentation. */
export interface ReadCache {
  /** The copy kept under `key` and when it was taken, or `undefined` when there is none. */
  get<T>(key: string): Promise<{ value: T; savedAt: number } | undefined>
  /** Keeps `value` as the copy under `key`, replacing the one there, taken now. Returns the time. */
  set<T>(key: string, value: T): Promise<number>
  /**
   * Deletes every copy of this user. Another user's database is not touched. The instance is
   * finished after this: `set` stores nothing more, so a read still in flight cannot write its
   * answer back. A new user needs a new cache.
   */
  clear(): Promise<void>
}

interface Entry {
  key: string
  savedAt: number
  value: unknown
}

const SCOPE = "reads"

/** A read cache over IndexedDB (`createDataCache`), one entry per key. */
export function createReadCache(options: ReadCacheOptions): ReadCache {
  const clock = options.clock ?? createSystemClock()
  const store = createDataCache<Entry>({
    name: options.name,
    getId: (entry) => entry.key,
    indexedDB: options.indexedDB,
  })
  let cleared = false
  return {
    async get<T>(key: string) {
      const entry = await store.get(SCOPE, key)
      return entry ? { value: entry.value as T, savedAt: entry.savedAt } : undefined
    },
    async set(key, value) {
      const savedAt = clock.now()
      if (cleared) return savedAt
      await store.put(SCOPE, { key, savedAt, value })
      return savedAt
    },
    clear() {
      cleared = true
      return store.clearAll()
    },
  }
}

/** Whether a failure means the server could not be reached, as opposed to it having answered. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ConnectionLostError || error instanceof TypeError
}

/**
 * Returns the saved copy under `key`, or `undefined` when there is none, the cache is `undefined`
 * or the device cannot read it. Never rejects: a screen calls it only to paint early.
 */
export async function readCopy<T>(
  cache: ReadCache | undefined,
  key: string,
): Promise<ReadResult<T> | undefined> {
  if (!cache) return undefined
  try {
    const found = await cache.get<T>(key)
    return found && { value: found.value, fresh: false, savedAt: found.savedAt }
  } catch {
    return undefined
  }
}

/**
 * Asks the server with `read`, keeps the answer under `key` and returns it as fresh. When the
 * server is unreachable it returns the copy (`fresh: false`), or throws the connection error when
 * there is no copy. Any other error is thrown and the copy is left as it was.
 *
 * A device that cannot save (storage blocked, disk full) does not fail the read: the answer is
 * returned and the copy stays as it was. With no `cache` this only calls `read`.
 */
export async function cachedRead<T>(
  cache: ReadCache | undefined,
  key: string,
  read: () => Promise<T>,
): Promise<ReadResult<T>> {
  let value: T
  try {
    value = await read()
  } catch (error) {
    if (!cache || !isUnreachable(error)) throw error
    const copy = await readCopy<T>(cache, key)
    if (copy) return copy
    throw error
  }
  if (!cache) return { value, fresh: true, savedAt: Date.now() }
  let savedAt = Date.now()
  try {
    savedAt = await cache.set(key, value)
  } catch {
    // The answer is good; only the copy is lost.
  }
  return { value, fresh: true, savedAt }
}
