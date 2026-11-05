/**
 * A read cache in front of any list read: every answer from the server is kept on the device, and
 * a read that cannot reach the server answers from that copy, with the time it was taken. It is
 * the "offline-readable" level of ADR 003.
 *
 * - {@link cachedRead} asks the server, keeps the answer and returns it as fresh. When the server
 *   is unreachable (`ConnectionLostError`, a `RequestTimeoutError`, or the `TypeError` a failed
 *   `fetch` rejects with) it returns the copy instead, or throws the connection error when there
 *   is none. Any other error, `unauthorized` and `forbidden` included, is thrown and leaves the
 *   copy alone: a refused read never replaces the copy and never returns it.
 * - {@link readCopy} returns the copy alone, at once, so a screen paints before the server answers.
 * - With no cache (`undefined`) {@link cachedRead} only calls `read`: one code path for a store
 *   whether the app has local data or not, and nothing is written to IndexedDB.
 * - {@link ReadCache.clear} deletes every copy of the user. One cache per user: name its database
 *   for the user and clear it at sign-out, and at a start that finds no session.
 * - {@link createLocalReads} puts the rules a screen needs on top: a proxy's answer is treated as
 *   an unreachable server, a refusal ({@link isRefusal}) deletes the copy, and a copy painted early
 *   is taken back when the server then refuses the read. REST readers throw {@link ReadRefused}
 *   for an answer that is not `ok`, so these rules can tell the answers apart.
 *
 * The cache holds server state only. Values must be structured-cloneable. Writes made offline wait
 * in the outbox (`@spy4x/realtime/outbox`), and the app layers them on top of what a read returns.
 *
 * The offline-readable level of ADR 003: a copy of a list read, kept on the device, that answers when
 * the server cannot be reached. One cache per signed-in user, over `createDataCache`.
 *
 * ```ts
 * import { cachedRead, createReadCache, readCopy } from "@spy4x/realtime/read-cache"
 *
 * const cache = createReadCache({ name: `reads:${userId}` }) // or undefined: no local data
 *
 * const copy = await readCopy<Group[]>(cache, `groups`) // paint at once; undefined when none
 * const { value, fresh, savedAt } = await cachedRead(cache, `groups`, () => fetchGroups())
 * // fresh: the server answered now. Not fresh: a copy taken at `savedAt` (epoch ms).
 *
 * await cache.delete(`groups`) // the server refused this read: drop only that list's copy
 * await cache.clear() // sign-out, or a start that finds no session: every copy of this user
 * ```
 *
 * - Every answer replaces the copy under its key. A read that cannot reach the server
 *   (`ConnectionLostError`, a `RequestTimeoutError`, or the `TypeError` a failed `fetch` rejects with)
 *   answers from the copy,
 *   or throws the connection error when there is none. A `TypeError` thrown by your own `read`
 *   function counts as unreachable too.
 * - `delete(key)` removes one copy and leaves the rest; it does nothing when there is none.
 *   `createMemoryReadCache()` from `@spy4x/realtime/testing` is an in-memory `ReadCache` for tests
 *   (no IndexedDB); it keeps the same rule that nothing is saved after `clear`. A custom `ReadCache`
 *   must now implement `delete`.
 * - `clear()` finishes the instance: it stores nothing more, so a read still in flight at sign-out
 *   cannot write its answer back. A new user needs a new cache.
 * - Any other error is thrown and the copy stays. `unauthorized` and `forbidden` therefore neither
 *   return nor replace it.
 * - A device that cannot save does not fail the read; the answer is returned and the copy is not
 *   updated. `readCopy` never rejects.
 * - `cachedRead(undefined, key, read)` only calls `read`, so a store has one code path and an app
 *   without local data touches no IndexedDB.
 * - Run the full read inside `read` (all pages), so the copy is the whole list. Search and filters
 *   then run over the list the store holds. `cache.get` / `cache.set` let a layer on top (the
 *   offline-writable collection) read and update a copy directly.
 *
 * ## Local reads: the rules a screen needs
 *
 * `createLocalReads` wraps `cachedRead` with the rules a store follows when a read is refused, so an
 * app does not write them again:
 *
 * ```ts
 * import { createLocalReads, ReadRefused } from "@spy4x/realtime/read-cache"
 *
 * const reads = createLocalReads(() => currentUserCache) // undefined: no local data, nothing kept
 *
 * async function fetchGroups(): Promise<Group[]> {
 *   const response = await fetch(`/api/groups`)
 *   const body = await response.json().catch(() => null)
 *   if (!response.ok) {
 *     throw new ReadRefused(
 *       body?.error?.message ?? `Request failed`,
 *       response.status,
 *       body?.error?.code,
 *     )
 *   }
 *   return body.groups
 * }
 *
 * const { value, fresh, savedAt } = await reads.through(`groups`, fetchGroups, (copy) => {
 *   if (groups.value.length) return false // a list is on screen already: do not paint the copy
 *   groups.value = copy?.value ?? [] // the copy before the answer; `undefined` takes it back
 * })
 * ```
 *
 * - A REST reader throws `ReadRefused(failure, status, code)` for an answer that is not `ok`, so the
 *   answer is neither kept nor hidden behind the copy.
 * - `isProxyAnswer(error)`: a `ReadRefused` that `isForeignAnswer` takes for the proxy's (a 5xx, a
 *   404 or a 429 without an error code). `through` answers it from the copy, as with no network.
 * - `isRefusal(error)`: the server refuses this person the list. A 401 or 403, a 404 with a code, or a
 *   socket read refused `unauthorized`, `forbidden` or `not_found`. `through` deletes the copy, so it
 *   is not shown offline later. Any other error (a 500 with a code) is thrown and the copy stays.
 * - `early` is given the copy only before the server has answered. When the read then rejects,
 *   `early` is called once more with `undefined` to take back what it painted, unless it returned
 *   `false` (it painted nothing).
 * - `current` is asked at every read, so the reads follow the signed-in user's cache.
 *
 * @module
 */

