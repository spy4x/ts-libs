import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { dayLabel, localeFirstWeekday, monthLabel, weekdayLabels } from "./locale.ts"

describe("localeFirstWeekday", () => {
  it("reads the first day of the week out of the locale", () => {
    expect(localeFirstWeekday("en-GB")).toBe(1) // Monday
    expect(localeFirstWeekday("en-US")).toBe(7) // Sunday
    expect(localeFirstWeekday("ar-EG")).toBe(6) // Saturday
  })

  it("falls back to Monday for a tag it cannot read", () => {
    expect(localeFirstWeekday("not a locale")).toBe(1)
  })
})

describe("dayLabel", () => {
  it("writes the date the way the locale writes it", () => {
    expect(dayLabel("2026-08-23")).toBe("23 August 2026")
    expect(dayLabel("2026-08-23", "fr-FR")).toBe("23 août 2026")
  })
})

describe("monthLabel", () => {
  it("formats month and year", () => {
    expect(monthLabel("2026-08-23")).toBe("August 2026")
  })

  it("honours a locale", () => {
    expect(monthLabel("2026-08-23", "fr-FR")).toBe("août 2026")
  })
})

describe("weekdayLabels", () => {
  it("returns seven labels starting on the locale's first day", () => {
    const labels = weekdayLabels()

    expect(labels).toHaveLength(7)
    expect(labels[0]).toEqual({ short: "Mon", long: "Monday" })
    expect(labels[6]).toEqual({ short: "Sun", long: "Sunday" })
  })

  it("follows the locale's language", () => {
    expect(weekdayLabels("de-DE")[0].long).toBe("Montag")
  })

  it("reorders the week for a locale that does not start it on Monday", () => {
    expect(weekdayLabels("en-US")[0]).toEqual({ short: "Sun", long: "Sunday" })
    expect(weekdayLabels("en-US")[6]).toEqual({ short: "Sat", long: "Saturday" })
  })

  it("abbreviates the way the locale does, leaving seven distinguishable columns", () => {
    // Every Arabic weekday opens with the same two characters, so a two-character cut leaves one
    // label repeated seven times; Vietnamese leaves six of seven reading `Th`.
    for (const locale of ["ar-EG", "he-IL", "vi-VN", "en-GB"]) {
      const shorts = weekdayLabels(locale).map((weekday) => weekday.short)
      expect(new Set(shorts).size).toBe(7)
    }
  })
})
