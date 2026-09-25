import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  type Clock,
  DAYS_OF_WEEK,
  formatTime,
  getDaysOfWeek,
  isValidDate,
  normalizeCalendarDate,
  systemClock,
  systemNow,
  timeAgo,
  TimeFormatter,
} from "./time.ts"
import { systemClock as rateLimitSystemClock } from "../rate-limit/memory.ts"

/** Clock frozen at 2024-03-12T14:30:00Z, so every assertion is host-zone and wall-clock free. */
function fixedClock(iso: string): Clock {
  const instant = new Date(iso).getTime()
  return { now: () => instant }
}

const UTC = { timeZone: "UTC", clock: fixedClock("2024-03-12T14:30:00Z") }

describe("getDaysOfWeek", () => {
  it("reads a Monday-first bitmask", () => {
    expect(getDaysOfWeek("1000001")).toEqual(["mon", "sun"])
    expect(getDaysOfWeek("1111111")).toEqual([...DAYS_OF_WEEK])
  })

  it("returns an empty list for an empty mask", () => {
    expect(getDaysOfWeek("")).toEqual([])
    expect(getDaysOfWeek("0000000")).toEqual([])
  })

  it("ignores digits past the seventh instead of returning undefined", () => {
    expect(getDaysOfWeek("10101010")).toEqual(["mon", "wed", "fri", "sun"])
  })
})

describe("isValidDate", () => {
  it("accepts a Date with a valid time", () => {
    expect(isValidDate(new Date("2024-03-12T00:00:00Z"))).toBe(true)
  })

  it("accepts an ISO date-prefixed string", () => {
    expect(isValidDate("2024-03-12")).toBe(true)
    expect(isValidDate("2024-03-12T14:30:00Z")).toBe(true)
  })

  it("rejects a non-date string, a number and a non-string object", () => {
    expect(isValidDate("12/03/2024")).toBe(false)
    expect(isValidDate(20240312)).toBe(false)
    expect(isValidDate({})).toBe(false)
    expect(isValidDate(null)).toBe(false)
  })

  it("rejects an invalid Date instance", () => {
    expect(isValidDate(new Date("nonsense"))).toBe(false)
  })

  it("does not by itself reject an impossible day, because Date rolls it over", () => {
    // This is why normalizeCalendarDate exists.
    expect(isValidDate("2023-02-30")).toBe(true)
  })
})

describe("normalizeCalendarDate", () => {
  it("accepts both separators and normalises to ISO", () => {
    expect(normalizeCalendarDate("2024.03.12")).toBe("2024-03-12")
    expect(normalizeCalendarDate("2024-03-12")).toBe("2024-03-12")
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeCalendarDate("  2024-03-12 ")).toBe("2024-03-12")
  })

  it("accepts a leap day in a leap year", () => {
    expect(normalizeCalendarDate("2024-02-29")).toBe("2024-02-29")
    expect(normalizeCalendarDate("2000-02-29")).toBe("2000-02-29")
  })

  it("rejects a leap day in a common year and in a century that is not a leap year", () => {
    expect(normalizeCalendarDate("2023-02-29")).toBeNull()
    expect(normalizeCalendarDate("1900-02-29")).toBeNull()
  })

  it("rejects an impossible day for the month", () => {
    expect(normalizeCalendarDate("2023-04-31")).toBeNull()
    expect(normalizeCalendarDate("2023-02-30")).toBeNull()
    expect(normalizeCalendarDate("2023-01-32")).toBeNull()
  })

  it("rejects a month or day of zero, and a non-positive year", () => {
    expect(normalizeCalendarDate("2023-00-10")).toBeNull()
    expect(normalizeCalendarDate("2023-01-00")).toBeNull()
    expect(normalizeCalendarDate("0000-01-10")).toBeNull()
  })

  it("rejects a malformed string rather than guessing", () => {
    expect(normalizeCalendarDate("2024-3-12")).toBeNull()
    expect(normalizeCalendarDate("12/03/2024")).toBeNull()
    expect(normalizeCalendarDate("not a date")).toBeNull()
    expect(normalizeCalendarDate("")).toBeNull()
  })
})

