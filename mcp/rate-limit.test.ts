// Tests for the limiter. The behaviours that matter: the sliding window is correct, the
// map is bounded by a time-driven sweep, and — the one that matters most — a
// key-rotating client cannot reset another client's counter. The clock is injected; no
// test here sleeps.

import { assert, assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  clientIp,
  createRateLimitStore,
  MemoryRateLimitStore,
  retryAfterSeconds,
  SWEEP_EVERY_CHECKS,
} from "./rate-limit.ts"

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

  it("slides the window, so an event expires exactly windowMs after it happened", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 1_000, now: time.now })
    assertEquals(store.check("203.0.113.7").allowed, true)

    time.advance(999)
    assertEquals(store.check("203.0.113.7").allowed, false)

    time.advance(1)
    assertEquals(store.check("203.0.113.7").allowed, true)
  })

  it("does not allow 2 * limit across what a fixed window would call a boundary", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 5, windowMs: 1_000, now: time.now })
    for (let index = 0; index < 5; index += 1) store.check("203.0.113.7")

    // A fixed window would have reset at t0 + 1000 and handed out five more.
    time.advance(990)
    assertEquals(store.check("203.0.113.7").allowed, false)
    time.advance(5)
    assertEquals(store.check("203.0.113.7").allowed, false)
    time.advance(5)
    assertEquals(store.check("203.0.113.7").allowed, true)
  })

  it("does not extend the window when a rejected request retries", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 1_000, now: time.now })
    store.check("203.0.113.7")

    time.advance(500)
    for (let index = 0; index < 10; index += 1) store.check("203.0.113.7")

    // 1 000 ms after the single accepted event: allowed, because retries did not count.
    time.advance(500)
    assertEquals(store.check("203.0.113.7").allowed, true)
  })

  it("does not hand out a fresh budget when the wall clock steps backwards", () => {
    // A backwards observation used to unsort the bucket: `events` was no longer
    // non-decreasing, so the binary search in `firstLiveIndex` mislocated the live prefix
    // and `slice(live)` discarded events still inside the window. This is the reviewer's
    // reproduction against the pre-fix store: at head it accepted 4 requests inside one
    // 1 000 ms window instead of 2. Every verdict below except the count is the same
    // before and after the fix — the count is the defect.
    const wall = { t: 0 }
    const store = new MemoryRateLimitStore({ limit: 2, windowMs: 1_000, now: () => wall.t })
    let accepted = 0
    const check = (): boolean => {
      const result = store.check("203.0.113.7")
      if (result.allowed) accepted += 1
      return result.allowed
    }

    assertEquals(check(), true)
    wall.t -= 500
    assertEquals(check(), true)
    wall.t += 1_000
    assertEquals(check(), false)
    assertEquals(check(), false)

    // The defect's signature: three or more accepted inside one window.
    assertEquals(accepted, 2, `${accepted} requests accepted for a limit of 2`)
    // Denied, not reset: the store is still honouring the window it opened.
    const denied = store.check("203.0.113.7")
    assertEquals(denied.allowed, false)
    assertEquals(denied.retryAfterMs, 500)
  })

  it("cannot resurrect an expired event after a backwards step and a forwards recovery", () => {
    // The same defect one step later: with the bucket unsorted, the sliding prefix is
    // located wrongly after the clock recovers, so an event that had already expired is
    // counted again. This is the reviewer's reproduction without the clamping and with a
    // third request after the recovery — 3 accepted inside one 1 000 ms window, and the
    // final assertion reads 3. The three denied requests are denied with and without the
    // fix; the acceptance count is what the defect moves.
    const wall = { t: 0 }
    const store = new MemoryRateLimitStore({ limit: 2, windowMs: 1_000, now: () => wall.t })
    let accepted = 0
    const check = (): boolean => {
      const result = store.check("203.0.113.7")
      if (result.allowed) accepted += 1
      return result.allowed
    }

    assertEquals(check(), true)
    wall.t -= 1
    assertEquals(check(), true)
    // 999 ms forward, which puts the wall clock back where the second event was taken.
    wall.t += 999
    assertEquals(check(), false)
    // One millisecond later the first event is exactly 1 000 ms old and gone; with the
    // bucket sorted only the other event is still live, so this is the second denial. With
    // the bucket unsorted the recovery drops the wrong prefix and this is accepted.
    wall.t += 1
    assertEquals(check(), false)

    assertEquals(accepted, 2, `${accepted} requests accepted for a limit of 2`)
  })

  it("does not grant a fresh budget when the clock recovers to a pre-jump value", () => {
    const wall = { t: 0 }
    const store = new MemoryRateLimitStore({ limit: 2, windowMs: 1_000, now: () => wall.t })
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, false)

    // An hour forward: both events are far outside the window, so this is a fresh window.
    wall.t += 3_600_000
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, false)

    // A forward step is not clamped and not rewound, so the sequence keeps its progress.
    wall.t += 1_000
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, true)
    assertEquals(store.check("203.0.113.7").allowed, false)

    // The clock snapping back to before the jump must not reopen the window that the two
    // events above just spent: the clamped observation stays where those events put it.
    wall.t -= 3_600_000
    assertEquals(store.check("203.0.113.7").allowed, false)
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

  it("refuses a non-positive limit, window or idle grace", () => {
    assertThrows(() => new MemoryRateLimitStore({ limit: 0, windowMs: 60_000 }), Error, ">= 1")
    assertThrows(() => new MemoryRateLimitStore({ limit: 1, windowMs: 0 }), Error, "positive")
    assertThrows(
      () => new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, idleMs: -1 }),
      Error,
      "negative",
    )
  })
})

