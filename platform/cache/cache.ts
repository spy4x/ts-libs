/**
 * A JSON cache in front of a pluggable {@link ICacheStorage}.
 *
 * Ported from `template/libs/platform/cache/+index.ts`. Four behaviour changes at extraction
 * time, each one because this package is published to arbitrary consumers rather than kept next
 * to one app — see the docs on {@link reviveIsoDatesEndingInAt}, {@link CacheService.wrap} and
 * `normalizeTtlSeconds` for the reasoning behind each:
 *
 * 1. The date-reviving `JSON.parse` reviver is opt-in (`CacheServiceOptions.reviver`), not applied
 *    unconditionally to every value.
 * 2. `set`/`wrap`'s TTL parameter is named and typed as seconds throughout, matching what
 *    {@link ICacheStorage.set} actually expects — the source's `ICacheService` interface named it
 *    `ttlMs` while every implementation and caller treated it as seconds with no conversion, which
 *    is a real bug: a caller trusting the interface's own name and passing milliseconds would get
 *    a cache entry roughly 1000x longer-lived than intended.
 * 3. A TTL is validated and rounded up to a whole second (`normalizeTtlSeconds`) before it reaches
 *    storage, so a sub-second request cannot become `0` — which several stores, including Redis's
 *    `EXPIRE`, either reject or read as "no expiry".
 * 4. `wrap` coalesces concurrent calls for the same key on the same instance into one `fn()` call.
 *
 * A fifth change: `schema` is an arktype `Type`, validated through `@ts-libs/validation`'s
 * `validate`, not the source's `ValidationSchema` from its own `@platform/types` — this package
 * has no validator of its own and never will (issue #23).
 */

import type { Type } from "arktype"
import { validate } from "@ts-libs/validation"

/** ISO-8601 UTC timestamp, with or without milliseconds. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/**
 * `JSON.parse` reviver that turns a string property whose key ends in `At` into a `Date`, when
 * the string looks like an ISO-8601 UTC timestamp.
 *
 * The template this was ported from applied exactly this behaviour unconditionally, to every
 * cached value. That is a bug for a library with consumers this package does not control: the
 * check is on the property *name*, not on a schema, so it also fires on a field that merely ends
 * in "At" without meaning a date — `formatAt`, `chatAt` — and there is no way for a caller to opt
 * out. Here it only runs when a caller passes this function as `CacheServiceOptions.reviver`.
 */
export function reviveIsoDatesEndingInAt(key: string, value: unknown): unknown {
  return typeof value === "string" && key.endsWith("At") && ISO_DATE_PATTERN.test(value)
    ? new Date(value)
    : value
}

/**
 * Storage backing a {@link CacheService}.
 *
 * Method names and meaning are load-bearing beyond this package: `server/kv` implements this
 * interface over Redis, briefed against these exact signatures.
 */
export interface ICacheStorage {
  /** The value stored under `key`, or `null` when absent or expired. */
  get(key: string): Promise<string | null>
  /** Store `value` under `key`, expiring it after `ttlSec` whole seconds. */
  set(key: string, value: string, ttlSec: number): Promise<void>
  /** Remove `key`. A no-op when it is already absent. */
  del(key: string): Promise<void>
  /** Remove every key this storage holds. */
  reset(): Promise<void>
}

/** Options accepted by {@link CacheService.wrap}. */
export interface CacheWrapOptions {
  /**
   * Cache a falsy `fn()` result (`0`, `""`, `false`, `null`). Defaults to `false`: a falsy result
   * is recomputed on every call, which is the right default when falsy usually means "nothing
   * found yet" and the wrong one when `0` is itself a valid answer worth caching.
   */
  shouldSaveFalsy?: boolean
}

/** A JSON cache in front of an {@link ICacheStorage}. */
export interface ICacheService {
  /** Parsed cached value for `key`, or `null` when absent. */
  get<T>(key: string): Promise<T | null>
  /** JSON-encode `value` and store it under `key` for `ttlSec` seconds. */
  set<T>(key: string, value: T, ttlSec: number): Promise<void>
  /** Remove `key`. */
  delete(key: string): Promise<void>
  /** See {@link CacheService.wrap}. */
  wrap<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSec: number,
    options?: CacheWrapOptions,
  ): Promise<T>
  /** Remove every cached value. */
  reset(): Promise<void>
}

/** {@link CacheService} constructor options. */
export interface CacheServiceOptions {
  /**
   * `JSON.parse` reviver applied to every value read back from storage, on both a `get` and a
   * `wrap` cache hit. Omitted by default, which is a plain `JSON.parse`. Pass
   * {@link reviveIsoDatesEndingInAt} to restore the template's old default behaviour.
   */
  reviver?: (key: string, value: unknown) => unknown
}

/**
 * Round `ttlSec` up to the nearest whole second, and reject a non-positive or non-finite one.
 *
 * `ICacheStorage.set`'s contract is whole seconds, and a store on the other side of it — Redis's
 * `EXPIRE` included — truncates a fraction toward zero, so an un-rounded sub-second TTL would
 * either arrive as `0` (read by some stores as "never expires", rejected outright by others) or
 * expire the moment it is set. Rounding up here, once, keeps that decision out of every
 * `ICacheStorage` implementation.
 */
