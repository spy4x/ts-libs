import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { daysInMonth } from "./date.ts"
import {
  currentPeriod,
  type Period,
  periodLabel,
  periodOf,
  periodSoFar,
  PeriodUnit,
  samePartOf,
  shiftPeriod,
} from "./period.ts"
import { addDays } from "./tz.ts"

const month = (from: string, to: string): Period => ({ unit: PeriodUnit.Month, from, to })
const week = (from: string, to: string): Period => ({ unit: PeriodUnit.Week, from, to })

describe("periodOf", () => {
  it("returns the whole calendar month a date falls in", () => {
    expect(periodOf(PeriodUnit.Month, "2026-02-14")).toEqual(month("2026-02-01", "2026-02-28"))
    expect(periodOf(PeriodUnit.Month, "2028-02-29")).toEqual(month("2028-02-01", "2028-02-29"))
  })

  it("starts a week on Monday by default", () => {
    expect(periodOf(PeriodUnit.Week, "2026-11-01")).toEqual(week("2026-10-26", "2026-11-01"))
  })

  it("starts a week on the first weekday it is given", () => {
    expect(periodOf(PeriodUnit.Week, "2026-11-01", { firstWeekday: 7 }))
      .toEqual(week("2026-11-01", "2026-11-07"))
    expect(periodOf(PeriodUnit.Week, "2026-11-01", { firstWeekday: 6 }))
      .toEqual(week("2026-10-31", "2026-11-06"))
  })

  it("rejects a first weekday outside 1 to 7", () => {
    for (const firstWeekday of [0, 8, 1.5, NaN]) {
      expect(() => periodOf(PeriodUnit.Week, "2026-11-01", { firstWeekday })).toThrow(RangeError)
    }
  })

  it("rejects an unknown unit", () => {
    expect(() => periodOf(3 as PeriodUnit, "2026-11-01")).toThrow(RangeError)
  })
})

describe("currentPeriod", () => {
  const now = new Date("2026-10-31T17:30:00Z")

  it("reads the month from the calendar of the zone it is given", () => {
    expect(currentPeriod(PeriodUnit.Month, { now, timeZone: "Asia/Ho_Chi_Minh" }))
      .toEqual(month("2026-11-01", "2026-11-30"))
    expect(currentPeriod(PeriodUnit.Month, { now, timeZone: "Europe/Berlin" }))
      .toEqual(month("2026-10-01", "2026-10-31"))
  })

  it("passes the first weekday through to the week", () => {
    expect(currentPeriod(PeriodUnit.Week, { now, timeZone: "Asia/Ho_Chi_Minh", firstWeekday: 7 }))
      .toEqual(week("2026-11-01", "2026-11-07"))
    expect(currentPeriod(PeriodUnit.Week, { now, timeZone: "Europe/Berlin" }))
      .toEqual(week("2026-10-26", "2026-11-01"))
  })
})

describe("shiftPeriod", () => {
  it("steps through every month of 2026 and across both year ends without a gap or overlap", () => {
    let period = month("2025-12-01", "2025-12-31")
    let days = 0
    for (let i = 1; i <= 13; i++) {
      const next = shiftPeriod(period, 1)
      expect(next.from).toBe(addDays(period.to, 1))
      expect(next.to).toBe(addDays(next.from, daysInMonth(next.from) - 1))
      expect(shiftPeriod(next, -1)).toEqual(period)
      if (next.from.startsWith("2026")) days += daysInMonth(next.from)
      period = next
    }
    expect(period).toEqual(month("2027-01-01", "2027-01-31"))
    expect(days).toBe(365)
    expect(shiftPeriod(month("2025-12-01", "2025-12-31"), 13)).toEqual(period)
  })

  it("steps weeks across both 2026 daylight-saving changes and the year end, seven days each", () => {
    let period = periodOf(PeriodUnit.Week, "2025-12-29")
    const first = period
    for (let i = 1; i <= 53; i++) {
      const next = shiftPeriod(period, 1)
      expect(next.from).toBe(addDays(period.to, 1))
      expect(next.to).toBe(addDays(next.from, 6))
      period = next
    }
    expect(period).toEqual(week("2027-01-04", "2027-01-10"))
    expect(shiftPeriod(period, -53)).toEqual(first)
  })

  it("keeps the first weekday a week was made with", () => {
    const sundayWeek = periodOf(PeriodUnit.Week, "2026-11-01", { firstWeekday: 7 })
    expect(shiftPeriod(sundayWeek, 1)).toEqual(week("2026-11-08", "2026-11-14"))
  })

  it("rejects a step that is not a whole number", () => {
    expect(() => shiftPeriod(month("2026-11-01", "2026-11-30"), 0.5)).toThrow(RangeError)
  })
})

describe("periodSoFar", () => {
  const november = month("2026-11-01", "2026-11-30")

  it("cuts the period at today in the zone it is given", () => {
    const now = new Date("2026-11-02T17:30:00Z")
    expect(periodSoFar(november, { now, timeZone: "Asia/Ho_Chi_Minh" }))
      .toEqual(month("2026-11-01", "2026-11-03"))
    expect(periodSoFar(november, { now, timeZone: "Europe/Berlin" }))
      .toEqual(month("2026-11-01", "2026-11-02"))
  })

  it("returns an ended period whole", () => {
    const now = new Date("2027-01-15T12:00:00Z")
    expect(periodSoFar(november, { now, timeZone: "UTC" })).toEqual(november)
  })

  it("returns null for a period that has not started", () => {
    const now = new Date("2026-10-31T12:00:00Z")
    expect(periodSoFar(november, { now, timeZone: "UTC" })).toBeNull()
  })
})

describe("samePartOf", () => {
  it("takes the same number of days from the start of the other period", () => {
    expect(samePartOf(month("2026-10-01", "2026-10-31"), month("2026-11-01", "2026-11-03")))
      .toEqual(month("2026-10-01", "2026-10-03"))
  })

  it("cuts 31 March to the last day of February in a common and in a leap year", () => {
    expect(samePartOf(month("2026-02-01", "2026-02-28"), month("2026-03-01", "2026-03-31")))
      .toEqual(month("2026-02-01", "2026-02-28"))
    expect(samePartOf(month("2028-02-01", "2028-02-29"), month("2028-03-01", "2028-03-31")))
      .toEqual(month("2028-02-01", "2028-02-29"))
    expect(samePartOf(month("2028-02-01", "2028-02-29"), month("2028-03-01", "2028-03-29")))
      .toEqual(month("2028-02-01", "2028-02-29"))
    expect(samePartOf(month("2028-02-01", "2028-02-29"), month("2028-03-01", "2028-03-28")))
      .toEqual(month("2028-02-01", "2028-02-28"))
  })
})

describe("periodLabel", () => {
  it("names a month by its month and year", () => {
    expect(periodLabel(month("2026-11-01", "2026-11-30"))).toBe("November 2026")
    expect(periodLabel(month("2026-11-01", "2026-11-30"), "de-DE")).toBe("November 2026")
  })

  it("names a week as a date range in the region format", () => {
    expect(periodLabel(week("2026-11-02", "2026-11-08"))).toBe("2–8 Nov 2026")
    expect(periodLabel(week("2026-10-26", "2026-11-01"))).toBe("26 Oct – 1 Nov 2026")
    expect(periodLabel(week("2026-11-02", "2026-11-08"), "en-US")).toBe("Nov 2 – 8, 2026")
  })
})
