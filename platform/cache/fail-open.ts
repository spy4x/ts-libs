/**
 * A cache storage that never fails a request while the cache server is down, and distrusts the
 * cache until it has been cleared.
 *
 * @module
 */

import type { ICacheStorage } from "./cache.ts"

/** A cache operation {@link failOpen} reports on. */
export type CacheOperation = "get" | "set" | "del" | "reset"

/** Called with the operation and the error whenever a cache operation fails. */
export type CacheErrorReporter = (operation: CacheOperation, error: unknown) => void

/** How long an untrusted cache waits before the next attempt to clear itself. */
export const DEFAULT_CACHE_RECOVERY_MS = 5_000

/**
 * Wraps `storage` so an outage of the cache server never fails a request: while it is down every
 * read is a miss (the database answers) and every write is skipped.
 *
 * The cache starts untrusted too, because the server may hold stale rows from before this process
 * started. A skipped write is the danger: the row changes in the database, and when the cache
 * server returns with its old data (a restart from a snapshot, a network break) the stale row would
 * be served. So the first failed operation marks the whole cache untrusted. While untrusted, `get`
 * misses and `set` and `del` do nothing, none of them touching the server. Trust returns only after
 * a `reset()` succeeds, which removes every key this storage holds; it is retried at most once per
 * `retryMs`, on the next operation, so no timer is left running. Concurrent operations share one
 * attempt.
 *
 * `reset()` of the returned storage is passed through unchanged: it throws when the server is down,
 * and does not change the trust state.
 *
 * @param storage The real storage.
 * @param onError Called for every failure, with the operation that failed. It must not throw.
 * @param retryMs Minimum time between two attempts to clear an untrusted cache.
 * @param now The clock in milliseconds; inject it in a test.
 */
export function failOpen(
  storage: ICacheStorage,
  onError: CacheErrorReporter,
  retryMs: number = DEFAULT_CACHE_RECOVERY_MS,
  now: () => number = Date.now,
): ICacheStorage {
  let trusted = false
  let nextAttemptAt = 0
  let recovery: Promise<void> | null = null

  const distrust = (operation: CacheOperation, error: unknown) => {
    trusted = false
    nextAttemptAt = now() + retryMs
    onError(operation, error)
  }

  /** Tries to clear the cache when untrusted and due; resolves when the attempt is over. */
  const tryRecover = async (): Promise<void> => {
    if (trusted || now() < nextAttemptAt) return
    // A storage whose reset() throws instead of rejecting must not fail the request either.
    recovery ??= Promise.resolve().then(() => storage.reset()).then(
      () => {
        trusted = true
      },
      (error) => distrust("reset", error),
    ).finally(() => {
      recovery = null
    })
    await recovery
  }

  return {
    async get(key) {
      await tryRecover()
      if (!trusted) return null
      try {
        return await storage.get(key)
      } catch (error) {
        distrust("get", error)
        return null
      }
    },
    async set(key, value, ttlSec) {
      await tryRecover()
      if (!trusted) return
      try {
        await storage.set(key, value, ttlSec)
      } catch (error) {
        distrust("set", error)
      }
    },
    async del(key) {
      await tryRecover()
      if (!trusted) return
      try {
        await storage.del(key)
      } catch (error) {
        distrust("del", error)
      }
    },
    reset: () => storage.reset(),
  }
}