describe("formatTime", () => {
  it("renders an absent value as a dash", () => {
    expect(formatTime(null, UTC)).toBe("-")
    expect(formatTime(undefined, UTC)).toBe("-")
    expect(formatTime("", UTC)).toBe("-")
    expect(formatTime(0, UTC)).toBe("-")
  })

  it("renders a non-parseable value as a dash instead of Invalid Date", () => {
    expect(formatTime("nonsense", UTC)).toBe("-")
  })

  it("prefixes Today for an instant on the same calendar day in the target zone", () => {
    expect(formatTime("2024-03-12T09:05:00Z", UTC)).toBe("Today 09:05")
  })

  it("renders the full DD/MM/YYYY form for another day", () => {
    expect(formatTime("2023-12-03T14:30:00Z", UTC)).toBe("03/12/2023 14:30")
  })

  it("forces the dated form when full is set, even for today", () => {
    expect(formatTime("2024-03-12T09:05:00Z", { ...UTC, full: true })).toBe("12/03/2024 09:05")
  })

  it("returns the clock time alone when timeOnly is set", () => {
    expect(formatTime("2023-12-03T14:30:00Z", { ...UTC, timeOnly: true })).toBe("14:30")
  })

  it("resolves today in the target zone, not in the host zone", () => {
    // 2024-03-12T23:30Z is already 2024-03-13 08:30 in Tokyo, so it is "today" there.
    const tokyo = { timeZone: "Asia/Tokyo", clock: fixedClock("2024-03-13T05:00:00Z") }
    expect(formatTime("2024-03-12T23:30:00Z", tokyo)).toBe("Today 08:30")

    // The identical instant one zone over: in America/New_York it is still 2024-03-12 19:30, and
    // the same frozen clock (2024-03-12T14:30Z = 09:30 there) is on the 12th, so it is today too.
    const newYork = { timeZone: "America/New_York", clock: fixedClock("2024-03-12T14:30:00Z") }
    expect(formatTime("2024-03-12T23:30:00Z", newYork)).toBe("Today 19:30")

    // In the UTC zone with the Tokyo clock the calendar day differs, so the date is rendered.
    expect(formatTime("2024-03-12T23:30:00Z", { timeZone: "UTC", clock: tokyo.clock })).toBe(
      "12/03/2024 23:30",
    )
  })

  it("honours a per-call time zone override", () => {
    const formatter = new TimeFormatter({
      timeZone: "UTC",
      clock: fixedClock("2024-03-12T14:30:00Z"),
    })
    expect(formatter.format("2024-03-12T09:05:00Z", { timeZone: "Asia/Tokyo" })).toBe("Today 18:05")
  })
})

describe("timeAgo", () => {
  const formatter = new TimeFormatter({ clock: fixedClock("2024-03-12T14:30:00Z") })
  const ago = (iso: string) => formatter.ago(iso)

  it("renders an absent value as a dash", () => {
    expect(ago("")).toBe("-")
    expect(timeAgo(null)).toBe("-")
    expect(timeAgo("nonsense")).toBe("-")
  })

  it("collapses anything under ten seconds into a moment", () => {
    expect(ago("2024-03-12T14:29:59Z")).toBe("a moment ago")
    expect(ago("2024-03-12T14:30:00Z")).toBe("a moment ago")
  })

  it("counts seconds and pluralises correctly", () => {
    expect(ago("2024-03-12T14:29:45Z")).toBe("15 seconds ago")
    expect(ago("2024-03-12T14:29:49Z")).toBe("11 seconds ago")
  })

  it("counts minutes and hours", () => {
    expect(ago("2024-03-12T14:25:00Z")).toBe("5 minutes ago")
    expect(ago("2024-03-12T11:30:00Z")).toBe("3 hours ago")
    expect(ago("2024-03-12T13:30:00Z")).toBe("1 hour ago")
  })

  it("counts days up to thirty", () => {
    expect(ago("2024-03-11T14:30:00Z")).toBe("1 day ago")
    expect(ago("2024-02-20T14:30:00Z")).toBe("21 days ago")
  })

  it("switches to months at thirty days", () => {
    expect(ago("2024-02-11T14:30:00Z")).toBe("1 month ago")
    expect(ago("2023-05-12T14:30:00Z")).toBe("10 months ago")
  })

  it("says twelve months, never zero years, between 360 and 364 days", () => {
    expect(ago("2023-03-18T14:30:00Z")).toBe("12 months ago")
    expect(ago("2023-03-14T14:30:00Z")).toBe("12 months ago")
    expect(ago("2023-03-13T14:30:00Z")).toBe("1 year ago")
    expect(ago("2023-03-12T14:30:00Z")).toBe("1 year ago")
  })

  it("switches to years at twelve months", () => {
    expect(ago("2023-03-12T14:30:00Z")).toBe("1 year ago")
    expect(ago("2020-03-12T14:30:00Z")).toBe("4 years ago")
  })

  it("accepts a number and a Date as well as a string", () => {
    expect(ago("2024-03-11T14:30:00Z")).toBe(formatter.ago(new Date("2024-03-11T14:30:00Z")))
    expect(formatter.ago(new Date("2024-03-11T14:30:00Z").getTime())).toBe("1 day ago")
  })
})

describe("systemClock", () => {
  it("reads Date.now()", () => {
    const before = Date.now()
    const reading = systemClock.now()
    const after = Date.now()
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(after)
  })
})

describe("systemNow", () => {
  it("reads Date.now(), and so does rate-limit's systemClock", () => {
    const before = Date.now()
    for (const reading of [systemNow(), rateLimitSystemClock()]) {
      expect(reading).toBeGreaterThanOrEqual(before)
      expect(reading).toBeLessThanOrEqual(Date.now())
    }
  })
})
