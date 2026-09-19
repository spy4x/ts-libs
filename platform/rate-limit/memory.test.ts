import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  createMemoryRateLimiter,
  createStoreLimiter,
  MemoryRateLimiter,
  rateLimitKey,
  RateLimitKind,
  type RateLimitStore,
  resolveIdentityKey,
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
function fakeStore(): RateLimitStore & { entries: Map<string, number[]> } {
  const entries = new Map<string, number[]>()
  return {
    entries,
    read: (key: string) => Promise.resolve(entries.get(key)),
    write: (key: string, events: number[]) => {
      entries.set(key, [...events])
      return Promise.resolve()
    },
    delete: (key: string) => {
      entries.delete(key)
      return Promise.resolve()
    },
  }
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

  it("refuses a window that would deny everything", () => {
    let message = ""
    try {
      new MemoryRateLimiter({ windowMs: 0, limit: 1 })
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message, "windowMs must be > 0")
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

describe("resolveIdentityKey", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://localhost/auth/sign-in", { headers })

  it("prefers the authenticated user", async () => {
    const key = await resolveIdentityKey(request({ "cf-connecting-ip": "203.0.113.9" }), () => "42")
    assertEquals(key, "user:42")
  })

  it("falls back to the client IP", async () => {
    const key = await resolveIdentityKey(
      request({ "cf-connecting-ip": "203.0.113.9" }),
      () => undefined,
    )
    assertEquals(key, "ip:203.0.113.9")
  })

  it("ignores an empty user id", async () => {
    const key = await resolveIdentityKey(request({ "x-real-ip": "198.51.100.7" }), () => "")
    assertEquals(key, "ip:198.51.100.7")
  })

  it("carries a prefix through to both branches", async () => {
    assertEquals(
      await resolveIdentityKey(request(), () => "42", { prefix: "auth:" }),
      "auth:user:42",
    )
    assertEquals(
      await resolveIdentityKey(request({ "x-real-ip": "198.51.100.7" }), () => undefined, {
        prefix: "auth:",
      }),
      "auth:ip:198.51.100.7",
    )
  })
})
