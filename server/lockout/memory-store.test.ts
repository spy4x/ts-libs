import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryLockoutStore } from "./memory-store.ts"
import { createLockout, type LockoutPolicy } from "./mod.ts"
import { describeLockoutStoreContract } from "./store-contract.test.ts"

describeLockoutStoreContract("MemoryLockoutStore", ({ createMissing }) => {
  const store = new MemoryLockoutStore({ createMissing })
  return Promise.resolve({
    store,
    track: (subject) => Promise.resolve(store.track(subject)),
    read: (subject) => Promise.resolve(store.get(subject)),
    close: () => Promise.resolve(),
  })
})

describe("MemoryLockoutStore", () => {
  it("hands out copies, so a caller cannot edit a stored counter", async () => {
    const store = new MemoryLockoutStore()
    await store.update("ann", (current) => current && { ...current, failures: 3 })
    const read = store.get("ann")
    if (read === undefined) throw new Error("expected a counter")
    read.failures = 0
    expect(store.get("ann")?.failures).toBe(3)
  })

  it('counts the number 1 and the string "1" as one subject', async () => {
    const store = new MemoryLockoutStore()
    await store.update(1, (current) => current && { ...current, failures: 2 })
    await store.update("1", (current) => current && { ...current, failures: current.failures + 1 })
    expect(store.get(1)?.failures).toBe(3)
    expect(store.get("1")?.failures).toBe(3)
  })

  it("rejects instead of throwing when the change throws", () => {
    const store = new MemoryLockoutStore()
    const pending = store.update("ann", () => {
      throw new RangeError("boom")
    })
    expect(pending).toBeInstanceOf(Promise)
    return pending.then(
      () => Promise.reject(new Error("expected a rejection")),
      (error: unknown) => expect(error).toBeInstanceOf(RangeError),
    )
  })
})

/** Far from the host clock, so a store that reads the host clock is caught. */
const T0 = Date.UTC(2001, 0, 1)
const QUIET_MS = 10_000
/** Two free failures, then a lock that outlasts the quiet period. */
const POLICY: LockoutPolicy = {
  freeFailures: 2,
  firstLockMs: 30_000,
  maxLockMs: 60_000,
  quietResetMs: QUIET_MS,
}

/** A store, a lockout over it and the one clock both read, which the test moves. */
function open(options: { maxEntries?: number; sweep?: boolean } = {}) {
  const clock = { at: T0, now: () => clock.at }
  const store = options.sweep === false
    ? new MemoryLockoutStore({ clock })
    : new MemoryLockoutStore({ clock, quietResetMs: QUIET_MS, maxEntries: options.maxEntries })
  const lockout = createLockout({ store, clock, ...POLICY })
  const guessWrong = async (subject: string): Promise<number> => {
    const waitMs = await lockout.begin(subject)
    if (waitMs === 0) await lockout.fail(subject)
    return waitMs
  }
  return { clock, store, lockout, guessWrong }
}

