import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  createKvStore,
  denoKvBackend,
  type RateLimitKv,
  type RateLimitKvEntry,
  RateLimitStoreOverKv,
} from "./kv.ts"
import { createMemoryRateLimiter, createStoreLimiter, type RateLimitStore } from "./memory.ts"

/** Fixed start instant. Nothing here reads `Date.now()`. */
const T0 = 1_700_000_000_000

/** Manual clock. */
function fakeClock(start = T0): {
  clock: () => number
  advance: (ms: number) => void
  advanceTo: (at: number) => void
} {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
    advanceTo: (at: number) => {
      now = at
    },
  }
}

/**
 * Stand-in for `Deno.Kv`.
 *
 * Deno KV is the one backend this package cannot exercise in CI: the root `test` task grants
 * `--allow-read --allow-env` and nothing else, so `Deno.openKv()` — which wants `--unstable-kv`
 * plus a writable path — cannot be called from a test. The fake implements exactly the port the
 * adapter implements, records the TTL it was handed, and can be made to drop values the way a real
 * backend's expiry would.
 */
function fakeKv(): RateLimitKv & {
  entries: Map<string, { value: unknown; expireIn?: number }>
  expireAll(): void
} {
  const entries = new Map<string, { value: unknown; expireIn?: number }>()
  return {
    entries,
    expireAll: () => entries.clear(),
    get: (key: string) => Promise.resolve(entries.get(key)?.value),
    set: (key: string, value: unknown, options?: { expireIn?: number }) => {
      entries.set(key, { value, expireIn: options?.expireIn })
      return Promise.resolve()
    },
    delete: (key: string) => {
      entries.delete(key)
      return Promise.resolve()
    },
  }
}

/**
 * Stand-in for a `Deno.Kv` handle, exposing exactly the three operations `DenoKvLike` names.
 *
 * This is what makes the adapter itself testable: `denoKvBackend` consumes a port, not the global,
 * so no `--unstable-kv` and no writable path are needed to cover it.
 */
function fakeDenoKv() {
  const entries = new Map<string, { value: unknown; expireIn?: number }>()
  return {
    /** Raw keys, `[namespace, id]` joined, so key shape is assertable. */
    keys: () => [...entries.keys()],
    /** Number of raw keys held. */
    size: () => entries.size,
    /** TTL handed to the backend for a raw key (the `[namespace, id]` path joined with `|`). */
    ttl: (path: readonly string[] | string) =>
      entries.get(typeof path === "string" ? path : path.join("|"))?.expireIn,
    /** Place a value without going through the adapter. */
    setRaw: (key: string, value: unknown) => entries.set(key, { value }),
    get(path: readonly string[]) {
      return Promise.resolve(entries.get(path.join("|")) ?? { value: null })
    },
    set(path: readonly string[], value: unknown, options?: { expireIn?: number }) {
      entries.set(path.join("|"), { value, expireIn: options?.expireIn })
      return Promise.resolve({ ok: true })
    },
    delete(path: readonly string[]) {
      entries.delete(path.join("|"))
      return Promise.resolve()
    },
  }
}

/** The stored entry for `key`, or `undefined`. */
function entryOf(kv: ReturnType<typeof fakeKv>, key: string): RateLimitKvEntry | undefined {
  return kv.entries.get(key)?.value as RateLimitKvEntry | undefined
}

