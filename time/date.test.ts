import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  dayInMonth,
  daysInMonth,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  formatIsoDate,
  isSameDay,
  isValidDateRange,
  monthFirstWeekday,
  parseIsoDate,
  shiftMonth,
  startOfMonth,
  startOfQuarter,
  startOfYear,
} from "./date.ts"

describe("parseIsoDate", () => {
  it("reads midnight UTC of the date", () => {
    expect(parseIsoDate("2026-08-23")).toBe(Date.parse("2026-08-23T00:00:00Z"))
  })

  it("rejects a value that is not YYYY-MM-DD", () => {
    expect(() => parseIsoDate("23/08/2026")).toThrow("expected a YYYY-MM-DD date")
    expect(() => parseIsoDate("2026-8-23")).toThrow("expected a YYYY-MM-DD date")
    expect(() => parseIsoDate("")).toThrow("expected a YYYY-MM-DD date")
  })

  it("rejects a month the calendar does not have", () => {
    expect(() => parseIsoDate("2026-13-01")).toThrow("expected a YYYY-MM-DD date")
  })

  it("rejects a day the month does not have instead of rolling into the next month", () => {
    expect(() => parseIsoDate("2026-04-31")).toThrow("expected a YYYY-MM-DD date")
    expect(() => parseIsoDate("2026-02-29")).toThrow("expected a YYYY-MM-DD date")
  })

  it("accepts the leap day of a leap year", () => {
    expect(parseIsoDate("2028-02-29")).toBe(Date.parse("2028-02-29T00:00:00Z"))
  })
})

describe("formatIsoDate", () => {
  it("round-trips through parseIsoDate", () => {
    expect(formatIsoDate(parseIsoDate("2028-02-29"))).toBe("2028-02-29")
  })

  it("rejects an instant past the 9999 edge instead of returning a truncated expanded year", () => {
    // `toISOString` reports `+010000-01-01T00:00:00.000Z` there, and the bare slice this used to be
    // returned `+010000-01` — a string that is not a date at all. Ordinary route to it: one day
    // after the last supported day. The message names the truncated output, not the full instant.
    const after9999 = parseIsoDate("9999-12-31") + 86_400_000

    expect(() => formatIsoDate(after9999))
      .toThrow("expected a date in the 0001-9999 window, received: +010000-01")
  })

  it("rejects an instant in 1 BC, which toISOString writes with a signed six-digit year", () => {
    // 1 BC is the first instant below the window, and `Date` writes it
    // `-000001-06-15T00:00:00.000Z`; a bare slice would claim `-000001-06`. `parseIsoDate` cannot
    // reach this branch — its four-digit pattern rejects the input first — so `addDays` and
    // `endOfMonth` are the paths.
    const before0001 = Date.parse("-000001-06-15T00:00:00Z")

    expect(new Date(before0001).toISOString()).toBe("-000001-06-15T00:00:00.000Z")
    expect(() => formatIsoDate(before0001))
      .toThrow("expected a date in the 0001-9999 window, received: -000001-06")
  })

  it("passes year 0 through, the one year Date and Intl disagree about", () => {
    // `0000-06-15` is also 1 BC, but `Date` gives it a plain four-digit year, so it satisfies the
    // check and round-trips. `isoDateInTz` in `./tz.ts` is the half that disagrees, reporting
    // `0001-06-15`.
    expect(new Date(Date.parse("0000-06-15T00:00:00Z")).toISOString())
      .toBe("0000-06-15T00:00:00.000Z")
    expect(formatIsoDate(Date.parse("0000-06-15T00:00:00Z"))).toBe("0000-06-15")
    expect(parseIsoDate("0000-12-31")).toBe(Date.parse("0000-12-31T00:00:00Z"))
  })
})

