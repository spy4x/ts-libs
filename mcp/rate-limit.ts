// ── In-memory rate limiter: sliding window, idle-sweep eviction ──
//
// Port of the caldav-mcp limiter with two source bugs fixed: the map never evicted,
// and (introduced by the first version of this port) eviction was by insertion order,
// which let a key-rotating client reset another client's counter — a rate-limit bypass.
//
// The eviction policy here is `@ts-libs/platform/rate-limit`'s (issue #4, PR #32):
// time-driven only, never on insertion, and never against a bucket that is still live.

/** Limits for one key. */
export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /**
   * Idle grace after a bucket stops being active before it may be swept. Defaults to
   * {@link DEFAULT_IDLE_MS}. A larger grace means a busier map and a smoother rebuild.
   */
  idleMs?: number
  /** Time source. Injectable so the sweep is testable without sleeping. */
  now?: () => number
  /** Resolves a request to a rate-limit key. Defaults to {@link clientIp}. */
  keyResolver?: (request: Request) => string
  /** Notified with the number of buckets each sweep removed. */
  onSweep?: (removed: number) => void
}

/** Verdict for one request. */
export interface RateLimitResult {
  allowed: boolean
  /** Requests left in the current window. `0` when denied. */
  remaining: number
  /** Milliseconds until the next request is allowed. Sent as `Retry-After`. */
  retryAfterMs: number
}

/**
 * The port the HTTP transport depends on — deliberately the same shape as
 * `@ts-libs/platform/rate-limit`'s limiter so the swap is a deletion, not a rewrite.
 */
export interface RateLimitStore {
  /** Record one request for `key` and return the verdict. */
  check(key: string): RateLimitResult
  /** Drop every bucket that is neither idle nor holding a live event. Returns the count. */
  evict(): number
  /** Number of tracked buckets. */
  readonly size: number
}

/** Default idle grace: ten minutes, as `@ts-libs/platform/rate-limit` uses. */
export const DEFAULT_IDLE_MS = 10 * 60_000

/**
 * How many checks may pass between two sweeps. A client that sends one request per key
 * cannot outrun the sweep by volume alone.
 */
export const SWEEP_EVERY_CHECKS = 512

/** Accepted-request timestamps for one key, oldest first. */
interface Bucket {
  /**
   * Milliseconds, strictly non-decreasing. Every value here is a timestamp this store
   * already clamped against its own monotonically non-decreasing observation sequence
   * (see {@link MemoryRateLimitStore.check}), so the array stays sorted even when the
   * injected clock steps backwards.
   */
  events: number[]
  /** Timestamp of the most recent check, whatever its outcome and after clamping. */
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
 * In-process sliding-window limiter.
 *
 * **Window semantics: sliding, not fixed.** One timestamp is stored per *accepted*
 * request, and only timestamps newer than `now - windowMs` count. A fixed window would
 * let a caller spend the whole budget in the last millisecond of one window and the whole
 * budget again in the next — `2 * limit` in a hair over one window.
 *
 * **Eviction is time-driven only, and never targets a live bucket.** A bucket is dropped
 * when nothing has been seen for it within `idleMs` **and** its newest recorded event is
 * older than `windowMs + idleMs`. Two consequences, both security properties:
 *
 * - a request from a new key can never free space by displacing an active bucket, so
 *   rotating keys does not reset another client's counter — this is the bypass the first
 *   version of this port shipped;
 * - a bucket whose most recent check was a *rejection* stores no event, so `seenAt` alone
 *   would be wrong; that is why both conditions are required.
 *
 * Rejected requests are not recorded, which is what stops a blocked client from extending
 * its own window by retrying.
 *
 * **Time is taken monotonically, clamped per store.** Every timestamp in this class comes
 * from `lastNow = max(lastNow, now())`, not from `now()` directly. `Date.now` follows the
 * wall clock, which is not monotonic: an NTP correction or an operator setting the clock
 * back can move it backwards. An observation sequence that goes backwards is what broke
 * the sortedness of `events`, and with it the binary search in {@link firstLiveIndex}: the
 * search then mislocated the live prefix, `slice(live)` dropped events that were still
 * inside the window, and a client that stepped the clock back got a fresh budget on top of
 * one it had already spent. Clamping is what makes `events` non-decreasing by construction.
 *
 * A backwards observation is **read as the previous timestamp**, never as a window reset or
 * as a rewound counter. Two consequences: a request that arrives while the clock is behind
 * is judged against the newest timestamp the store has already seen, so it cannot extend or
 * escape its window by moving the clock; and after the clock recovers, the store's own
 * sequence is at or ahead of the wall clock again, so no event is held live longer than
 * `windowMs` of real time. The cost is a slightly later budget than the wall clock alone
 * would grant, for the duration of the discrepancy — the fail-closed direction.
 *
 * A **forward** step is not clamped: the larger observation wins, every event in a bucket
 * falls out of the window at once, and the bucket gets a fresh budget immediately, which is
 * the same answer `Date.now` alone would have given. A backwards step followed by a forwards
 * recovery therefore cannot resurrect an event that already expired — `events` only ever
 * receives timestamps from a non-decreasing sequence, so nothing is ever re-inserted behind
 * the live prefix.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly idleMs: number
  private readonly now: () => number
  private readonly onSweep: ((removed: number) => void) | undefined
  /**
   * The newest timestamp this store has observed (`max` of every `now()` it has seen).
   * Monotonically non-decreasing for the lifetime of the store, whatever the injected
   * clock does, which is what keeps every bucket's `events` sorted.
   */
  private lastNow: number = Number.NEGATIVE_INFINITY
  private lastSweepAt: number
  private checksSinceSweep = 0

