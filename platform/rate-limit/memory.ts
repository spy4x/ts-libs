/**
 * Sliding-window rate limiter with an injected clock and bounded memory.
 *
 * Ported from `mig/lib/ratelimit.ts` (booking submissions) and `caldav-mcp/main.ts` (per-IP
 * limiter), with two source bugs fixed — see {@link MemoryRateLimiter} and `README.md`.
 *
 * **Window semantics: sliding, not fixed.** A bucket holds one timestamp per accepted request and
 * only the timestamps newer than `now - windowMs` count, so a client that spends its whole budget
 * at second 0 still has to wait a full window from its *oldest* request before the next one lands.
 * A fixed window would let a caller fire `limit` requests at the last millisecond of a window and
 * another `limit` immediately after, i.e. `2 * limit` in a hair over one window — which is exactly
 * the burst the auth endpoints this module exists for must absorb.
 *
 * Memory is bounded on two axes:
 *
 * - per bucket, by `limit`: one timestamp is stored per *accepted* request and nothing is stored
 *   for a rejected one, so a client that hammers the endpoint cannot grow its own bucket;
 * - across buckets, by the sweep: a bucket whose newest event is older than
 *   `windowMs + idleMs` is dropped, so a client rotating its source address cannot grow the map
 *   forever. `caldav-mcp`'s map never evicted, which is a memory-exhaustion vector.
 *
 * Eviction never targets a bucket that is still holding events inside its window, and it is
 * triggered by time rather than by insertion, so a request from a brand-new key can never free a
 * slot by pushing out an active bucket. A brute-forcer cannot reset its own counter by rotating
 * keys; the counter only decays by waiting.
 */

import { systemNow } from "../universal/time.ts"

/**
 * Monotonic millisecond clock. Inject a fake in tests; never read `Date.now()` behind one.
 *
 * @deprecated Identical shape to `NowFn` from `@spy4x/platform/universal/time` (`#71`), which is
 * now the home for this shape. Use that instead in new code; `platform/rate-limit/kv.ts` already
 * imports this alias from here rather than redeclaring it, which is unaffected by this change.
 * Kept as its own `type Clock = () => number` declaration, not a `= NowFn` reference, because
 * `deno doc`'s text rendering — which `docs/1.0-contract.md` pins verbatim — renders a reference
 * to another named type differently from an inline function-type alias; the two are already
 * structurally interchangeable, so nothing is lost by keeping this declaration's own text.
 */
export type Clock = () => number

/**
 * Default: real time. Only the module boundary reads it.
 *
 * @deprecated Use `systemNow` from `@spy4x/platform/universal/time`.
 */
export const systemClock: Clock = () => systemNow()

/** How long a bucket survives after it stops being active. */
export const DEFAULT_IDLE_MS = 10 * 60_000

/** How many requests may arrive between two sweeps before one is forced. */
export const SWEEP_EVERY_CHECKS = 512

/** Which identity a limiter buckets on. Finite set, so `enum` starting at 1. */
export enum RateLimitKind {
  Ip = 1,
  User = 2,
}

/** Outcome of one `check`. */
export interface RateLimitDecision {
  /** False when the request must be rejected. */
  allowed: boolean
  /** Requests still available in the current window. Never negative. */
  remaining: number
  /**
   * Milliseconds until the next request is allowed, 0 when this one was allowed.
   *
   * A rejected request waits exactly this long, which is why `Retry-After` and a blocked
   * `RateLimit-Reset` both come from it.
   */
  retryAfterMs: number
  /**
   * Milliseconds until this key's counter drops below `limit`: until the **first** recorded event
   * leaves the window and one slot opens.
   *
   * Not "until the bucket is empty" — a bucket holding ten events spread across the window regains
   * room long before the last of them expires. Sent as `RateLimit-Reset` on an allowed response;
   * a rejection uses `retryAfterMs`, which is derived from the same oldest event.
   */
  resetAfterMs: number
  /** Requests allowed per window, so the middleware can report the configured limit. */
  limit: number
}

/** Configuration shared by every limiter implementation. */
export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number
  /** Requests allowed per window per key. */
  limit: number
  /** Clock the limiter reads. Defaults to {@link systemClock}. */
  clock?: Clock
  /** Idle grace after `windowMs` before a bucket is swept. Defaults to {@link DEFAULT_IDLE_MS}. */
  idleMs?: number
}

/** Constructor options for {@link MemoryRateLimiter}. */
export interface MemoryRateLimiterOptions extends RateLimitOptions {
  /** Notified with the number of buckets removed each time a sweep runs. */
  onSweep?: (removed: number) => void
}

/** Accepted-request timestamps for one key, oldest first. */
interface EventBucket {
  /** Milliseconds, non-decreasing. */
  events: number[]
  /** Timestamp of the most recent `check`, whatever its outcome. */
  seenAt: number
}

