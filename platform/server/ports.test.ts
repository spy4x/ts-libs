import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { systemClock } from "../universal/time.ts"
import { systemClockPort } from "./ports.ts"

describe("systemClockPort", () => {
  it("is the same clock as universal/time's systemClock (#71)", () => {
    // ClockPort is now an alias of Clock, so this is the same object, not just an
    // equivalent one: any caller holding one already holds the other.
    expect(systemClockPort).toBe(systemClock)
  })

  it("reads Date.now()", () => {
    const before = Date.now()
    const reading = systemClockPort.now()
    const after = Date.now()
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(after)
  })
})
