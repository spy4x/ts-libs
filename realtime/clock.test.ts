import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { createSystemClock } from "./clock.ts"
import type { Clock, TimerClock } from "./mod.ts"

describe("createSystemClock", () => {
  it("reads Date.now() for now(), the same as @spy4x/platform's systemClock", () => {
    const clock = createSystemClock()
    const before = Date.now()
    const reading = clock.now()
    const after = Date.now()
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(after)
  })

  it("runs a callback after a real timeout and lets it be cleared", async () => {
    const clock = createSystemClock()
    let calls = 0
    const handle = clock.setTimeout(() => calls++, 5)
    clock.clearTimeout(handle)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30))
    expect(calls).toBe(0)
  })

  it("fires a timeout that is not cleared", async () => {
    const clock = createSystemClock()
    let calls = 0
    clock.setTimeout(() => calls++, 5)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30))
    expect(calls).toBe(1)
  })

  it("runs an interval repeatedly until cleared", async () => {
    const clock = createSystemClock()
    let calls = 0
    const handle = clock.setInterval(() => calls++, 5)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25))
    clock.clearInterval(handle)
    const callsAtClear = calls
    expect(callsAtClear).toBeGreaterThan(1)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
    expect(calls).toBe(callsAtClear)
  })
})

describe("Clock", () => {
  it("is still exported as the same type as TimerClock", () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
      : false
    const same: Equal<Clock, TimerClock> = true
    expect(same).toBe(true)
  })
})