import { createDataCache } from "@spy4x/platform/browser/data-cache"
import { createSystemClock, type TimerClock } from "./clock.ts"
import { isForeignAnswer } from "./calls.ts"
import { ConnectionLostError, RequestTimeoutError } from "./client-transport.ts"
import { RealtimeRequestError } from "./errors.ts"

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
  clock?: Pick<TimerClock, "now">
}

/** The copies of one user: see the module documentation. */
export interface ReadCache {
  /** The copy kept under `key` and when it was taken, or `undefined` when there is none. */
  get<T>(key: string): Promise<{ value: T; savedAt: number } | undefined>
  /** Keeps `value` as the copy under `key`, replacing the one there, taken now. Returns the time. */
  set<T>(key: string, value: T): Promise<number>
  /**
   * Deletes the copy under `key`, for example when the server refused that read and the saved
   * list must not be shown again. Other keys stay. Does nothing when there is no copy. A
   * `cachedRead` of the same key that is still in flight saves its answer after this delete, so a
   * copy can come back when an earlier read answers late.
   */
  delete(key: string): Promise<void>
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
  return {
    async get<T>(key: string) {
      const entry = await store.get(SCOPE, key)
      return entry ? { value: entry.value as T, savedAt: entry.savedAt } : undefined
    },
    async set(key, value) {
      const savedAt = clock.now()
      await store.put(SCOPE, { key, savedAt, value })
      return savedAt
    },
    delete: (key) => store.delete(SCOPE, key),
    clear: () => store.finish(),
  }
}

/** Whether a failure means the server could not be reached, as opposed to it having answered. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ConnectionLostError || error instanceof RequestTimeoutError ||
    error instanceof TypeError
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

/**
 * Carries an answer of the server that is not the list out of a REST read, so a read through
 * {@link LocalReads} neither keeps it nor hides it behind the copy. `status` is the HTTP status and
 * `code` the error code of the body, absent when the answer carried none. A `failure` that is a
 * string is the message of the error.
 *
 * - 401, 403, and a 404 with a code: the server refuses this person the list ({@link isRefusal}),
 *   and the device deletes its copy.
 * - A 5xx, a 404 or a 429 without a code: taken for an answer of the proxy in front of the API
 *   ({@link isProxyAnswer}), and the copy answers it, as it does with no network.
 * - Anything else, such as a 500 with a code: the server is struggling. The error shows and the
 *   copy stays.
 */
