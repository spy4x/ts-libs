// Tests for the limiter. The two behaviours that matter: the window verdict is
// correct, and the tracked-key map stays bounded when a client rotates its address.
// The clock is injected — no test here sleeps.

import { assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { clientIp, MemoryRateLimitStore, retryAfterSeconds } from "./rate-limit.ts"

/** A manual clock. Tests advance it explicitly. */
function clock(start = 1_700_000_000_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number): void {
      now += ms
    },
  }
}

describe("MemoryRateLimitStore", () => {
  it("allows up to the limit and denies the request after it", () => {
    const store = new MemoryRateLimitStore({ limit: 3, windowMs: 60_000, now: clock().now })
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, true)
    const third = store.check("203.0.113.7")
    assertEquals(third.allowed, true)
    assertEquals(third.remaining, 0)

    const denied = store.check("203.0.113.7")
    assertEquals(denied.allowed, false)
    assertEquals(denied.remaining, 0)
    assertEquals(denied.retryAfterMs, 60_000)
  })

  it("counts each key independently", () => {
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, now: clock().now })
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, false)
    assertEquals(store.check("198.51.100.9").allowed, true)
  })

  it("resets the window once it has elapsed", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, now: time.now })
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, false)

    time.advance(60_000)
    assertEquals(store.check("203.0.113.7").allowed, true)
  })

  it("reports the remaining time of the window in Retry-After", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, now: time.now })
    store.check("203.0.113.7")
    time.advance(15_000)
    const denied = store.check("203.0.113.7")
    assertEquals(denied.allowed, false)
    assertEquals(denied.retryAfterMs, 45_000)
    assertEquals(retryAfterSeconds(denied.retryAfterMs), "45")
  })

  it("never reports a Retry-After below one second", () => {
    assertEquals(retryAfterSeconds(0), "1")
    assertEquals(retryAfterSeconds(1), "1")
    assertEquals(retryAfterSeconds(1_001), "2")
  })

  it("refuses a non-positive limit or window", () => {
    assertThrows(() => new MemoryRateLimitStore({ limit: 0, windowMs: 60_000 }), Error, "positive")
    assertThrows(() => new MemoryRateLimitStore({ limit: 1, windowMs: 0 }), Error, "positive")
    assertThrows(
      () => new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, maxEntries: 0 }),
      Error,
      "positive",
    )
  })
})

describe("MemoryRateLimitStore eviction", () => {
  it("drops an entry once its window is past the TTL", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 5,
      windowMs: 1_000,
      ttlMs: 5_000,
      now: time.now,
    })
    store.check("203.0.113.7")
    assertEquals(store.size, 1)

    // Inside the window and the TTL: kept.
    time.advance(2_000)
    store.evict()
    assertEquals(store.size, 1)

    // Past window end + TTL: dropped.
    time.advance(5_000)
    store.evict()
    assertEquals(store.size, 0)
  })

  it("keeps the map bounded when the client rotates its address", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 10,
      windowMs: 60_000,
      ttlMs: 60_000,
      maxEntries: 100,
      now: time.now,
    })

    for (let index = 0; index < 2_000; index += 1) {
      store.check(`203.0.113.${index % 254}:${index}`)
      time.advance(10)
    }

    assertEquals(store.size <= 100, true, `map grew to ${store.size}`)
  })

  it("keeps the map bounded by the TTL sweep alone when the cap is not reached", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 5,
      windowMs: 1_000,
      ttlMs: 1_000,
      // Far above the number of distinct keys below, so only the TTL sweep can bound
      // the map. This is the assertion that catches a missing sweep.
      maxEntries: 10_000,
      now: time.now,
    })

    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 50; index += 1) {
        store.check(`203.0.113.7:${round}:${index}`)
      }
      // Every key from the previous round is now past window end + TTL.
      time.advance(2_000)
    }

    assertEquals(store.size <= 50, true, `map grew to ${store.size}`)
  })

  it("evicts the least recently used key when the cap is reached", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 10,
      windowMs: 600_000,
      ttlMs: 600_000,
      maxEntries: 3,
      now: time.now,
    })

    store.check("oldest")
    store.check("middle")
    store.check("newest")
    // Touch "oldest" so "middle" becomes the least recently used entry.
    time.advance(1)
    store.check("oldest")

    time.advance(1)
    store.check("fourth")

    assertEquals(store.size, 3)
    // A fresh counter for an evicted key starts from one, which is the observable
    // consequence of the eviction.
    assertEquals(store.check("middle").remaining, 9)
  })

  it("forgets an evicted key's count, so the cap cannot be used to bypass the limit", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 10,
      windowMs: 600_000,
      ttlMs: 600_000,
      maxEntries: 2,
      now: time.now,
    })
    store.check("a")
    store.check("a")
    store.check("b")
    store.check("c")

    // "a" was evicted; documenting the tradeoff rather than pretending it survives.
    assertEquals(store.check("a").remaining, 9)
  })

  it("sweeps expired entries during check without an explicit evict call", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 5,
      windowMs: 1_000,
      ttlMs: 1_000,
      now: time.now,
    })
    for (let index = 0; index < 50; index += 1) store.check(`key-${index}`)
    assertEquals(store.size, 50)

    time.advance(2_000)
    store.check("fresh")
    assertEquals(store.size, 1)
  })

  it("treats a window that has already reset as a new window", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 2, windowMs: 1_000, now: time.now })
    store.check("a")
    store.check("a")
    assertEquals(store.check("a").allowed, false)

    time.advance(1_000)
    const reset = store.check("a")
    assertEquals(reset.allowed, true)
    assertEquals(reset.remaining, 1)
  })
})

describe("clientIp", () => {
  it("uses the leftmost x-forwarded-for entry", () => {
    const request = new Request("https://mcp.example.invalid/mcp", {
      headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" },
    })
    assertEquals(clientIp(request), "203.0.113.7")
  })

  it("falls back to x-real-ip", () => {
    const request = new Request("https://mcp.example.invalid/mcp", {
      headers: { "x-real-ip": "203.0.113.7" },
    })
    assertEquals(clientIp(request), "203.0.113.7")
  })

  it("uses a single bucket when no address is present, so the limit is not bypassable", () => {
    assertEquals(clientIp(new Request("https://mcp.example.invalid/mcp")), "unknown")
    assertEquals(
      clientIp(
        new Request("https://mcp.example.invalid/mcp", {
          headers: { "x-forwarded-for": "   " },
        }),
      ),
      "unknown",
    )
  })
})