  constructor(options: RateLimitOptions) {
    if (!(options.limit >= 1)) throw new Error("rate limit must be >= 1")
    if (!(options.windowMs > 0)) throw new Error("rate limit window must be positive")
    if (options.idleMs !== undefined && !(options.idleMs >= 0)) {
      throw new Error("rate limit idle grace must not be negative")
    }
    this.limit = Math.floor(options.limit)
    this.windowMs = options.windowMs
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.now = options.now ?? Date.now
    this.onSweep = options.onSweep
    this.lastNow = this.observe()
    this.lastSweepAt = this.lastNow
  }

  get size(): number {
    return this.buckets.size
  }

  /**
   * One monotonically non-decreasing observation of the injected clock. Never returns less
   * than the previous call, so a backwards step in the wall clock cannot unsort a bucket.
   */
  private observe(): number {
    this.lastNow = Math.max(this.lastNow, this.now())
    return this.lastNow
  }

  /**
   * Record one request for `key` and return the verdict. Time comes from
   * {@link observe}, so the verdict is a function of a non-decreasing sequence even when
   * the injected clock steps backwards.
   */
  check(key: string): RateLimitResult {
    const now = this.observe()
    this.maybeSweep(now)

    const cutoff = now - this.windowMs
    const bucket = this.buckets.get(key) ?? { events: [], seenAt: now }
    bucket.seenAt = now

    const live = firstLiveIndex(bucket.events, cutoff)
    if (live > 0) bucket.events = bucket.events.slice(live)

    if (bucket.events.length >= this.limit) {
      const oldest = bucket.events[0] as number
      this.buckets.set(key, bucket)
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now)
      return { allowed: false, remaining: 0, retryAfterMs }
    }

    bucket.events.push(now)
    this.buckets.set(key, bucket)
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - bucket.events.length),
      retryAfterMs: 0,
    }
  }

  /** Run the idle sweep now instead of waiting for the interval. Returns buckets removed. */
  evict(): number {
    return this.sweep(this.observe())
  }

  /**
   * Sweep at most once per `windowMs`, and force one after {@link SWEEP_EVERY_CHECKS}
   * checks so a fingerprinting client that sends one request per key still cannot outrun
   * it.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs && this.checksSinceSweep < SWEEP_EVERY_CHECKS) {
      this.checksSinceSweep += 1
      return
    }
    this.sweep(now)
  }

  private sweep(now: number): number {
    this.lastSweepAt = now
    this.checksSinceSweep = 0
    let removed = 0

    for (const [key, bucket] of this.buckets) {
      const newest = bucket.events[bucket.events.length - 1]
      // Idle on two counts: nothing seen within the grace, *and* no event still inside a
      // window. The second test keeps a bucket alive whose last check was a rejection —
      // it stores no event, so `seenAt` alone would let the sweep delete a bucket that is
      // about to hand out a fresh request.
      const idle = bucket.seenAt <= now - this.idleMs &&
        (newest === undefined
          // No event at all: the only activity was a rejection, which stores nothing.
          // Keep the bucket while that rejection can still be inside its window, since
          // one arriving after the window is open again gets a fresh budget anyway.
          ? bucket.seenAt <= now - this.windowMs
          : newest <= now - this.windowMs - this.idleMs)
      if (idle) {
        this.buckets.delete(key)
        removed += 1
      }
    }

    this.onSweep?.(removed)
    return removed
  }
}

/**
 * Resolve the rate-limit key for a request. `x-forwarded-for` is only trustworthy behind
 * a proxy that overwrites it (Traefik does); the leftmost entry is the client. A request
 * with no address at all is bucketed together so it cannot bypass the limit.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  const candidate = forwarded?.split(",")[0]?.trim()
  if (candidate && candidate.length > 0) return candidate

  const realIp = request.headers.get("x-real-ip")?.trim()
  return realIp && realIp.length > 0 ? realIp : "unknown"
}

/** Build the store the HTTP transport uses, without the transport knowing the class. */
export function createRateLimitStore(options: RateLimitOptions): RateLimitStore {
  return new MemoryRateLimitStore(options)
}

/** Header-safe `Retry-After` value: whole seconds, never "0". */
export function retryAfterSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
}