/** Index of the first event inside `(cutoff, now]` — events are sorted, so binary search. */
function firstLiveIndex(events: number[], cutoff: number): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >> 1
    if ((events[mid] as number) <= cutoff) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * How long a shared-store entry must survive so no live event is forgotten.
 *
 * Derived from the **newest** recorded event, never the oldest. A TTL from the oldest would drop the
 * entry while newer events are still inside the window; the next request would then read an absent
 * key and the window would restart early, allowing up to `limit` extra requests — a bypass, not a
 * rounding error. Derived from the newest event the entry outlives the last event's window, so a
 * TTL eviction can only happen once the bucket is genuinely empty. Floored at 1 ms so a backend is
 * never asked to store something it would expire immediately.
 */
function storeTtlMs(events: number[], windowMs: number, now: number): number {
  const newest = events.length === 0 ? now : (events[events.length - 1] as number)
  return Math.max(1, newest + windowMs - now)
}

/**
 * In-process sliding-window limiter.
 *
 * Synchronous by design: a single isolate can serve a decision without awaiting storage, which is
 * what the middleware path wants. For several instances, use `createStoreLimiter` from `kv.ts`
 * with a shared store — the two are interchangeable through {@link RateLimitStore}.
 *
 * Source fix 1: the source read `Date.now()` inline for `lastPrune`, so the sweep could not be
 * tested or advanced; the clock is now injected.
 * Source fix 2: the source pruned with `while (events[0] <= cutoff) events.shift()`, which is
 * O(n²) on a full bucket; a binary search plus `slice` makes the per-request work independent of
 * how full the bucket is.
 */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, EventBucket>()
  private readonly windowMs: number
  private readonly limit: number
  private readonly clock: Clock
  private readonly idleMs: number
  private readonly onSweep: ((removed: number) => void) | undefined
  private lastSweepAt: number
  private checksSinceSweep = 0

  constructor(options: MemoryRateLimiterOptions) {
    if (!(options.windowMs > 0)) throw new Error("windowMs must be > 0")
    if (!(options.limit >= 1)) throw new Error("limit must be >= 1")
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    // `idleMs` is the precondition of the sweep's live-event guarantee: a negative grace would let
    // a bucket holding a live event be dropped, and `NaN` makes every comparison false, so the
    // sweep would never run and the map would grow without bound.
    if (!Number.isFinite(idleMs) || idleMs < 0) {
      throw new Error("idleMs must be a finite number >= 0")
    }
    this.windowMs = options.windowMs
    this.limit = Math.floor(options.limit)
    this.clock = options.clock ?? systemClock
    this.idleMs = idleMs
    this.onSweep = options.onSweep
    this.lastSweepAt = this.clock()
  }

  /** Live buckets. Exposed so a bounded-memory test can assert the bound directly. */
  get size(): number {
    return this.buckets.size
  }

  /** Record a request for `key` and decide whether it is allowed. */
  check(key: string, now: number = this.clock()): RateLimitDecision {
    this.maybeSweep(now)

    const cutoff = now - this.windowMs
    const bucket = this.buckets.get(key) ?? { events: [], seenAt: now }
    bucket.seenAt = now

    const live = firstLiveIndex(bucket.events, cutoff)
    if (live > 0) bucket.events = bucket.events.slice(live)

    if (bucket.events.length >= this.limit) {
      const oldest = bucket.events[0] as number
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now)
      this.buckets.set(key, bucket)
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        resetAfterMs: retryAfterMs,
        limit: this.limit,
      }
    }

    bucket.events.push(now)
    this.buckets.set(key, bucket)
    const remaining = Math.max(0, this.limit - bucket.events.length)
    return {
      allowed: true,
      remaining,
      retryAfterMs: 0,
      resetAfterMs: Math.max(0, (bucket.events[0] as number) + this.windowMs - now),
      limit: this.limit,
    }
  }

  /** Drop a bucket, so the next request for `key` starts a fresh window. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /** Drop every bucket. */
  clear(): void {
    this.buckets.clear()
    this.checksSinceSweep = 0
    this.lastSweepAt = this.clock()
  }

  /** Run the idle sweep now instead of waiting for the interval. Returns buckets removed. */
  sweep(now: number = this.clock()): number {
    this.lastSweepAt = now
    this.checksSinceSweep = 0
    let removed = 0
    for (const [key, bucket] of this.buckets) {
      const newest = bucket.events[bucket.events.length - 1]
      // Idle on two counts: nothing was seen inside the idle grace, *and* no recorded event is
      // still inside a window. The second test is what keeps a busy bucket alive — a bucket's most
      // recent `check` can be a rejection, which stores no event, so `seenAt` alone would let the
      // sweep delete a bucket that is seconds away from handing out a fresh request.
      const idle = bucket.seenAt <= now - this.idleMs &&
        (newest === undefined || newest <= now - this.windowMs - this.idleMs)
      if (idle) {
        this.buckets.delete(key)
        removed += 1
      }
    }
    this.onSweep?.(removed)
    return removed
  }

  /**
   * Sweep at most once per `windowMs`, and force one after {@link SWEEP_EVERY_CHECKS} checks, so
   * the cost is amortised and a fingerprinting client that sends one request per key still cannot
   * outrun it.
   */
  private maybeSweep(now: number): void {
    this.checksSinceSweep += 1
    const due = now - this.lastSweepAt >= this.windowMs
    if (!due && this.checksSinceSweep < SWEEP_EVERY_CHECKS) return
    this.sweep(now)
  }
}

