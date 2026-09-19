/**
 * A time-to-live cache with two fixes applied at extraction time.
 *
 * **Unit mismatch.** The source (`roley/src/lib/server/cache.ts:23,36`) read its
 * TTL options in seconds and wrote `ttl * 1000` into a store whose own default
 * came from `ONE_WEEK_AS_MS`. Every caller therefore handed the store a
 * millisecond value that was then multiplied by 1000 again: a week-long entry
 * lived about 19 years, and so did every cached session and permission check.
 * Here the unit is milliseconds at every boundary — option, store call and
 * default constant — and `CacheItemsEntry.ttlMs` is named so a caller cannot
 * mistake which one it is passing. There is no multiplication anywhere in this
 * file.
 *
 * **Falsy read path.** The source tested `if (fromCache)` (`:38`), so a cached
 * `0`, `false`, `""` or `null` was discarded and the wrapped function recomputed
 * on every call — a cache that silently never caches the one value a permission
 * check is most likely to produce. A miss is `undefined` and only `undefined`;
 * everything else is a hit.
 *
 * The clock is injected, so "expired" is decided by the caller's clock and a
 * test can advance time instead of sleeping.
 */

/** Milliseconds. Named into the API so a seconds value cannot be passed by accident. */
export type DurationMs = number

/** Epoch milliseconds. */
export type Clock = () => number

/** Values a caller may store. `undefined` is the miss marker and is never stored. */
export type CacheValue = string | number | boolean | object | null

/** A TTL store. `ttlMs` is in milliseconds. */
export interface CacheStore {
  get(key: string): Promise<CacheValue | undefined>
  set(key: string, value: CacheValue, ttlMs: DurationMs): Promise<void>
  delete(key: string): Promise<void>
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Default TTL for an entry set without an explicit one. */
export const DEFAULT_TTL_MS: DurationMs = FIVE_MINUTES_MS

/** Visibility of an entry, so a shared HTTP cache knows whether to split by user. */
export enum CacheAccess {
  Public = 1,
  Private = 2,
}

/** One registered cache key: its name builder, its TTL and its visibility. */
export interface CacheItemsEntry {
  key: string | ((argument: never) => string)
  ttlMs: DurationMs
  permission: CacheAccess
}

/** In-process store. One instance per process; unbounded, so entries must always carry a TTL. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: CacheValue; expiresAt: number }>()

  constructor(private readonly now: Clock = Date.now) {}

  get(key: string): Promise<CacheValue | undefined> {
    const entry = this.entries.get(key)
    if (!entry) {
      return Promise.resolve(undefined)
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return Promise.resolve(undefined)
    }
    return Promise.resolve(entry.value)
  }

  set(key: string, value: CacheValue, ttlMs: DurationMs): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`ttlMs must be a positive finite number of milliseconds, got ${ttlMs}`)
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key)
    return Promise.resolve()
  }

  /** Drop every entry. Used by tests and by an admin "invalidate all" action. */
  reset(): void {
    this.entries.clear()
  }
}

/**
 * A TTL cache over an injected store.
 *
 * `wrap` recomputes only on a miss, and only writes when the result is not
 * `undefined`. Pass `shouldCacheFalsy: false` to deliberately leave a nullish or
 * empty result uncached — an explicit choice, not the accidental behaviour the
 * source had.
 */
export class TenantCache {
  constructor(
    private readonly store: CacheStore,
    private readonly defaultTtlMs: DurationMs = DEFAULT_TTL_MS,
  ) {}

  async get<T>(key: string): Promise<undefined | T> {
    return (await this.store.get(key)) as undefined | T
  }

  async set<T>(key: string, value: T, ttlMs: DurationMs = this.defaultTtlMs): Promise<void> {
    await this.store.set(key, value as CacheValue, ttlMs)
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key)
  }

  /**
   * Return the cached value for `key`, or compute, store and return it.
   *
   * A cached value is returned whenever the store has an entry, including a
   * falsy one: `undefined` alone means "miss".
   */
  async wrap<T>(
    key: string,
    compute: () => Promise<T>,
    options: { ttlMs?: DurationMs; shouldCacheFalsy?: boolean } = {},
  ): Promise<T> {
    const cached = (await this.store.get(key)) as undefined | T
    if (cached !== undefined) {
      return cached
    }
    const result = await compute()
    // `undefined` is the miss marker and is never stored. A falsy result is
    // stored unless the caller opted out, so `0`/`false`/`""`/`null` become hits.
    if (result !== undefined && (options.shouldCacheFalsy ?? true)) {
      await this.store.set(key, result as CacheValue, options.ttlMs ?? this.defaultTtlMs)
    }
    return result
  }
}

/** The registered keys this package depends on, each with its own TTL. */
export const cacheItems = {
  user: {
    key: (id: number): string => `user:${id}`,
    ttlMs: ONE_WEEK_MS,
    permission: CacheAccess.Private,
  },
  session: {
    key: (idToken: string): string => `session:${idToken}`,
    ttlMs: ONE_WEEK_MS,
    permission: CacheAccess.Private,
  },
} satisfies Record<string, CacheItemsEntry>

/** A cache over the process-local store, for a single-instance deployment. */
export function createTenantCache(
  options: { clock?: Clock; defaultTtlMs?: DurationMs } = {},
): TenantCache {
  return new TenantCache(
    new MemoryCacheStore(options.clock),
    options.defaultTtlMs ?? DEFAULT_TTL_MS,
  )
}