describe("MemoryLockoutStore sweep", () => {
  it("drops an unlocked counter once its last failure is older than quietResetMs", async () => {
    const { clock, store, guessWrong } = open()
    await guessWrong("ann")
    clock.at += QUIET_MS - 1
    expect(store.sweep()).toBe(0)
    expect(store.get("ann")?.failures).toBe(1)
    clock.at += 1
    expect(store.sweep()).toBe(1)
    expect(store.get("ann")).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it("keeps a locked counter until its lock ends, however old its last failure", async () => {
    const { clock, store, guessWrong } = open()
    for (let i = 0; i < 3; i++) await guessWrong("ann")
    const lockedUntil = store.get("ann")?.lockedUntil
    expect(lockedUntil).toBe(T0 + 30_000)
    clock.at = T0 + 30_000 - 1
    expect(store.sweep()).toBe(0)
    expect(await guessWrong("ann")).toBe(1)
    clock.at = T0 + 30_000
    expect(store.sweep()).toBe(1)
  })

  it("keeps the failure count through a correct secret and the sweep after it", async () => {
    const { clock, store, lockout, guessWrong } = open()
    await guessWrong("ann")
    await guessWrong("ann")
    clock.at += QUIET_MS - 1
    expect(await lockout.begin("ann")).toBe(0)
    await lockout.refund("ann")
    expect(store.sweep()).toBe(0)
    expect(store.get("ann")?.failures).toBe(2)
  })

  it("keeps a counter that was written inside the quiet period", async () => {
    const { clock, store, lockout } = open()
    await lockout.fail("ann")
    clock.at += QUIET_MS - 1
    // Counted just before the quiet period ends: the last failure time stays the old one.
    expect(await lockout.begin("ann")).toBe(0)
    clock.at += 1
    expect(store.sweep()).toBe(0)
    await lockout.fail("ann")
    expect(store.get("ann")?.failures).toBe(1)
  })

  it("keeps a non-zero count that has no failure time", async () => {
    const { clock, store } = open()
    await store.update("ann", () => ({ failures: 3, lockedUntil: null, lastFailureAt: null }))
    clock.at += 100 * QUIET_MS
    expect(store.sweep()).toBe(0)
    expect(store.get("ann")?.failures).toBe(3)
  })

  it("keeps a counter whose failure time is newer than its last write", async () => {
    const { clock, store } = open()
    // As a lockout on a clock ahead of the store's would write it.
    const lastFailureAt = T0 + 5_000
    await store.update("ann", () => ({ failures: 1, lockedUntil: null, lastFailureAt }))
    clock.at = T0 + QUIET_MS
    expect(store.sweep()).toBe(0)
    clock.at = lastFailureAt + QUIET_MS
    expect(store.sweep()).toBe(1)
  })

  it("answers every check as a store that never sweeps does", async () => {
    const swept = open()
    const kept = open({ sweep: false })
    // A fixed pseudo-random script: three subjects guess, sometimes rightly, at uneven intervals.
    let seed = 12345
    const next = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % below
    }
    const steps = [1, 500, 4_000, QUIET_MS - 1, QUIET_MS, 30_000, 61_000]
    let drops = 0
    for (let i = 0; i < 3000; i++) {
      const subject = `s${next(3)}`
      const right = next(5) === 0
      const waits: number[] = []
      for (const { lockout } of [swept, kept]) {
        const waitMs = await lockout.begin(subject)
        if (waitMs === 0) await (right ? lockout.refund(subject) : lockout.fail(subject))
        waits.push(waitMs)
      }
      expect([i, waits[0]]).toEqual([i, waits[1]])
      const advance = steps[next(steps.length)] as number
      swept.clock.at += advance
      kept.clock.at += advance
      drops += swept.store.sweep()
    }
    // The script is only a proof if the sweep really dropped counters along the way.
    expect(drops).toBeGreaterThan(100)
  })

  it("sweeps on its own once a quiet period has passed since the last sweep", async () => {
    const { clock, store, guessWrong } = open()
    for (let i = 0; i < 50; i++) await guessWrong(`s${i}`)
    expect(store.size).toBe(50)
    clock.at += QUIET_MS
    await guessWrong("late")
    expect(store.size).toBe(1)
  })

  it("sweeps on its own within 512 updates when no quiet period has passed", async () => {
    const { clock, store, lockout, guessWrong } = open()
    for (let i = 0; i < 50; i++) await guessWrong(`s${i}`)
    clock.at += QUIET_MS - 1
    expect(store.sweep()).toBe(0)
    clock.at += 1
    for (let i = 0; i < 511; i++) await lockout.fail("busy")
    expect(store.size).toBe(51)
    await lockout.fail("busy")
    expect(store.size).toBe(1)
  })

  it("drops nothing when quietResetMs is left out", async () => {
    const { clock, store, lockout, guessWrong } = open({ sweep: false })
    for (let i = 0; i < 50; i++) await guessWrong(`s${i}`)
    clock.at += 1000 * QUIET_MS
    for (let i = 0; i < 600; i++) await lockout.fail("busy")
    expect(store.sweep()).toBe(0)
    expect(store.size).toBe(51)
  })
})

describe("MemoryLockoutStore maxEntries", () => {
  it("never holds more counters than maxEntries, however many subjects arrive", async () => {
    const { store, guessWrong } = open({ maxEntries: 100 })
    let refused = 0
    for (let i = 0; i < 10_000; i++) {
      await guessWrong(`s${i}`).catch(() => refused++)
      expect(store.size).toBeLessThanOrEqual(100)
    }
    expect(store.size).toBe(100)
    expect(refused).toBe(10_000 - 100)
  })

  it("refuses a new subject while every held counter still decides something", async () => {
    const { store, lockout, guessWrong } = open({ maxEntries: 2 })
    await guessWrong("a")
    await guessWrong("b")
    await expect(lockout.begin("c")).rejects.toThrow("lockout store is full")
    expect(() => store.track("c")).toThrow("lockout store is full")
    expect(store.get("c")).toBeUndefined()
    // A subject it already holds is still served.
    expect(await guessWrong("a")).toBe(0)
  })

  it("keeps a running lock and its count when new subjects flood a full store", async () => {
    const { clock, store, lockout, guessWrong } = open({ maxEntries: 5 })
    for (let i = 0; i < 3; i++) await guessWrong("victim")
    // Long past the quiet period, so only the lock still holds the counter.
    clock.at = T0 + 29_000
    for (let i = 0; i < 1000; i++) await lockout.begin(`flood${i}`).catch(() => {})
    expect(await lockout.begin("victim")).toBe(1000)
    expect(store.get("victim")?.failures).toBe(3)
    expect(store.size).toBe(5)
  })

  it("keeps a count inside its quiet period when new subjects flood a full store", async () => {
    const { clock, store, lockout, guessWrong } = open({ maxEntries: 5 })
    await guessWrong("guesser")
    await guessWrong("guesser")
    clock.at += QUIET_MS - 1
    for (let i = 0; i < 1000; i++) await lockout.begin(`flood${i}`).catch(() => {})
    expect(store.get("guesser")?.failures).toBe(2)
    // The third wrong guess is past the free budget, so the count was not reset.
    await guessWrong("guesser")
    expect(await lockout.begin("guesser")).toBe(30_000)
  })

  it("makes room for a new subject once a held counter has gone quiet", async () => {
    const { clock, store, guessWrong } = open({ maxEntries: 2 })
    await guessWrong("a")
    clock.at += 5_000
    await guessWrong("b")
    await expect(guessWrong("c")).rejects.toThrow("lockout store is full")
    // A sweep just before "a" goes quiet, so none is due when "c" comes back: the full store has
    // to make the room itself.
    clock.at = T0 + QUIET_MS - 1
    expect(store.sweep()).toBe(0)
    clock.at = T0 + QUIET_MS
    expect(await guessWrong("c")).toBe(0)
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")?.failures).toBe(1)
    await expect(guessWrong("d")).rejects.toThrow("lockout store is full")
  })

  it("makes room again each time another held counter goes quiet", async () => {
    const { clock, store, guessWrong } = open({ maxEntries: 2 })
    await guessWrong("a")
    clock.at = T0 + 5_000
    await guessWrong("b")
    await expect(guessWrong("c")).rejects.toThrow("lockout store is full")
    clock.at = T0 + QUIET_MS - 1
    expect(store.sweep()).toBe(0)
    await expect(guessWrong("c")).rejects.toThrow("lockout store is full")
    clock.at = T0 + QUIET_MS
    expect(await guessWrong("c")).toBe(0)
    await expect(guessWrong("d")).rejects.toThrow("lockout store is full")
    clock.at = T0 + 5_000 + QUIET_MS
    expect(await guessWrong("d")).toBe(0)
    expect(store.get("b")).toBeUndefined()
    expect(store.size).toBe(2)
  })
})

describe("MemoryLockoutStore options", () => {
  it("refuses a sweep with createMissing: false, where a dropped subject is not counted", () => {
    expect(() => new MemoryLockoutStore({ createMissing: false, quietResetMs: 1000 })).toThrow(
      TypeError,
    )
  })

  it("refuses maxEntries without quietResetMs", () => {
    expect(() => new MemoryLockoutStore({ maxEntries: 10 })).toThrow(TypeError)
  })

  it("refuses a quietResetMs or maxEntries that is not a positive integer", () => {
    for (const quietResetMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MemoryLockoutStore({ quietResetMs })).toThrow(TypeError)
    }
    for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MemoryLockoutStore({ quietResetMs: 1000, maxEntries })).toThrow(TypeError)
    }
  })
})