/**
 * The `RateLimitStore` port: the only surface a limiter needs from a shared backend.
 *
 * Deliberately tiny and backend-agnostic. Deno KV, Redis and Postgres all fit behind it, and the
 * limiter core imports none of them — adopting `rate-limit-redis` would have made a Redis client a
 * hard dependency of the limiter.
 */
export interface RateLimitStore {
  /**
   * Read the recorded timestamps for `key`, or `undefined` when the key is absent or expired.
   *
   * `now` is optional so a caller walking a store by hand (`await store.read(key)`) does not have
   * to invent a timestamp; a store that owns a clock falls back to it.
   */
  read(key: string, now?: number): Promise<number[] | undefined>
  /** Record `events` for `key`, expiring them at least `ttlMs` from `now`. */
  write(key: string, events: number[], now: number, ttlMs: number): Promise<void>
  /** Drop `key`. */
  delete(key: string): Promise<void>
}

/**
 * Store-backed sliding window over any {@link RateLimitStore}.
 *
 * Same window semantics as {@link MemoryRateLimiter}, so a single instance can start in-process and
 * move to Deno KV or a custom store without changing behaviour. Read-modify-write is not atomic
 * across instances: two requests that land in different isolates within the same millisecond can
 * both be accepted, so the effective limit is `limit + (concurrent isolates - 1)` in the worst
 * case. Erring towards allowing is the deliberate trade — a synchronous cross-instance lock per
 * request would serialise the whole API on the limiter.
 */
export class StoreRateLimiter {
  private readonly store: RateLimitStore
  private readonly windowMs: number
  private readonly limit: number
  private readonly clock: Clock

  constructor(store: RateLimitStore, options: RateLimitOptions) {
    if (!(options.windowMs > 0)) throw new Error("windowMs must be > 0")
    if (!(options.limit >= 1)) throw new Error("limit must be >= 1")
    this.store = store
    this.windowMs = options.windowMs
    this.limit = Math.floor(options.limit)
    this.clock = options.clock ?? systemClock
  }

  /** Record a request for `key` and decide whether it is allowed. */
  async check(key: string, now: number = this.clock()): Promise<RateLimitDecision> {
    const cutoff = now - this.windowMs
    const recorded = await this.store.read(key, now)
    const events = (recorded ?? []).filter((event) => event > cutoff).slice(-this.limit)

    if (events.length >= this.limit) {
      const oldest = events[0] as number
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now)
      // No write here: a rejected request adds no event, so the entry the last accepted request
      // wrote is already correct, and re-writing it would cost the shared store one round trip per
      // rejected request — 100 requests at `limit: 2` measured 100 writes before this fix. The
      // in-process `MemoryRateLimiter` above stores nothing for a rejected request either; this
      // keeps the two limiters' write behaviour the same, not just their decisions.
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        resetAfterMs: retryAfterMs,
        limit: this.limit,
      }
    }

    events.push(now)
    const oldest = events[0] as number
    const resetAfterMs = Math.max(0, oldest + this.windowMs - now)
    await this.store.write(key, events, now, storeTtlMs(events, this.windowMs, now))
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - events.length),
      retryAfterMs: 0,
      resetAfterMs,
      limit: this.limit,
    }
  }

  /** Drop the recorded window for `key`. */
  async reset(key: string): Promise<void> {
    await this.store.delete(key)
  }
}

/** Limiter shape the middleware accepts, sync or async. */
export interface RateLimiter {
  check(key: string, now?: number): RateLimitDecision | Promise<RateLimitDecision>
  reset(key: string, now?: number): void | Promise<void>
}

/** Build an in-process limiter. */
export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions,
): MemoryRateLimiter {
  return new MemoryRateLimiter(options)
}

/** Build a limiter over a shared store. */
export function createStoreLimiter(
  store: RateLimitStore,
  options: RateLimitOptions,
): StoreRateLimiter {
  return new StoreRateLimiter(store, options)
}

/**
 * Build a limiter key from an identity.
 *
 * Prefixed so one backend can host several limiters (`chart:user:42`) without their counters
 * colliding, matching the `user:<id>` / `ip:<addr>` shape the `gb` middleware used.
 */
export function rateLimitKey(kind: RateLimitKind, id: string, prefix = ""): string {
  const scope = kind === RateLimitKind.User ? "user" : "ip"
  return `${prefix}${scope}:${id}`
}