function normalizeTtlSeconds(ttlSec: number): number {
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new RangeError(`ttlSec must be a positive, finite number of seconds, got ${ttlSec}`)
  }
  return Math.ceil(ttlSec)
}

export class CacheService implements ICacheService {
  /** `fn()` calls in flight, keyed by cache key — what makes concurrent `wrap` calls coalesce. */
  private pending = new Map<string, Promise<unknown>>()

  constructor(private storage: ICacheStorage, private options: CacheServiceOptions = {}) {}

  async get<T>(key: string): Promise<T | null> {
    const result = await this.storage.get(key)
    return result === null ? null : this.decode<T>(result)
  }

  /** `JSON.parse` a raw storage value with this instance's reviver, once, shared by `get`/`wrap`. */
  private decode<T>(raw: string): T {
    return JSON.parse(raw, this.options.reviver) as T
  }

  /**
   * `async` on purpose, not `return this.storage.set(...)`: `normalizeTtlSeconds` can throw
   * synchronously, and a non-`async` function would let that throw escape as a synchronous
   * exception instead of a rejection of the `Promise<void>` this method's signature promises —
   * surprising for a caller that reasonably chains `.catch()` on every `ICacheService` call.
   */
  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    await this.storage.set(key, JSON.stringify(value), normalizeTtlSeconds(ttlSec))
  }

  async delete(key: string): Promise<void> {
    await this.storage.del(key)
  }

  /**
   * Return the cached value for `key`, or call `fn()` once, cache its result, and return it.
   *
   * Concurrent `wrap` calls for the same key on this instance share one in-flight `fn()` call:
   * every caller past the first awaits that same call instead of starting its own, and if `fn()`
   * rejects, every waiting caller rejects with that same error and nothing is cached — the next
   * `wrap` call for the key starts over. This is an in-process guard against a stampede on one hot
   * key on one instance; it does not coordinate across instances or processes.
   *
   * A cache *hit* is storage holding a value at all, not the decoded value being truthy: a key
   * explicitly cached as `null` (or `0`, `""`, `false`) is a hit and is returned as-is, without
   * calling `fn()` again.
   */
  async wrap<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSec: number,
    options: CacheWrapOptions = {},
  ): Promise<T> {
    const raw = await this.storage.get(key)
    if (raw !== null) {
      return this.decode<T>(raw)
    }

    const inFlight = this.pending.get(key)
    if (inFlight) {
      return inFlight as Promise<T>
    }

    const call = (async () => {
      try {
        const value = await fn()
        if (value || options.shouldSaveFalsy) {
          await this.set(key, value, ttlSec)
        }
        return value
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, call)
    return call
  }

  async reset(): Promise<void> {
    await this.storage.reset()
  }
}

/** A namespaced, optionally schema-validated view over one `CacheService`, keyed by `id`. */
export interface PublicAPICacheModel<T, K extends string | number = number> {
  /** The storage key `id` maps to: `` `${prefix}_${id}` ``. */
  key(id: K): string
  /** Seconds a cached item stays valid, as passed to {@link buildMethods}. */
  readonly ttl: number
  get(id: K): Promise<T | null>
  set(id: K, item: T): Promise<void>
  delete(id: K): Promise<void>
  wrap(id: K, fn: () => Promise<T>): Promise<T>
  /** Like `wrap`, but for a list cached under `` `${prefix}_${listPrefix}` ``. */
  wrapMany(listPrefix: string, fn: () => Promise<T[]>): Promise<T[]>
}

/**
 * Build a `${prefix}_${id}`-keyed view over `cacheService`, with a fixed TTL and an optional
 * arktype schema that `get` and `wrap` validate a cache hit against before returning it — so a
 * value another version of this code wrote, in a shape the current schema no longer accepts,
 * surfaces as a thrown validation error instead of a silently wrong read.
 *
 * `wrapMany`'s result is not run through `schema`: `schema` describes one `T`, and validating an
 * array would mean validating each element, which is a different, unrequested feature — see the
 * pull request body.
 */
export function buildMethods<T, K extends string | number = number>(
  cacheService: ICacheService,
  prefix: string,
  /** Seconds a cached item stays valid. */
  ttlSec: number,
  schema?: Type,
): PublicAPICacheModel<T, K> {
  const key = (id: K): string => `${prefix}_${id}`
  const validated = (value: T): T => {
    if (!schema) {
      return value
    }
    const result = validate(schema, value)
    if (result.error) {
      throw result.error.details
    }
    return result.data as T
  }
  return {
    key,
    ttl: ttlSec,
    get: async (id: K): Promise<T | null> => {
      const result = await cacheService.get<T>(key(id))
      return result === null ? null : validated(result)
    },
    set: (id: K, item: T): Promise<void> => cacheService.set(key(id), item, ttlSec),
    delete: (id: K): Promise<void> => cacheService.delete(key(id)),
    wrap: async (id: K, fn: () => Promise<T>): Promise<T> =>
      validated(await cacheService.wrap<T>(key(id), fn, ttlSec)),
    wrapMany: (listPrefix: string, fn: () => Promise<T[]>): Promise<T[]> =>
      cacheService.wrap<T[]>(`${prefix}_${listPrefix}`, fn, ttlSec),
  }
}
