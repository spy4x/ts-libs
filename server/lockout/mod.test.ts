import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryLockoutStore } from "./memory-store.ts"
import {
  beginCheck,
  createLockout,
  DEFAULT_LOCKOUT_POLICY,
  lockDelayMs,
  type LockoutPolicy,
  resolveLockoutPolicy,
} from "./mod.ts"

const { freeFailures, firstLockMs, maxLockMs } = DEFAULT_LOCKOUT_POLICY
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2001, 0, 1)

describe("lockDelayMs", () => {
  it("lets the first five wrong guesses through with no wait", () => {
    for (let failures = 0; failures <= freeFailures; failures++) {
      expect(lockDelayMs(failures)).toBe(0)
    }
  })

  it("waits 15 minutes after the sixth wrong guess and doubles for each one after", () => {
    expect([6, 7, 8, 9].map((failures) => lockDelayMs(failures))).toEqual([
      15 * MINUTE,
      30 * MINUTE,
      60 * MINUTE,
      120 * MINUTE,
    ])
  })

  it("never waits longer than one day, however many guesses were wrong", () => {
    expect(lockDelayMs(12)).toBe(16 * HOUR)
    expect(lockDelayMs(13)).toBe(24 * HOUR)
    expect(lockDelayMs(1_000_000)).toBe(maxLockMs)
    expect(lockDelayMs(Number.MAX_SAFE_INTEGER)).toBe(maxLockMs)
  })

  it("keeps a guesser under a 1% chance a year of hitting one of 3 valid six-digit codes", () => {
    // The worst case: the guesser tries again the moment each lock ends, for a year.
    const year = 365 * 24 * HOUR
    let now = 0
    let guesses = 0
    while (now < year) {
      guesses += 1
      now += lockDelayMs(guesses)
    }
    const chance = 1 - (1 - 3 / 1_000_000) ** guesses
    expect(guesses).toBeLessThan(400)
    expect(chance).toBeLessThan(0.01)
  })

  it("follows a custom policy's budget, first lock and cap", () => {
    const policy: LockoutPolicy = {
      freeFailures: 0,
      firstLockMs: 1000,
      maxLockMs: 3000,
      quietResetMs: HOUR,
    }
    expect([0, 1, 2, 3, 4].map((failures) => lockDelayMs(failures, policy))).toEqual([
      0,
      1000,
      2000,
      3000,
      3000,
    ])
  })

  it("reaches a maximum lock more than 30 doublings above the first", () => {
    const policy = { freeFailures: 0, firstLockMs: 1, maxLockMs: 2 ** 40, quietResetMs: HOUR }
    expect(lockDelayMs(36, policy)).toBe(2 ** 35)
    expect(lockDelayMs(41, policy)).toBe(2 ** 40)
    expect(lockDelayMs(5000, policy)).toBe(2 ** 40)
  })
})

describe("resolveLockoutPolicy", () => {
  it("fills every number the caller left out from the defaults", () => {
    expect(resolveLockoutPolicy()).toEqual(DEFAULT_LOCKOUT_POLICY)
    expect(resolveLockoutPolicy({ freeFailures: 3, maxLockMs: undefined })).toEqual({
      ...DEFAULT_LOCKOUT_POLICY,
      freeFailures: 3,
    })
  })

  it("refuses a negative, fractional or zero number, and a maximum below the first lock", () => {
    for (
      const overrides of [
        { freeFailures: -1 },
        { freeFailures: 1.5 },
        { firstLockMs: 0 },
        { quietResetMs: Number.NaN },
        { firstLockMs: 2 * HOUR, maxLockMs: HOUR },
      ]
    ) {
      expect(() => resolveLockoutPolicy(overrides)).toThrow(TypeError)
    }
  })
})

describe("beginCheck", () => {
  it("stamps the first counted check, so the quiet reset can forget one whose fail never ran", () => {
    const step = beginCheck({ failures: 0, lockedUntil: null, lastFailureAt: null }, NOW)
    expect(step).toEqual({
      next: { failures: 1, lockedUntil: null, lastFailureAt: NOW },
      waitMs: 0,
    })
    const later = NOW + DEFAULT_LOCKOUT_POLICY.quietResetMs
    expect(beginCheck({ failures: 4, lockedUntil: null, lastFailureAt: NOW }, later).next)
      .toEqual({ failures: 1, lockedUntil: null, lastFailureAt: later })
  })

  it("keeps the stamp of the last wrong guess while the count grows", () => {
    const step = beginCheck({ failures: 2, lockedUntil: null, lastFailureAt: NOW - HOUR }, NOW)
    expect(step.next).toEqual({ failures: 3, lockedUntil: null, lastFailureAt: NOW - HOUR })
  })

  it("sets the lock in advance when the counted check is past the budget", () => {
    const state = { failures: freeFailures, lockedUntil: null, lastFailureAt: NOW }
    expect(beginCheck(state, NOW).next?.lockedUntil).toBe(NOW + firstLockMs)
  })

  it("writes nothing and returns the time left while a lock runs", () => {
    const state = { failures: 9, lockedUntil: NOW + MINUTE, lastFailureAt: NOW }
    expect(beginCheck(state, NOW)).toEqual({ next: undefined, waitMs: MINUTE })
  })
})

describe("createLockout", () => {
  it("refuses an invalid policy when it is built", () => {
    expect(() => createLockout({ store: new MemoryLockoutStore(), firstLockMs: -1 })).toThrow(
      TypeError,
    )
  })

  it("rejects an empty, overlong or non-integer subject without touching the store", async () => {
    const store = new MemoryLockoutStore()
    const lockout = createLockout({ store })
    for (const subject of ["", Number.NaN, 1.5, 2 ** 60, "x".repeat(256)]) {
      await expect(lockout.begin(subject)).rejects.toThrow(TypeError)
      await expect(lockout.fail(subject)).rejects.toThrow(TypeError)
      await expect(lockout.refund(subject)).rejects.toThrow(TypeError)
      expect(store.get(subject)).toBeUndefined()
    }
  })

  it("applies a policy passed as options", async () => {
    const store = new MemoryLockoutStore()
    const lockout = createLockout({
      store,
      clock: { now: () => NOW },
      freeFailures: 0,
      firstLockMs: 1000,
    })
    expect(await lockout.begin(7)).toBe(0)
    expect(await lockout.begin(7)).toBe(1000)
  })
})