describe("shiftMonth", () => {
  it("moves forward and back a month", () => {
    expect(shiftMonth("2026-08-01", 1)).toBe("2026-09-01")
    expect(shiftMonth("2026-08-01", -1)).toBe("2026-07-01")
  })

  it("lands on the first of the target month, never a clipped day", () => {
    expect(shiftMonth("2026-03-31", -1)).toBe("2026-02-01")
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-01")
  })

  it("crosses a year boundary in both directions", () => {
    expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01")
    expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-01")
  })

  it("handles a multi-year step", () => {
    expect(shiftMonth("2026-08-01", 25)).toBe("2028-09-01")
    expect(shiftMonth("2026-08-01", -20)).toBe("2024-12-01")
  })

  it("does not clamp: a month past 9999-12 is an error, not 9999-12-01", () => {
    // An earlier version built its answer directly and never passed through `formatIsoDate`, so it
    // handed back `10000-01-01` — five digits, not a date — while `addDays` and every other step
    // rejected the equivalent instant. Same convention as `addDays`: throw, and name the same
    // window.
    expect(() => shiftMonth("9999-12-01", 1))
      .toThrow("expected a date in the 0001-9999 window, received: +010000-01")
    expect(() => shiftMonth("9999-11-01", 3))
      .toThrow("expected a date in the 0001-9999 window, received: +010000-02")
    expect(() => shiftMonth("9999-12-31", 12))
      .toThrow("expected a date in the 0001-9999 window, received: +010000-12")
  })

  it("still resolves the months of 9999 that stay inside the window", () => {
    // The boundary is the month result, not the year: 9999 itself is supported, and so is the step
    // that lands on its own first day.
    expect(shiftMonth("9999-12-01", 0)).toBe("9999-12-01")
    expect(shiftMonth("9999-11-15", 1)).toBe("9999-12-01")
    expect(shiftMonth("9999-12-15", -1)).toBe("9999-11-01")
  })

  it("steps back out of 0001 into the year 0 the window excludes", () => {
    // Pinned, not fixed: year 0000 is a four-digit year `Date` keeps and `parseIsoDate` accepts, so
    // the window's lower edge is not a throw — it is a value the doc calls unsupported. Same
    // behaviour `addDays("0001-01-01", -1)` has, and the one the module docs name.
    expect(shiftMonth("0001-01-01", -1)).toBe("0000-12-01")
    expect(shiftMonth("0001-02-01", -1)).toBe("0001-01-01")
  })
})

describe("startOfMonth and endOfMonth", () => {
  it("bracket a 31-day month", () => {
    expect(startOfMonth("2026-08-23")).toBe("2026-08-01")
    expect(endOfMonth("2026-08-23")).toBe("2026-08-31")
  })

  it("bracket a 30-day month", () => {
    expect(endOfMonth("2026-04-15")).toBe("2026-04-30")
  })

  it("bracket February in a non-leap year", () => {
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28")
  })

  it("bracket February in a leap year", () => {
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29")
  })

  it("are idempotent on the first of the month", () => {
    expect(startOfMonth("2026-08-01")).toBe("2026-08-01")
  })
})

describe("startOfQuarter and endOfQuarter", () => {
  it("bracket Q1", () => {
    expect(startOfQuarter("2026-01-05")).toBe("2026-01-01")
    expect(endOfQuarter("2026-01-05")).toBe("2026-03-31")
  })

  it("bracket Q2", () => {
    expect(startOfQuarter("2026-05-31")).toBe("2026-04-01")
    expect(endOfQuarter("2026-05-31")).toBe("2026-06-30")
  })

  it("bracket Q3", () => {
    expect(startOfQuarter("2026-08-23")).toBe("2026-07-01")
    expect(endOfQuarter("2026-08-23")).toBe("2026-09-30")
  })

  it("bracket Q4", () => {
    expect(startOfQuarter("2026-11-30")).toBe("2026-10-01")
    expect(endOfQuarter("2026-11-30")).toBe("2026-12-31")
  })

  it("are stable on the first day of a quarter", () => {
    expect(startOfQuarter("2026-10-01")).toBe("2026-10-01")
  })
})