describe("no path from key rotation to a reset counter", () => {
  // The reviewer's exact reproduction against the superseded eviction policy, which capped
  // the map by least-recently-inserted order (a cap of 4 buckets at limit 3): the victim
  // spent its budget, an attacker rotated ten keys, the cap displaced the victim's bucket,
  // and the victim's next check came back {"allowed":true,"remaining":2}. That policy and
  // its `maxEntries` option are gone; eviction is idle-time-driven only, and the rows below
  // are what replaced the reproduction of the bypass.
  function spendVictimBudget(store: MemoryRateLimitStore): void {
    store.check("victim")
    store.check("victim")
    store.check("victim")
  }

  it("keeps the victim denied after an attacker rotates ten keys", () => {
    const store = new MemoryRateLimitStore({ limit: 3, windowMs: 60_000, now: clock().now })

    spendVictimBudget(store)
    assertEquals(store.check("victim").allowed, false, "the victim must be denied first")

    for (let index = 0; index < 10; index += 1) store.check(`attacker-${index}`)

    const after = store.check("victim")
    assertEquals(after.allowed, false)
    assertEquals(after.remaining, 0)
  })

  it("keeps the victim denied after 5 000 rotating keys", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({ limit: 3, windowMs: 60_000, now: time.now })

    spendVictimBudget(store)
    assertEquals(store.check("victim").allowed, false)

    for (let index = 0; index < 5_000; index += 1) {
      store.check(`attacker-${index}`)
      time.advance(1)
    }

    const after = store.check("victim")
    assertEquals(after.allowed, false)
    assertEquals(after.remaining, 0)
  })

  it("tracks a bucket per live key, with no silent cap to displace one", () => {
    // The documented memory model: buckets are bounded by activity in the window plus the
    // idle grace, not by a cap that can free a live bucket. A cap would make this 50 into
    // something smaller and hand one of these clients a fresh budget.
    const store = new MemoryRateLimitStore({
      limit: 1,
      windowMs: 60_000,
      idleMs: 60_000,
      now: clock().now,
    })
    for (let index = 0; index < 50; index += 1) store.check(`rotating-${index}`)

    assertEquals(store.size, 50)
    for (let index = 0; index < 50; index += 1) {
      store.check(`rotating-${index}`)
      assertEquals(store.check(`rotating-${index}`).allowed, false)
    }
  })

  it("does not free a live bucket for the new keys arriving behind it", () => {
    const store = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000, now: clock().now })
    store.check("first")
    // Under eviction-by-insertion-order "first" is dropped here. Under the idle sweep it
    // outlives any number of unrelated keys while it is still inside its window.
    for (let index = 0; index < 1_000; index += 1) store.check(`new-${index}`)

    assertEquals(store.check("first").allowed, false)
  })

  it("runs sweeps over a map containing a live victim and never drops that victim", () => {
    // The reviewer's reproduction, run long enough to cross the sweep's check-count
    // threshold repeatedly: the victim's own key stays live the whole time, and the
    // sweeps must never treat it as the disposable one.
    const time = clock()
    let sweeps = 0
    let removed = 0
    const store = new MemoryRateLimitStore({
      limit: 1,
      windowMs: 1_000,
      idleMs: 10_000,
      now: time.now,
      onSweep: (count) => {
        sweeps += 1
        removed += count
      },
    })

    // 200 rounds × 250 ms = 50 s of wall time. The victim is checked four times per
    // 1 000 ms window, so it lands one accepted request per window and is denied on the
    // three in between — for the whole test, deterministically. That is what makes "the
    // victim survived" an assertion about eviction rather than about expiry. The attacker
    // inserts a fresh key every round, so the sweeps have something real to collect and
    // cannot pass by doing nothing.
    for (let round = 0; round < 200; round += 1) {
      const victim = store.check("victim")
      assertEquals(
        victim.allowed,
        round % 4 === 0,
        `victim ${victim.allowed ? "allowed" : "denied"} at round ${round}`,
      )
      store.check(`rotating-${round}`)
      time.advance(250)
      if (round % 50 === 0) store.evict()
    }

    // Proof that the sweeps ran and did collect idle rotating keys, so the survival
    // asserted inside the loop was neither a no-op sweep nor a sweep that never fired.
    assert(sweeps >= 2, `only ${sweeps} sweeps ran`)
    assert(removed > 0, "the sweeps collected no idle rotating key at all")

    // 200 rounds at one accepted request per four checks: the steady state the loop
    // asserted, one budget per window and no more.
    assertEquals(store.size > 1, true, "the rotating attacker keys must still be tracked live")
    assertEquals(sweeps >= 4, true, `only ${sweeps} sweeps ran`)
  })

  it("never evicts on insertion, only on a sweep — and a sweep spares the victim", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 1,
      // Long window: the sweep's time trigger cannot fire, so only the check-count
      // trigger and the explicit call can run one.
      windowMs: 600_000,
      idleMs: 0,
      now: time.now,
    })
    store.check("victim")
    for (let index = 0; index < 1_000; index += 1) store.check(`rotating-${index}`)

    // No time passed, so every bucket is live: nothing was evicted for anyone, and the
    // victim is still at its limit after a sweep has run over the whole map.
    assertEquals(store.check("victim").allowed, false)
    store.evict()
    assertEquals(store.size, 1_001)
    assertEquals(store.check("victim").allowed, false)
  })

  it("forgets the counter only for a bucket that genuinely went idle past the grace", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 3,
      windowMs: 1_000,
      idleMs: 5_000,
      now: time.now,
    })
    spendVictimBudget(store)
    time.advance(6_100)
    assertEquals(store.evict(), 1)
    // This reset is the legitimate one: the victim has been idle for the whole grace and
    // has no event left inside a window. It is not reachable by key rotation.
    assertEquals(store.check("victim").remaining, 2)
  })
})

