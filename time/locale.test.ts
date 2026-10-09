import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  dayLabel,
  localeFirstWeekday,
  monthLabel,
  relativeDayLabel,
  shortDayLabel,
  weekdayLabels,
} from "./locale.ts"

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

describe("shortDayLabel", () => {
  it("writes weekday, day and short month in the locale's language", () => {
    expect(shortDayLabel("2026-10-15")).toBe("Thu 15 Oct")
    expect(shortDayLabel("2026-10-15", "de-DE")).toBe("Do., 15. Okt.")
  })

  it("names the weekday correctly at a month and year boundary", () => {
    expect(shortDayLabel("2026-12-31")).toBe("Thu 31 Dec")
    expect(shortDayLabel("2027-01-01")).toBe("Fri 1 Jan")
  })

  it("throws on a value that is not a date", () => {
    expect(() => shortDayLabel("2026-02-31")).toThrow()
    expect(() => shortDayLabel("soon")).toThrow()
  })
})

describe("relativeDayLabel", () => {
  it("says Yesterday, Today and Tomorrow for the neighbouring days", () => {
    expect(relativeDayLabel("2026-10-14", "2026-10-15")).toBe("Yesterday")
    expect(relativeDayLabel("2026-10-15", "2026-10-15")).toBe("Today")
    expect(relativeDayLabel("2026-10-16", "2026-10-15")).toBe("Tomorrow")
  })

  it("falls back to the short label two days away in either direction", () => {
    expect(relativeDayLabel("2026-10-13", "2026-10-15")).toBe("Tue 13 Oct")
    expect(relativeDayLabel("2026-10-17", "2026-10-15")).toBe("Sat 17 Oct")
  })

  it("speaks the locale's language and capitalises its words", () => {
    expect(relativeDayLabel("2026-10-14", "2026-10-15", "de-DE")).toBe("Gestern")
    expect(relativeDayLabel("2026-10-15", "2026-10-15", "de-DE")).toBe("Heute")
    expect(relativeDayLabel("2026-10-16", "2026-10-15", "de-DE")).toBe("Morgen")
    expect(relativeDayLabel("2026-10-14", "2026-10-15", "ru-RU")).toBe("Вчера")
    expect(relativeDayLabel("2026-10-15", "2026-10-15", "ru-RU")).toBe("Сегодня")
    expect(relativeDayLabel("2026-10-16", "2026-10-15", "ru-RU")).toBe("Завтра")
    expect(relativeDayLabel("2026-10-18", "2026-10-15", "de-DE")).toBe("So., 18. Okt.")
  })

  it("counts neighbours across a month and a year boundary", () => {
    expect(relativeDayLabel("2026-11-01", "2026-10-31")).toBe("Tomorrow")
    expect(relativeDayLabel("2026-12-31", "2027-01-01")).toBe("Yesterday")
    expect(relativeDayLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow")
  })

  it("throws on a value that is not a date", () => {
    expect(() => relativeDayLabel("soon", "2026-10-15")).toThrow()
    expect(() => relativeDayLabel("2026-10-15", "2026-13-01")).toThrow()
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