describe("createKvStore", () => {
  it("namespaces keys so two limiters can share a backend", async () => {
    const kv = fakeKv()
    const store = new RateLimitStoreOverKv({ backend: kv, keyPrefix: "ratelimit" })

    await store.write("ip:203.0.113.9", [T0], T0, 1000)
    assertEquals([...kv.entries.keys()], ["ratelimit:ip:203.0.113.9"])
    assertEquals(store.keyFor("ip:203.0.113.9"), "ratelimit:ip:203.0.113.9")
  })

  it("round-trips recorded timestamps", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0, T0 + 100], T0 + 100, 5000)
    assertEquals(await store.read("a", T0 + 200), [T0, T0 + 100])
  })

  it("returns undefined for a key that was never written", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    assertEquals(await store.read("absent", T0), undefined)
  })

  it("treats an entry past its expiry as absent and deletes it", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 1000)
    assertEquals(await store.read("a", T0 + 999), [T0])
    assertEquals(await store.read("a", T0 + 1000), undefined)
    assertEquals(kv.entries.has("ratelimit:a"), false)
  })

  it("hands the backend a TTL covering the window", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 60_000)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 60_000)
  })

  it("never asks the backend for a zero or negative TTL", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 0)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 1)
    await store.write("a", [T0], T0, Number.NaN)
    assertEquals(kv.entries.get("ratelimit:a")?.expireIn, 1)
  })

  it("ignores a value that is not an entry", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await kv.set("ratelimit:a", 42)
    assertEquals(await store.read("a", T0), undefined)
  })

  it("deletes a key", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv })

    await store.write("a", [T0], T0, 1000)
    await store.delete("a")
    assertEquals(kv.entries.size, 0)
  })

  it("stores everything below one namespace prefix", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv, keyPrefix: "auth" })

    await store.write("user:42", [T0], T0, 1000)
    assertEquals([...kv.entries.keys()], ["auth:user:42"])
    assertEquals(entryOf(kv, "auth:user:42")?.events, [T0])
  })
})