export class ReadRefused<F> extends Error {
  constructor(readonly failure: F, readonly status: number, readonly code?: string | null) {
    super(typeof failure === "string" ? failure : "The server refused the read")
    this.name = "ReadRefused"
  }
}

const REFUSING_STATUSES = [401, 403, 404]

/**
 * Whether a REST read's answer is taken for a proxy's, such as a 502 during a deploy: a
 * {@link ReadRefused} that `isForeignAnswer` (`@spy4x/realtime/calls`) takes for foreign. The
 * API's own answers without an error code (a rate limit's 429, an unhandled error's 500) count too.
 */
export function isProxyAnswer(error: unknown): boolean {
  return error instanceof ReadRefused && isForeignAnswer(error.status, error.code)
}

/**
 * Whether the server answered that this person may not read the list, or that it is gone: a
 * socket read refused with `unauthorized`, `forbidden` or `not_found`, or a REST read answered 401,
 * 403 or 404. Any other failure, such as a 500 or a timeout, says nothing about access, and neither
 * does a 404 without an error code, which is taken for a proxy's.
 */
export function isRefusal(error: unknown): boolean {
  if (error instanceof ReadRefused) {
    return REFUSING_STATUSES.includes(error.status) && !isProxyAnswer(error)
  }
  return error instanceof RealtimeRequestError &&
    (error.code === "unauthorized" || error.code === "forbidden" || error.code === "not_found")
}

/**
 * The read copies of the offline-readable lists, as a store uses them. A store reads its list
 * `through` a key: the answer replaces the device's copy, and when the server is unreachable the
 * copy answers instead (`fresh: false`, with the time it was taken). `copy` is the copy alone, for
 * a screen to show before the server has answered.
 */
export interface LocalReads {
  /**
   * Rejects as `read` does, except when the server is unreachable and a copy exists. Unreachable
   * is no connection, and also an answer {@link isProxyAnswer} takes for a proxy's: a 5xx, a 404 or
   * a 429 without an error code, as while the API is replaced. A {@link isRefusal refusal} deletes
   * the copy.
   *
   * `early` is given the copy when the device has one before the server has answered, so a screen
   * with nothing to show paints it first; it is never given a copy after the answer. When the read
   * then rejects, `early` is called once more with `undefined`: the screen takes back what it
   * painted, so a refusal is never read next to a list the person may no longer see. A screen that
   * did not paint the copy (it had a list already) returns `false`, and is not asked to take
   * anything back.
   */
  through<T>(
    key: string,
    read: () => Promise<T>,
    early?: (copy: ReadResult<T> | undefined) => boolean | void,
  ): Promise<ReadResult<T>>
  /** The copy under `key`, or `undefined`. Never rejects. */
  copy<T>(key: string): Promise<ReadResult<T> | undefined>
}

/** Deletes the saved copy of a list the server refused, so it is not shown again offline. */
async function dropCopy(cache: ReadCache, key: string): Promise<void> {
  try {
    await cache.delete(key)
  } catch {
    // The device cannot delete; the refusal is still what the caller sees.
  }
}

/**
 * {@link LocalReads} over the cache `current` names at the moment of each read, or over none. An
 * app passes a function that returns the signed-in user's cache, or `undefined` while nobody is
 * signed in or the app keeps no local data: then every read goes to the server and nothing is kept.
 */
export function createLocalReads(current: () => ReadCache | undefined): LocalReads {
  return {
    async through<T>(
      key: string,
      read: () => Promise<T>,
      early?: (copy: ReadResult<T> | undefined) => boolean | void,
    ) {
      const cache = current()
      let answered = false
      let painted = false
      if (early && cache) {
        void readCopy<T>(cache, key).then((copy) => {
          if (!copy || answered) return
          painted = early(copy) !== false
        })
      }
      try {
        return await cachedRead(cache, key, read)
      } catch (refusal) {
        // A proxy's answer is an unreachable server too: the copy answers it, when there is one.
        if (cache && isProxyAnswer(refusal)) {
          const copy = await readCopy<T>(cache, key)
          if (copy) return copy
        }
        // An unreachable server is answered by the copy, so this is the server saying no.
        if (painted) early?.(undefined)
        if (cache && isRefusal(refusal)) await dropCopy(cache, key)
        throw refusal
      } finally {
        answered = true
      }
    },
    copy: (key) => readCopy(current(), key),
  }
}
