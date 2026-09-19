import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import {
  DAYS_IN_MONTH,
  MILLISECONDS_IN_SECOND,
  MONTHS_IN_YEAR,
  ONE_DAY_IN_MILLISECONDS,
  ONE_HOUR_IN_MILLISECONDS,
  ONE_MINUTE_IN_MILLISECONDS,
  ONE_MONTH_IN_MILLISECONDS,
  ONE_MONTH_IN_SECONDS,
  ONE_WEEK_IN_MILLISECONDS,
  ONE_YEAR_IN_MILLISECONDS,
  ONE_YEAR_IN_SECONDS,
} from "./time-constants.ts"

describe("time constants", () => {
  it("derives ONE_MONTH_IN_MILLISECONDS from ONE_MONTH_IN_SECONDS, not from the year", () => {
    // `gb/libs/shared/constants.ts:17` read `ONE_YEAR_IN_SECONDS * 1000`, making a
    // month equal to a year. Restoring that line turns all three expectations red.
    expect(ONE_MONTH_IN_MILLISECONDS).toBe(ONE_MONTH_IN_SECONDS * MILLISECONDS_IN_SECOND)
    expect(ONE_MONTH_IN_SECONDS).toBe(DAYS_IN_MONTH * 86_400)
  })

  it("makes a month exactly one twelfth of a year", () => {
    expect(ONE_MONTH_IN_MILLISECONDS * 12).toBe(ONE_YEAR_IN_MILLISECONDS)
    expect(ONE_MONTH_IN_SECONDS * 12).toBe(ONE_YEAR_IN_SECONDS)
    expect(MONTHS_IN_YEAR).toBe(12)
  })

  it("distinguishes a month from a year", () => {
    expect(ONE_MONTH_IN_MILLISECONDS).not.toBe(ONE_YEAR_IN_MILLISECONDS)
  })

  it("pins the month and year to hardcoded expected values", () => {
    // 30 days, and 12 nominal 30-day months = 360 days. A 365-day year would be 31_536_000_000,
    // which is what the buggy year-derived month constant was equal to.
    expect(ONE_MONTH_IN_MILLISECONDS).toBe(2_592_000_000)
    expect(ONE_YEAR_IN_MILLISECONDS).toBe(31_104_000_000)
    expect(ONE_MONTH_IN_MILLISECONDS * 12).toBe(ONE_YEAR_IN_MILLISECONDS)
    expect(ONE_YEAR_IN_MILLISECONDS).not.toBe(31_536_000_000)
  })

  it("pins every shorter unit to a hardcoded expected value", () => {
    expect(ONE_MINUTE_IN_MILLISECONDS).toBe(60_000)
    expect(ONE_HOUR_IN_MILLISECONDS).toBe(3_600_000)
    expect(ONE_DAY_IN_MILLISECONDS).toBe(86_400_000)
    expect(ONE_WEEK_IN_MILLISECONDS).toBe(604_800_000)
  })

  it("orders the units monotonically", () => {
    const ascending = [
      ONE_MINUTE_IN_MILLISECONDS,
      ONE_HOUR_IN_MILLISECONDS,
      ONE_DAY_IN_MILLISECONDS,
      ONE_WEEK_IN_MILLISECONDS,
      ONE_MONTH_IN_MILLISECONDS,
      ONE_YEAR_IN_MILLISECONDS,
    ]
    for (let i = 1; i < ascending.length; i++) {
      expect(ascending[i]).toBeGreaterThan(ascending[i - 1])
    }
  })
})
