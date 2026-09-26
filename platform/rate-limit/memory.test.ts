import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  createMemoryRateLimiter,
  createStoreLimiter,
  MemoryRateLimiter,
  rateLimitKey,
  RateLimitKind,
  type RateLimitStore,
} from "./memory.ts"

/** Fixed start instant. Every test advances this manually; none reads `Date.now()`. */
const T0 = 1_700_000_000_000

/** Manual clock: the limiter under test must never wait for real time to pass. */
function fakeClock(start = T0): { clock: () => number; advance: (ms: number) => void } {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** In-memory store, so the store-backed limiter is covered without a backend. */
function fakeStore(): RateLimitStore & { entries: Map<string, number[]>; writes: number } {
  const entries = new Map<string, number[]>()
  const store = {
    entries,
    writes: 0,
    read: (key: string) => Promise.resolve(entries.get(key)),
    write: (key: string, events: number[]) => {
      store.writes += 1
      entries.set(key, [...events])
      return Promise.resolve()
    },
    delete: (key: string) => {
      entries.delete(key)
      return Promise.resolve()
    },
  }
  return store
}

describe("MemoryRateLimiter", () => {
  it("rejects the 4th request in a 3-per-window limit", () => {
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 3, clock: () => T0 })

    assertEquals(limiter.check("a").allowed, true)
    assertEquals(limiter.check("a").allowed, true)
    assertEquals(limiter.check("a").allowed, true)

    const denied = limiter.check("a")
    assertEquals(denied.allowed, false)
    assertEquals(denied.remaining, 0)
    assertEquals(denied.retryAfterMs, 1000)
  })

  it("counts each key separately", () => {
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })

    assertEquals(limiter.check("a").allowed, true)
    assertEquals(limiter.check("a").allowed, false)
    assertEquals(limiter.check("b").allowed, true)
    assertEquals(limiter.check("b").allowed, false)
  })

  it("reports the decreasing remaining count and the configured limit", () => {
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 3, clock: () => T0 })

    assertEquals(limiter.check("a").remaining, 2)
    assertEquals(limiter.check("a").remaining, 1)
    assertEquals(limiter.check("a").remaining, 0)
    assertEquals(limiter.check("a").limit, 3)
  })

  it("allows at exactly the window edge when the oldest event expires", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock })

    assertEquals(limiter.check("a").allowed, true)
    advance(1000)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("denies one millisecond before the window edge", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock })

    limiter.check("a")
    advance(999)
    const denied = limiter.check("a")
    assertEquals(denied.allowed, false)
    assertEquals(denied.retryAfterMs, 1)
  })

  it("allows one millisecond after the window edge", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock })

    limiter.check("a")
    advance(1001)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("slides: a burst at second 0 does not regain room 1 ms into a 10 s window", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 10_000, limit: 2, clock })

    limiter.check("a")
    limiter.check("a")
    advance(1)
    assertEquals(limiter.check("a").allowed, false)
    // A fixed window that started at second 0 would have handed out a third request here.
    advance(9_998)
    assertEquals(limiter.check("a").allowed, false)
    advance(1)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("frees a slot one window after the first event, not one window after the last", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 2, clock })

    limiter.check("a")
    advance(400)
    const second = limiter.check("a")
    assertEquals(second.resetAfterMs, 600)

    // At the first event's edge it expires, so a third request is allowed even though the second
    // event is only 600 ms old — a fixed window anchored on the last request would deny here.
    advance(600)
    const third = limiter.check("a")
    assertEquals(third.allowed, true)
    assertEquals(third.resetAfterMs, 400)
  })

  it("does not add an event for a rejected request", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock })

    limiter.check("a")
    advance(500)
    for (let i = 0; i < 50; i++) assertEquals(limiter.check("a").allowed, false)
    // A rejected request that stored its timestamp would extend the window on every attempt.
    advance(500)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("keeps the map bounded when keys rotate and time advances", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 1000, clock })

    for (let i = 0; i < 500; i++) {
      limiter.check(`key-${i}`)
      // No sweep is due yet, so every distinct key is a new bucket: the map grows by exactly one
      // per key and cannot lag behind.
      assertEquals(limiter.size, i + 1)
    }
    assertEquals(limiter.size, 500)

    // Nothing from this batch is inside its window any more, so a sweep must drop all of it.
    advance(10_000)
    limiter.check("fresh")
    assertEquals(limiter.size, 1)
  })

  it("never lets a new key evict a bucket that is still counting", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 1000, clock })

    limiter.check("attacker")
    assertEquals(limiter.check("attacker").allowed, false)

    // 500 brand-new keys arriving while the attacker's bucket is active: insertion must not be
    // able to free a slot, or key rotation becomes a way to reset your own counter.
    for (let i = 0; i < 500; i++) limiter.check(`rotated-${i}`)
    assertEquals(limiter.size, 501)
    assertEquals(limiter.check("attacker").allowed, false)

    advance(1)
    assertEquals(limiter.check("attacker").allowed, false)
  })

  it("keeps blocking a rejected key across the idle grace, inside its window", () => {
    const { clock, advance } = fakeClock()
    // `idleMs` is deliberately shorter than `windowMs` so the idle grace comes due while the
    // bucket's event is still inside its window. A grace longer than the window cannot show the
    // bug, because the window expires first.
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 100, clock })

    assertEquals(limiter.check("attacker").allowed, true)
    assertEquals(limiter.check("attacker").allowed, false)

    // Past the idle grace, still inside the window, last check was a rejection. An `seenAt`-only
    // sweep would delete the bucket here and hand the attacker a fresh window.
    advance(700)
    assertEquals(limiter.sweep(), 0)
    assertEquals(limiter.check("attacker").allowed, false)

    advance(1000)
    assertEquals(limiter.check("attacker").allowed, true)
  })

  it("drops only idle buckets and never a bucket inside its window", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 5, idleMs: 500, clock })

    limiter.check("old")
    advance(2000)
    limiter.check("live")

    // "old" has been idle for longer than `idleMs` and holds nothing inside a window; "live" was
    // just used, so the sweep must leave it alone even though it is the older of the two keys.
    // The sweep that ran on the "live" check already dropped "old", so this explicit one finds
    // nothing — what matters is that "live" survived it.
    assertEquals(limiter.sweep(), 0)
    assertEquals(limiter.size, 1)
    assertEquals(limiter.check("live").allowed, true)

    // Once "live" itself falls outside its window, the next sweep takes it.
    advance(2000)
    limiter.check("fresh")
    assertEquals(limiter.size, 1)
  })

  it("holds a bucket with a live event for a full window plus the idle grace", () => {
    // Pins the sweep's own return value and the exact retention: a no-op `sweep()` (an early
    // `return 0`, for instance) would never reach the second assertion. Advances stay below
    // `windowMs` so no automatic sweep can fire first and make the return value unobservable.
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 10_000, limit: 1, idleMs: 500, clock })

    limiter.check("a")
    advance(200)
    assertEquals(limiter.sweep(), 0)
    assertEquals(limiter.size, 1)

    // Past `idleMs` on the last check, but the recorded event is not yet `windowMs + idleMs` old.
    assertEquals(limiter.sweep(), 0)
    assertEquals(limiter.size, 1)

    advance(10_500 - 200)
    assertEquals(limiter.sweep(), 1)
    assertEquals(limiter.size, 0)
  })

  it("sweeps on its own once the window has elapsed", () => {
    const { clock, advance } = fakeClock()
    let removed = -1
    const limiter = new MemoryRateLimiter({
      windowMs: 1000,
      limit: 1,
      idleMs: 0,
      clock,
      onSweep: (count) => {
        removed = count
      },
    })

    limiter.check("old")
    advance(2000)
    limiter.check("new")
    assertEquals(removed, 1)
  })

  it("schedules its automatic sweep from the injected clock, never the wall clock", () => {
    // Guards the `mig:28` bug this port fixes. `lastSweepAt` is seeded in the constructor: if that
    // seed were `Date.now()` instead of `clock()`, the limiter would run on two clocks at once and
    // `now - lastSweepAt` could go negative, so no automatic sweep would ever fire.
    //
    // Fixture-dependent on purpose: the mechanism is the negative difference, so this only reddens
    // while the fixture clock sits *behind* the wall clock — it does, and it stays there because it
    // is a literal far in the past. A future fixture dated ahead of now would silently stop
    // detecting the mutation, so keep any replacement clock behind `Date.now()`.
    const { clock, advance } = fakeClock(1_000_000_000_000)
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 0, clock })

    limiter.check("a")
    assertEquals(limiter.size, 1)

    advance(1000)
    limiter.check("b") // window elapsed on the injected clock: the sweep must run first
    assertEquals(limiter.size, 1)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("everts in one slice per prune instead of shifting events out one at a time", () => {
    // A regression tripwire, not a complexity bound. It exists because reverting the `mig:47-49`
    // fix to the `while (…) events.shift()` loop is behaviour-preserving and so invisible to every
    // other assertion. Counting array operations rather than timing them keeps it deterministic —
    // the measured gap is 7.58 us/check against 0.36 — but it does assert *implementation shape*:
    // an equivalent single-call `events.splice(0, live)` refactor (also O(n), same semantics) will
    // FAIL this test. If you are here because it went red after an optimization, check the
    // semantics before assuming a regression; a genuine improvement may need this test rewritten.
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 100, limit: 4, idleMs: 10_000, clock })
    for (let i = 0; i < 4; i++) {
      advance(10)
      limiter.check("a")
    }

    const originalShift = Array.prototype.shift
    const originalSlice = Array.prototype.slice
    let shifts = 0
    let slices = 0
    Array.prototype.shift = function (this: unknown[]) {
      shifts += 1
      return Reflect.apply(originalShift, this, [])
    }
    Array.prototype.slice = function (this: unknown[], start?: number, end?: number) {
      slices += 1
      return Reflect.apply(originalSlice, this, [start, end])
    }
    try {
      // Past the window, so the four recorded events are stale. The first check triggers the
      // automatic sweep and survives it (long idle grace); the second finds them still in the
      // bucket and prunes them, which is the code path under test.
      advance(80)
      limiter.check("a")
      limiter.check("a")
    } finally {
      Array.prototype.shift = originalShift
      Array.prototype.slice = originalSlice
    }

    assertEquals(slices >= 1, true)
    assertEquals(shifts, 0)
  })

  it("resets one key without touching another", () => {
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })

    limiter.check("a")
    limiter.check("b")
    limiter.reset("a")
    assertEquals(limiter.check("a").allowed, true)
    assertEquals(limiter.check("b").allowed, false)
  })

  it("clears every bucket", () => {
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })

    limiter.check("a")
    limiter.check("b")
    limiter.clear()
    assertEquals(limiter.size, 0)
    assertEquals(limiter.check("a").allowed, true)
  })

  it("never holds more buckets than maxBuckets, however many keys arrive", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 5, maxBuckets: 100, clock })
    for (let i = 0; i < 5000; i++) {
      limiter.check(`ip:198.18.${i >> 8}.${i & 255}`)
      if (i % 10 === 0) advance(1)
      assertEquals(limiter.size <= 100, true, `size ${limiter.size} after key ${i}`)
    }
    assertEquals(limiter.size, 100)
  })

  it("makes room for a new key by dropping buckets with nothing inside the window", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 1, maxBuckets: 2, clock })
    limiter.check("old")
    advance(500)
    limiter.check("recent")
    advance(500) // "old" is now exactly one window old: no longer inside it
    assertEquals(limiter.check("new").allowed, true)
    assertEquals(limiter.size, 2)
    // "recent" was kept: it is still limited.
    assertEquals(limiter.check("recent").allowed, false)
  })

  it("refuses a new key when every held bucket is active, until the first falls idle", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 1000, limit: 3, maxBuckets: 2, clock })
    limiter.check("a")
    advance(200)
    limiter.check("b")
    advance(100)

    const refused = limiter.check("c")
    assertEquals(refused, {
      allowed: false,
      remaining: 0,
      retryAfterMs: 700,
      resetAfterMs: 700,
      limit: 3,
    })
    assertEquals(limiter.size, 2)
    // A key already held is still served while the limiter is full.
    assertEquals(limiter.check("a").allowed, true)

    advance(699)
    assertEquals(limiter.check("c").allowed, false)
    // "a" was checked again at +300, so the first bucket to fall idle is "b", at +1200.
    advance(1)
    assertEquals(limiter.check("c").allowed, false)
    advance(200)
    assertEquals(limiter.check("c").allowed, true)
    assertEquals(limiter.size, 2)
  })

  it("never evicts a limited bucket to make room, so a flood of new keys cannot reset it", () => {
    const { clock, advance } = fakeClock()
    const limiter = new MemoryRateLimiter({ windowMs: 60_000, limit: 2, maxBuckets: 10, clock })
    limiter.check("user:alice")
    limiter.check("user:alice")
    assertEquals(limiter.check("user:alice").allowed, false)
    for (let i = 0; i < 1000; i++) {
      limiter.check(`user:flood-${i}`)
      advance(1)
    }
    assertEquals(limiter.check("user:alice").allowed, false)
  })

  it("refuses a maxBuckets that is not a whole number of at least one", () => {
    for (const maxBuckets of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      let message = ""
      try {
        new MemoryRateLimiter({ windowMs: 1000, limit: 1, maxBuckets })
      } catch (error) {
        message = (error as Error).message
      }
      assertEquals(message, "maxBuckets must be an integer >= 1", `maxBuckets=${maxBuckets}`)
    }
  })

  it("refuses a window that would deny everything", () => {
    let message = ""
    try {
      new MemoryRateLimiter({ windowMs: 0, limit: 1 })
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message, "windowMs must be > 0")
  })

  it("refuses an idle grace that would void the live-event guarantee", () => {
    // `idleMs` is the precondition of the sweep's guarantee: negative lets a bucket holding a live
    // event be dropped, and `NaN` makes every comparison false so the sweep never runs at all.
    for (const idleMs of [-1, -(Number.MAX_SAFE_INTEGER), Number.NaN, Number.POSITIVE_INFINITY]) {
      let message = ""
      try {
        new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs })
      } catch (error) {
        message = (error as Error).message
      }
      assertEquals(message, "idleMs must be a finite number >= 0", `idleMs=${idleMs}`)
    }
  })

  it("accepts an idle grace of zero and a fractional one", () => {
    const { clock } = fakeClock()
    assertEquals(new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 0, clock }).size, 0)
    assertEquals(new MemoryRateLimiter({ windowMs: 1000, limit: 1, idleMs: 0.5, clock }).size, 0)
  })

  it("refuses a limit that would allow everything", () => {
    let message = ""
    try {
      new MemoryRateLimiter({ windowMs: 1000, limit: 0 })
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message, "limit must be >= 1")
  })
})

