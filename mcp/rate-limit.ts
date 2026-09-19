// ── In-memory rate limiter with eviction ──
// Port of the caldav-mcp limiter with the unbounded-map leak fixed: a client that
// rotates its source address used to grow the map forever. Entries now expire on a
// TTL sweep and the map is hard-capped with LRU eviction.
//
// The port shape (`check` / `evict` / `size`, injected clock, injected key resolver)
// mirrors `@ts-libs/platform/rate-limit` from issue #4, which did not exist on
// `origin/main` when this package landed. Collapse this file to that import once #4
// merges — the HTTP transport already depends on the interface, not the class.

/** Fixed-window limits. */
export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Evict an entry this long after its window ended. Defaults to `windowMs`. */
  ttlMs?: number
  /** Hard cap on tracked keys; the least recently used entry is evicted above it. */
  maxEntries?: number
  /** Time source. Injectable so the sweep is testable without sleeping. */
  now?: () => number
  /** Resolves a request to a rate-limit key. Defaults to {@link clientIp}. */
  keyResolver?: (request: Request) => string
}

/** Verdict for one request. */
export interface RateLimitResult {
  allowed: boolean
  /** Requests left in the current window. `0` when denied. */
  remaining: number
  /** Milliseconds until the window resets. Sent as `Retry-After`. */
  retryAfterMs: number
}

/** The port the HTTP transport depends on. `@ts-libs/platform/rate-limit` (#4) fits it. */
export interface RateLimitStore {
  check(key: string): RateLimitResult
  /** Drop every expired entry. Called automatically by `check`; exposed for tests. */
  evict(): void
  /** Number of tracked keys — the bounded-map assertion. */
  readonly size: number
}

interface Entry {
  count: number
  resetAt: number
}

const DEFAULT_MAX_ENTRIES = 10_000

/**
 * Fixed-window limiter over an in-memory map.
 *
 * Boundedness comes from two independent mechanisms: every `check` first sweeps entries
 * whose window ended more than `ttlMs` ago, and before inserting a new key the map is
 * trimmed to `maxEntries` by evicting the least recently used entry.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: RateLimitOptions) {
    if (options.limit <= 0) throw new Error("rate limit must be positive")
    if (options.windowMs <= 0) throw new Error("rate limit window must be positive")
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.ttlMs = options.ttlMs ?? options.windowMs
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (this.maxEntries <= 0) throw new Error("rate limit maxEntries must be positive")
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  /** Record one request for `key` and return the verdict. */
  check(key: string): RateLimitResult {
    const now = this.now()
    this.evictAt(now)

    const existing = this.entries.get(key)
    if (existing && now < existing.resetAt) {
      // Re-insert to mark the key as most recently used for the LRU cap.
      this.entries.delete(key)
      existing.count += 1
      this.entries.set(key, existing)
      return this.verdict(existing, now)
    }

    const entry: Entry = { count: 1, resetAt: now + this.windowMs }
    this.entries.set(key, entry)
    this.enforceCap()
    return this.verdict(entry, now)
  }

  /** Drop every entry whose window ended more than `ttlMs` ago. */
  evict(): void {
    this.evictAt(this.now())
  }

  private verdict(entry: Entry, now: number): RateLimitResult {
    const remaining = Math.max(0, this.limit - entry.count)
    return {
      allowed: entry.count <= this.limit,
      remaining,
      retryAfterMs: remaining > 0 ? 0 : Math.max(0, entry.resetAt - now),
    }
  }

  private evictAt(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt + this.ttlMs <= now) this.entries.delete(key)
    }
  }

  private enforceCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.entries.delete(oldest.value)
    }
  }
}

/**
 * Resolve the rate-limit key for a request. `x-forwarded-for` is only trustworthy
 * behind a proxy that overwrites it (Traefik does); the leftmost entry is the client.
 * A request with no address at all is bucketed together so it cannot bypass the limit.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  const candidate = forwarded?.split(",")[0]?.trim()
  if (candidate && candidate.length > 0) return candidate

  const realIp = request.headers.get("x-real-ip")?.trim()
  return realIp && realIp.length > 0 ? realIp : "unknown"
}

/**
 * Build the store the HTTP transport uses. Kept as a factory so the transport can fall
 * back to it while `#4` has not landed, without the transport knowing the class.
 */
export function createRateLimitStore(options: RateLimitOptions): RateLimitStore {
  return new MemoryRateLimitStore(options)
}

/** Header-safe `Retry-After` value: whole seconds, never "0". */
export function retryAfterSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
}