describe("MemoryRateLimitStore idle sweep", () => {
  it("drops a bucket once nothing has been seen for the idle grace", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 5,
      windowMs: 1_000,
      idleMs: 5_000,
      now: time.now,
    })
    store.check("203.0.113.7")
    assertEquals(store.size, 1)

    // Inside the grace: kept, even though its window has expired.
    time.advance(2_000)
    assertEquals(store.evict(), 0)
    assertEquals(store.size, 1)

    // Past window end + idle grace: dropped.
    time.advance(5_000)
    assertEquals(store.evict(), 1)
    assertEquals(store.size, 0)
  })

  it("sweeps a bucket only once its newest event has left the window", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 1,
      windowMs: 1_000,
      idleMs: 1_000,
      now: time.now,
    })
    store.check("203.0.113.7")

    // Window has expired, grace has not: the event is still within `windowMs + idleMs`.
    time.advance(1_500)
    assertEquals(store.evict(), 0)
    assertEquals(store.size, 1)

    // Window and grace both expired: swept.
    time.advance(600)
    assertEquals(store.evict(), 1)
    assertEquals(store.size, 0)
  })

  it("keeps a bucket alive whose last check was a rejection that stored no event", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 1,
      windowMs: 2_000,
      idleMs: 1_000,
      now: time.now,
    })
    store.check("203.0.113.7")
    time.advance(2_000)
    // The t0 event is exactly windowMs old, so it no longer counts: this request is
    // allowed and stores a new one.
    assertEquals(store.check("203.0.113.7").allowed, true)
    time.advance(100)
    // Denied by the newer event, and a rejection stores nothing.
    assertEquals(store.check("203.0.113.7").allowed, false)

    time.advance(1_000)
    // `seenAt` is now older than the 1 000 ms grace, so a sweep keyed on `seenAt` alone
    // would delete this bucket and hand the client a fresh budget. The newest event is
    // still inside the window, so the bucket is live and must survive.
    assertEquals(store.evict(), 0)
    assertEquals(store.size, 1)
    assertEquals(store.check("203.0.113.7").allowed, false)
  })

  it("is bounded by the sweep when a client rotates its address slowly", () => {
    const time = clock()
    const store = new MemoryRateLimitStore({
      limit: 5,
      windowMs: 1_000,
      idleMs: 1_000,
      now: time.now,
    })

    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 50; index += 1) store.check(`203.0.113.7:${round}:${index}`)
      // Every key from the previous round is now past window end + idle grace.
      time.advance(2_000)
    }

    assertEquals(store.size <= 50, true, `map grew to ${store.size}`)
  })

  it("forces a sweep every SWEEP_EVERY_CHECKS checks, so volume alone cannot outrun it", () => {
    const time = clock()
    let sweeps = 0
    const store = new MemoryRateLimitStore({
      limit: 1,
      // Long window, so the sweep's time trigger cannot fire during this test: what
      // crosses the threshold below is the check count, not elapsed time.
      windowMs: 600_000,
      idleMs: 0,
      now: time.now,
      onSweep: () => {
        sweeps += 1
      },
    })

    for (let index = 0; index < SWEEP_EVERY_CHECKS; index += 1) store.check(`key-${index}`)
    assertEquals(sweeps, 0)
    assertEquals(store.size, SWEEP_EVERY_CHECKS)

    // One more check crosses the threshold.
    store.check("key-final")
    assertEquals(sweeps, 1)
    // Every bucket is still inside its window at this timestamp, so the forced sweep
    // removes none of them — it is the volume that triggers it, not the volume that
    // decides what goes.
    assertEquals(store.size, SWEEP_EVERY_CHECKS + 1)
  })

  it("sweeps at most once per window when the time trigger fires", () => {
    const time = clock()
    let sweeps = 0
    const store = new MemoryRateLimitStore({
      limit: 1,
      windowMs: 1_000,
      idleMs: 0,
      now: time.now,
      onSweep: () => {
        sweeps += 1
      },
    })
    store.check("a")
    store.check("b")
    assertEquals(sweeps, 0)

    time.advance(1_000)
    store.check("c")
    assertEquals(sweeps, 1)

    store.check("d")
    assertEquals(sweeps, 1)
  })

  it("treats an expired window as a fresh budget for the same key", () => {
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

describe("createRateLimitStore", () => {
  it("returns a store the transport can use through the port alone", () => {
    const store = createRateLimitStore({ limit: 1, windowMs: 1_000, now: clock().now })
    assertEquals(store.check("a").allowed, true)
    assertEquals(store.check("a").allowed, false)
    assertEquals(store.evict(), 0)
    assertEquals(store.size, 1)
    assert(typeof store.check === "function")
  })
})