describe("createMemoryRateLimiter", () => {
  it("builds a limiter that limits", () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 10, clock: () => T0 })

    for (let i = 0; i < 10; i++) assertEquals(limiter.check("ip:203.0.113.9").allowed, true)
    assertEquals(limiter.check("ip:203.0.113.9").allowed, false)
  })
})

describe("StoreRateLimiter", () => {
  it("rejects the 4th request through a store", async () => {
    const store = fakeStore()
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 3, clock: () => T0 })

    assertEquals((await limiter.check("a")).allowed, true)
    assertEquals((await limiter.check("a")).allowed, true)
    assertEquals((await limiter.check("a")).allowed, true)
    const denied = await limiter.check("a")
    assertEquals(denied.allowed, false)
    assertEquals(denied.retryAfterMs, 1000)
    assertEquals(denied.remaining, 0)
    assertEquals(denied.limit, 3)
  })

  it("allows at exactly the window edge from recorded events", async () => {
    const store = fakeStore()
    const { clock, advance } = fakeClock()
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 1, clock })

    await limiter.check("a")
    advance(999)
    assertEquals((await limiter.check("a")).allowed, false)
    advance(1)
    assertEquals((await limiter.check("a")).allowed, true)
  })

  it("keeps a rejected request out of the recorded window", async () => {
    const store = fakeStore()
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 1, clock: () => T0 })

    await limiter.check("a")
    await limiter.check("a")
    await limiter.check("a")
    assertEquals(store.entries.get("a"), [T0])
  })

  it("resets one key", async () => {
    const store = fakeStore()
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 1, clock: () => T0 })

    await limiter.check("a")
    await limiter.reset("a")
    assertEquals((await limiter.check("a")).allowed, true)
  })

  it("writes to the store only on an accepted request, never on a rejection", async () => {
    // Reproduces the audit's measurement: 100 requests at `limit: 2` counted 100 writes, one per
    // rejected request, because the reject branch re-wrote the same unchanged events. A rejected
    // request adds no event, so nothing about the stored entry needs to change.
    const store = fakeStore()
    const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock: () => T0 })

    for (let i = 0; i < 100; i++) await limiter.check("attacker")

    assertEquals(store.writes, 2)
  })
})

describe("rateLimitKey", () => {
  it("prefixes the identity with its kind", () => {
    assertEquals(rateLimitKey(RateLimitKind.User, "42"), "user:42")
    assertEquals(rateLimitKey(RateLimitKind.Ip, "203.0.113.9"), "ip:203.0.113.9")
  })

  it("scopes keys so two limiters sharing a backend do not collide", () => {
    assertEquals(rateLimitKey(RateLimitKind.User, "42", "chart:"), "chart:user:42")
  })
})