describe("StoreRateLimiter parity with MemoryRateLimiter", () => {
  /**
   * KV fake that honours the TTL it is handed, the way a real backend does.
   *
   * `expiresAt` is expressed on the same virtual timeline the limiter uses, so the entry's absolute
   * lifetime is offset into wall time before the backend stores it; that way the backend's own
   * `Date.now()` comparison agrees with the injected clock without the test reading real time.
   */
  function ttlAwareKv(): RateLimitKv {
    const skew = Date.now() - T0
    const entries = new Map<string, { expiresAt: number; events: number[] }>()
    return {
      get: (key: string) => Promise.resolve(entries.get(key)),
      set: (key: string, value: unknown, options?: { expireIn?: number }) => {
        const entry = value as { events: number[]; expiresAt: number }
        const ttlDeadline = options?.expireIn === undefined
          ? Infinity
          : Date.now() + options.expireIn
        entries.set(key, {
          expiresAt: Math.min(entry.expiresAt + skew, ttlDeadline),
          events: entry.events,
        })
        return Promise.resolve()
      },
      delete: (key: string) => {
        entries.delete(key)
        return Promise.resolve()
      },
    }
  }

  it("matches the memory limiter decision for decision across a window boundary", async () => {
    // The conformance test the "same window semantics" claim never had. Every other case here uses a
    // single-event bucket, where a TTL taken from the *oldest* event happens to be right because
    // oldest == newest. With three events the two diverge: an oldest-derived TTL lets the entry go
    // absent while newer events are still inside the window, so the store path hands out `limit`
    // extra requests. Measured before the fix at limit 3 / windowMs 1000: memory 3 in the window,
    // store 5.
    //
    // Deterministic: one injected clock drives both limiters, and the backend converts the entry's
    // lifetime into wall time only so its own `Date.now()` comparison agrees with the injected one.
    // No sleeping, no timing assertion — the advance is arithmetic.
    const kv = ttlAwareKv()
    const { clock, advanceTo } = fakeClock()
    const memory = createMemoryRateLimiter({ windowMs: 1000, limit: 3, clock })
    const store = createStoreLimiter(createKvStore({ backend: kv, clock }), {
      windowMs: 1000,
      limit: 3,
      clock,
    })

    const trace: string[] = []
    for (const at of [0, 997, 998, 1000, 1001, 1002, 1003]) {
      advanceTo(T0 + at)
      const fromMemory = memory.check("ip:203.0.113.9")
      const fromStore = await store.check("ip:203.0.113.9")
      trace.push(`${at} allowed=${fromMemory.allowed} remaining=${fromMemory.remaining}`)
      assertEquals(fromStore.allowed, fromMemory.allowed, `allowed diverged at +${at}ms`)
      assertEquals(fromStore.remaining, fromMemory.remaining, `remaining diverged at +${at}ms`)
    }

    assertEquals(trace, [
      "0 allowed=true remaining=2",
      "997 allowed=true remaining=1",
      "998 allowed=true remaining=0",
      "1000 allowed=true remaining=0",
      "1001 allowed=false remaining=0",
      "1002 allowed=false remaining=0",
      "1003 allowed=false remaining=0",
    ])
  })

  it("hands the backend a TTL covering the newest event, not the oldest", async () => {
    // Pins the derivation directly, through both branches: three accepted requests 150 ms apart
    // inside a 1000 ms window, then rejections. An oldest-derived TTL writes 700 or 500 on the last
    // two writes instead of 800, so the entry lapses while its newest event is still live.
    const writes: { events: number[]; ttlMs: number }[] = []
    let state: number[] = []
    const store: RateLimitStore = {
      read: () => Promise.resolve(state),
      write: (_key: string, events: number[], _now: number, ttlMs: number) => {
        writes.push({ events: [...events], ttlMs })
        state = [...events]
        return Promise.resolve()
      },
      delete: () => {
        state = []
        return Promise.resolve()
      },
    }
    const limiter = createStoreLimiter(store, { windowMs: 1000, limit: 3, clock: () => T0 })

    for (const at of [T0, T0 + 150, T0 + 300, T0 + 450, T0 + 500]) {
      await limiter.check("a", at)
    }

    assertEquals(writes.length, 5)
    assertEquals(writes[2]?.events, [T0, T0 + 150, T0 + 300])
    assertEquals(writes[2]?.ttlMs, 1000)
    // newest event is T0 + 300, checked at T0 + 500 → 800. Oldest (T0) would give 500.
    assertEquals(writes.at(-1)?.ttlMs, 800)
  })

  it("keeps a stored entry past the oldest event's expiry while a newer one is live", async () => {
    const kv = fakeKv()
    const store = createKvStore({ backend: kv, clock: () => T0 })

    // Two events inside a 1000 ms window, written with the TTL the limiter now derives.
    await store.write("a", [T0, T0 + 300], T0 + 300, 800)

    // The oldest event expired at T0 + 1000; the newer one has not, so the entry must survive.
    // This is exactly the moment an oldest-derived TTL threw it away and restarted the window.
    assertEquals(await store.read("a", T0 + 1000), [T0, T0 + 300])
    assertEquals(await store.read("a", T0 + 1100), undefined)
    assertEquals(kv.entries.has("ratelimit:a"), false)
  })
})

describe("StoreRateLimiter over the KV store", () => {
  it("draws two limiters on one key from a single shared counter", async () => {
    // Sequential on purpose: this pins shared-store accounting, not concurrency. True interleaving
    // is deliberately not atomic — see `kv.ts` and the README — so a test claiming otherwise would
    // claim a guarantee this package does not make.
    const kv = fakeKv()
    const { clock } = fakeClock()
    const store = createKvStore({ backend: kv, clock })
    const first = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock })
    const second = createStoreLimiter(store, { windowMs: 60_000, limit: 2, clock })

    assertEquals((await first.check("user:42")).allowed, true)
    assertEquals((await second.check("user:42")).allowed, true)
    assertEquals((await first.check("user:42")).allowed, false)
    assertEquals((await second.check("user:42")).allowed, false)
    assertEquals((await second.check("other")).allowed, true)
  })

  it("denies a replayed request while the stored entry is still current", async () => {
    const kv = fakeKv()
    const { clock } = fakeClock()
    const limiter = createStoreLimiter(createKvStore({ backend: kv, clock }), {
      windowMs: 1000,
      limit: 1,
      clock,
    })

    assertEquals((await limiter.check("a")).allowed, true)
    assertEquals((await limiter.check("a")).allowed, false)
  })

  it("reports a stored entry as absent once its own clock passes its expiry", async () => {
    // The store decides expiry from its clock, the limiter takes an explicit `now`. Advancing the
    // store's clock past `expiresAt` is what the assertions depend on, so removing the expiry check
    // fails this test; the earlier version advanced the *window* instead and passed either way.
    const kv = fakeKv()
    const clockFn = fakeClock()
    const store = createKvStore({ backend: kv, clock: clockFn.clock })

    await store.write("a", [T0], T0, 1000)
    assertEquals(await store.read("a"), [T0])

    // Past expiry but still inside the window, so only the expiry check can explain the result.
    clockFn.advance(1000)
    assertEquals(await store.read("a"), undefined)
    assertEquals(kv.entries.has("ratelimit:a"), false)
  })

  it("keeps serving an entry one millisecond short of its expiry", async () => {
    const kv = fakeKv()
    const clockFn = fakeClock()
    const store = createKvStore({ backend: kv, clock: clockFn.clock })

    await store.write("a", [T0], T0, 1000)
    clockFn.advance(999)
    assertEquals(await store.read("a"), [T0])
    assertEquals(kv.entries.has("ratelimit:a"), true)
  })
})