describe("startOfYear and endOfYear", () => {
  it("bracket the year", () => {
    expect(startOfYear("2026-08-23")).toBe("2026-01-01")
    expect(endOfYear("2026-08-23")).toBe("2026-12-31")
  })

  it("bracket a leap year", () => {
    expect(endOfYear("2028-06-01")).toBe("2028-12-31")
  })
})

describe("isSameDay", () => {
  it("matches identical dates", () => {
    expect(isSameDay("2026-08-23", "2026-08-23")).toBe(true)
  })

  it("separates neighbouring days", () => {
    expect(isSameDay("2026-08-23", "2026-08-24")).toBe(false)
    expect(isSameDay("2026-08-23", "2025-08-23")).toBe(false)
  })

  it("throws on a value that is not a date", () => {
    expect(() => isSameDay("2026-08-23", "yesterday")).toThrow("expected a YYYY-MM-DD date")
  })
})

describe("isValidDateRange", () => {
  it("accepts an ordered range and a single day", () => {
    expect(isValidDateRange({ from: "2026-08-01", to: "2026-08-23" })).toBe(true)
    expect(isValidDateRange({ from: "2026-08-23", to: "2026-08-23" })).toBe(true)
  })

  it("rejects a reversed range", () => {
    expect(isValidDateRange({ from: "2026-08-23", to: "2026-08-01" })).toBe(false)
  })

  it("rejects a half-typed or impossible range without throwing", () => {
    expect(isValidDateRange({ from: "", to: "" })).toBe(false)
    expect(isValidDateRange({ from: "2026-08-01", to: "" })).toBe(false)
    expect(isValidDateRange({ from: "2026-02-31", to: "2026-03-01" })).toBe(false)
  })
})

describe("monthFirstWeekday", () => {
  it("reports Monday as 0", () => {
    expect(monthFirstWeekday("2026-06-01")).toBe(0) // 2026-06-01 is a Monday
  })

  it("reports Sunday as 6", () => {
    expect(monthFirstWeekday("2026-11-01")).toBe(6) // 2026-11-01 is a Sunday
  })

  it("reports a mid-week first in Monday-first order", () => {
    expect(monthFirstWeekday("2026-08-01")).toBe(5) // Saturday
  })

  it("counts from whichever day the week starts on", () => {
    // 2026-08-01 is a Saturday: five cells lead it in a Monday-first week, six in a Sunday-first
    // one, and none at all when the week itself starts on Saturday.
    expect(monthFirstWeekday("2026-08-01", 1)).toBe(5)
    expect(monthFirstWeekday("2026-08-01", 7)).toBe(6)
    expect(monthFirstWeekday("2026-08-01", 6)).toBe(0)
  })
})

describe("daysInMonth", () => {
  it("counts the days of the month a date falls in", () => {
    expect(daysInMonth("2026-08-23")).toBe(31)
    expect(daysInMonth("2026-04-01")).toBe(30)
    expect(daysInMonth("2026-02-10")).toBe(28)
    expect(daysInMonth("2028-02-10")).toBe(29)
  })
})

describe("dayInMonth", () => {
  it("keeps the day number when the target month has it", () => {
    expect(dayInMonth("2026-08-01", 23)).toBe("2026-08-23")
  })

  it("clips to the last day the month has", () => {
    expect(dayInMonth("2026-02-01", 31)).toBe("2026-02-28")
    expect(dayInMonth("2028-02-01", 31)).toBe("2028-02-29")
  })

  it("clips a day number below the first", () => {
    expect(dayInMonth("2026-08-15", 0)).toBe("2026-08-01")
  })
})

describe("shiftMonth before year 1000", () => {
  it("pads the year to four digits so the answer stays a date", () => {
    // A version that wrote the year unpadded answered `999-12-01`, which no parser here accepts.
    expect(shiftMonth("1000-01-15", -1)).toBe("0999-12-01")
    expect(parseIsoDate(shiftMonth("1000-01-15", -1))).toBe(Date.parse("0999-12-01T00:00:00Z"))
  })
})
