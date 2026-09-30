/**
 * Atomic rate-limit store over Redis, so several API instances share one exact limit.
 *
 * {@link redisRateLimitKv} with `createKvStore` reads a window, adds an event and writes it back,
 * and two instances doing that at once lose writes: under lockstep bursts the effective limit
 * approaches `limit × instances`. This store keeps the window in a sorted set and does the whole
 * check in one Lua script, which Redis runs to completion before it serves anyone else: drop the
 * events that left the window, count what remains, and record the new event only when there is
 * room. N instances cannot accept more than `limit` requests per window.
 *
 * Redis and Valkey speak the same protocol; both work.
 *
 * @module
 */
import type { RateLimitConsumeResult, RateLimitStore } from "@spy4x/platform/rate-limit"

/** The part of {@link RedisKvStore} the store needs. A fake satisfies it in tests. */
export interface RateLimitRedisScriptStore {
  eval(script: string, keys: string[], args?: Array<string | number>): Promise<unknown>
  del(key: string): Promise<void>
}

/** Options for {@link createRedisRateLimitStore}. */
export interface RedisRateLimitStoreOptions {
  /**
   * Namespace under the `RedisKvStore`'s own prefix. Defaults to `ratelimit-atomic`. The window is
   * a Redis sorted set, so it must not share a name with keys that hold strings (such as those of
   * `redisRateLimitKv`): Redis answers `WRONGTYPE` and the limiter throws.
   */
  keyPrefix?: string
  /**
   * Makes the unique member of each recorded event; two requests in the same millisecond need
   * different members. Defaults to `crypto.randomUUID`. Tests inject a counter.
   */
  newId?: () => string
}

/** Trim, count, record when under the limit, set expiry. ARGV: cutoff, now, windowMs, limit, id. */
export const CONSUME_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local allowed = 0
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[5])
  local newest = tonumber(redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')[2])
  local ttl = tonumber(ARGV[3]) + math.max(0, newest - tonumber(ARGV[2]))
  redis.call('PEXPIRE', KEYS[1], math.ceil(ttl))
  allowed = 1
end
local window = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
table.insert(window, 1, allowed)
return window
`

/** Every score in the window, oldest first. */
export const READ_SCRIPT = `return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')`

/** Replace the window: ARGV[1] is the expiry in ms, the rest are the event timestamps. */
export const WRITE_SCRIPT = `
redis.call('DEL', KEYS[1])
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], ARGV[i], i)
end
if #ARGV > 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return 1
`

/** Remove one event: ARGV[1] is its timestamp, or absent for the newest. */
export const RELEASE_SCRIPT = `
local member
if ARGV[1] then
  member = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[1], 'LIMIT', 0, 1)[1]
else
  member = redis.call('ZRANGE', KEYS[1], -1, -1)[1]
end
if member then
  return redis.call('ZREM', KEYS[1], member)
end
return 0
`

/** Scores from a `ZRANGE ... WITHSCORES` reply whose pairs (member, score) start after index `from`. */
function scoresOf(reply: unknown[], from: number): number[] {
  const scores: number[] = []
  for (let i = from + 2; i < reply.length; i += 2) {
    const score = Number(reply[i])
    if (typeof reply[i] !== "string" || !Number.isFinite(score)) {
      throw new TypeError(`unexpected rate-limit reply: score ${String(reply[i])} is not a number`)
    }
    scores.push(score)
  }
  return scores
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`)
}

/**
 * Build an atomic `RateLimitStore` over a `RedisKvStore` (the caller keeps ownership and closes
 * it).
 *
 * - **`consume`** is the atomic check-and-record the limiter uses: one `EVAL` per request.
 *   `StoreRateLimiter` calls it instead of `read` plus `write`, so pass this store to
 *   `createStoreLimiter` as usual. It needs Redis 3.2 or later for the script (Redis 6.2 is
 *   already required elsewhere in this package).
 * - **The clock is the caller's.** "Now" is the `now` the limiter passes in (its injected clock),
 *   not Redis `TIME`, so behaviour and tests match the other stores. The trade: instances whose
 *   clocks differ slightly disagree on where the window starts. Keep them on NTP, as with any
 *   shared store. The key's expiry is a real Redis TTL of `windowMs` (longer when an event is
 *   ahead of `now`), so a fake clock in a test only drives trimming, not expiry.
 * - **`read`** returns the recorded timestamps, or `undefined` when the key is absent. Redis has
 *   expired it by then; the limiter filters events outside its window itself. **`write`**
 *   replaces the window; the limiter no longer needs it for `refund`. **`delete`** drops it.
 * - **`release`** is the atomic refund: one script removes the single event recorded at `at`, or
 *   the newest without `at`, so a refund overlapping other instances' checks cannot erase their
 *   events. `StoreRateLimiter.refund` uses it automatically.
 * - A resend after a connection died mid-call sends the same command with the same event id, so
 *   `consume` records no extra event. What can happen: the first run took the last free slot, so
 *   the resend reports "rejected" for a request that was in fact recorded. A resent `release`
 *   with an `at` removes nothing more; without `at` it removes the next-newest event too.
 * - `now`, `windowMs`, `limit` and event timestamps must be finite numbers, else `RangeError`.
 *
 * @param store An open `RedisKvStore`.
 */
export function createRedisRateLimitStore(
  store: RateLimitRedisScriptStore,
  options: RedisRateLimitStoreOptions = {},
): RateLimitStore {
  const keyPrefix = options.keyPrefix ?? "ratelimit-atomic"
  const newId = options.newId ?? (() => crypto.randomUUID())
  const keyFor = (key: string): string => `${keyPrefix}:${key}`

  return {
    async read(key: string): Promise<number[] | undefined> {
      const reply = await store.eval(READ_SCRIPT, [keyFor(key)])
      if (!Array.isArray(reply)) {
        throw new TypeError(`unexpected rate-limit reply: expected an array, got ${typeof reply}`)
      }
      return reply.length === 0 ? undefined : scoresOf(reply, -1)
    },
    async write(key: string, events: number[], now: number, ttlMs: number): Promise<void> {
      finite(`now`, now)
      for (const event of events) finite(`event`, event)
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.ceil(ttlMs) : 1
      await store.eval(WRITE_SCRIPT, [keyFor(key)], [ttl, ...events])
    },
    async delete(key: string): Promise<void> {
      await store.del(keyFor(key))
    },
    async release(key: string, at?: number): Promise<void> {
      if (at !== undefined) finite(`at`, at)
      await store.eval(RELEASE_SCRIPT, [keyFor(key)], at === undefined ? [] : [at])
    },
    async consume(
      key: string,
      now: number,
      windowMs: number,
      limit: number,
    ): Promise<RateLimitConsumeResult> {
      finite(`now`, now)
      finite(`windowMs`, windowMs)
      finite(`limit`, limit)
      const reply = await store.eval(CONSUME_SCRIPT, [keyFor(key)], [
        now - windowMs,
        now,
        Math.ceil(windowMs),
        Math.floor(limit),
        newId(),
      ])
      if (!Array.isArray(reply) || (reply[0] !== 0 && reply[0] !== 1)) {
        throw new TypeError(`unexpected rate-limit reply: ${JSON.stringify(reply)}`)
      }
      return { allowed: reply[0] === 1, events: scoresOf(reply, 0) }
    },
  }
}