describe("denoKvBackend", () => {
  it("segments keys as [namespace, id]", async () => {
    const raw = fakeDenoKv()
    const backend = denoKvBackend(raw, "app")

    await backend.set("auth:user:42", { events: [T0], expiresAt: T0 + 1000 })
    assertEquals([...raw.keys()], ["app|auth:user:42"])
  })

  it("unwraps { value } and reports a missing key as undefined", async () => {
    const raw = fakeDenoKv()
    const backend = denoKvBackend(raw)

    assertEquals(await backend.get("absent"), undefined)
    await backend.set("present", 1)
    assertEquals(await backend.get("present"), 1)
  })

  it("treats a null value as absent, the way Deno KV reports a dropped key", async () => {
    const raw = fakeDenoKv()
    const backend = denoKvBackend(raw)

    raw.setRaw("rate-limit|gone", null)
    assertEquals(await backend.get("gone"), undefined)
  })

  it("passes the TTL through, and omits it when none was asked for", async () => {
    const raw = fakeDenoKv()
    const backend = denoKvBackend(raw)

    await backend.set("a", 1, { expireIn: 1000 })
    assertEquals(raw.ttl("rate-limit|a"), 1000)

    // No TTL is not a TTL of zero milliseconds.
    await backend.set("b", 1)
    assertEquals(raw.ttl("rate-limit|b"), undefined)
  })

  it("deletes through the adapter", async () => {
    const raw = fakeDenoKv()
    const backend = denoKvBackend(raw)

    await backend.set("a", 1)
    await backend.delete("a")
    assertEquals(raw.size(), 0)
  })

  it("drives a limiter end to end under the repo's test grants", async () => {
    // The adapter consumes its own port, so it is coverable with a fake; only `Deno.openKv()`
    // itself needs `--unstable-kv` and cannot run under this repo's test grants.
    const raw = fakeDenoKv()
    const { clock } = fakeClock()
    const limiter = createStoreLimiter(createKvStore({ backend: denoKvBackend(raw), clock }), {
      windowMs: 60_000,
      limit: 2,
      clock,
    })

    assertEquals((await limiter.check("user:42")).allowed, true)
    assertEquals((await limiter.check("user:42")).allowed, true)
    assertEquals((await limiter.check("user:42")).allowed, false)

    // One key in the backend, under the adapter's namespace, and visible to a second limiter that
    // shares the handle — which is the whole point of a KV-backed store.
    assertEquals(raw.size(), 1)
    assertEquals(raw.keys()[0].startsWith("rate-limit|"), true)
    const second = createStoreLimiter(createKvStore({ backend: denoKvBackend(raw), clock }), {
      windowMs: 60_000,
      limit: 2,
      clock,
    })
    assertEquals((await second.check("user:42")).allowed, false)
  })
})
