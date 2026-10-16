import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { createFormatters, deviceFormat, regionHourCycle } from "./format.ts"

/** Saturday 17 October 2026, 13:45 UTC: 15:45 in Berlin, 22:45 in Tokyo. */
const AT = Date.parse("2026-10-17T13:45:00Z")
const BERLIN_DEVICE = { locale: "en-GB", timeZone: "Europe/Berlin" }
const fixed = { device: BERLIN_DEVICE, now: () => AT }

describe("createFormatters", () => {
  it("writes dates and numbers in the person's region format", () => {
    const german = createFormatters({ locale: "de-DE" }, fixed)
    const american = createFormatters({ locale: "en-US" }, fixed)
    expect(german.date(AT)).toBe("17.10.2026")
    expect(american.date(AT)).toBe("Oct 17, 2026")
    expect(german.number(1234.5)).toBe("1.234,5")
    expect(american.number(1234.5)).toBe("1,234.5")
  })

  it("shows the time in the person's chosen zone, not the device's", () => {
    const format = createFormatters({ locale: "en-GB", timeZone: "Asia/Tokyo" }, fixed)
    expect(format.timeZone).toBe("Asia/Tokyo")
    expect(format.time(AT)).toBe("22:45")
  })

  it("follows the device when the locale and zone are automatic", () => {
    const format = createFormatters({ locale: null, timeZone: null }, fixed)
    expect(format.locale).toBe("en-GB")
    expect(format.timeZone).toBe("Europe/Berlin")
    expect(format.dateTime(AT)).toBe("17 Oct 2026, 15:45")
  })

  it("uses the chosen clock over the region format's", () => {
    expect(createFormatters({ locale: "en-US" }, fixed).time(AT)).toBe("3:45 PM")
    expect(createFormatters({ locale: "en-US", hourCycle: "h23" }, fixed).time(AT)).toBe("15:45")
    expect(createFormatters({ locale: "en-GB", hourCycle: "h12" }, fixed).time(AT)).toMatch(
      /^0?3:45\spm$/i,
    )
  })

  it("falls back to the device for an unknown locale tag or zone name", () => {
    const format = createFormatters({ locale: "not a tag", timeZone: "Not/A_Zone" }, fixed)
    expect(format.locale).toBe("en-GB")
    expect(format.timeZone).toBe("Europe/Berlin")
    expect(format.time(AT)).toBe("15:45")
  })

  it("ignores a clock value it does not know", () => {
    const format = createFormatters({ locale: "en-US", hourCycle: "h99" as never }, fixed)
    expect(format.hourCycle).toBeUndefined()
    expect(format.time(AT)).toBe("3:45 PM")
  })

  it("writes a missing or unreadable date as a dash", () => {
    const format = createFormatters({}, fixed)
    for (const value of [null, undefined, "", "not a date"]) {
      expect(format.date(value)).toBe("-")
      expect(format.time(value)).toBe("-")
      expect(format.dateTime(value)).toBe("-")
      expect(format.relative(value)).toBe("-")
      expect(format.dayMonth(value)).toBe("-")
      expect(format.exact(value)).toBe("-")
    }
  })

  it("accepts a Date, epoch milliseconds and an ISO string alike", () => {
    const format = createFormatters({}, fixed)
    const expected = format.dateTime(AT)
    expect(format.dateTime(new Date(AT))).toBe(expected)
    expect(format.dateTime("2026-10-17T13:45:00Z")).toBe(expected)
  })

  it("writes a date at the requested length", () => {
    const format = createFormatters({ locale: "en-GB" }, fixed)
    expect(format.date(AT, "short")).toBe("17/10/2026")
    expect(format.date(AT, "full")).toBe("Saturday, 17 October 2026")
  })
})

describe("dayMonth", () => {
  it("writes the day without its year in the region format's order", () => {
    expect(createFormatters({ locale: "en-GB" }, fixed).dayMonth(AT)).toBe("17 Oct")
    expect(createFormatters({ locale: "en-US" }, fixed).dayMonth(AT)).toBe("Oct 17")
  })

  it("counts the day in the person's zone", () => {
    // 13:45 UTC on the 17th is 00:45 on the 18th in Auckland (NZDT, UTC+13).
    const format = createFormatters({ locale: "en-GB", timeZone: "Pacific/Auckland" }, fixed)
    expect(format.dayMonth(AT)).toBe("18 Oct")
  })
})

describe("exact", () => {
  const EXACT = Date.parse("2026-10-17T13:45:09Z")

  it("writes the instant to the second with the zone named", () => {
    const format = createFormatters({ locale: "en-GB" }, fixed)
    expect(format.utc().exact(EXACT)).toBe("17 Oct 2026, 13:45:09 UTC")
    expect(format.exact(EXACT)).toBe("17 Oct 2026, 15:45:09 CEST")
  })

  it("writes the date in the region format and the time on the chosen clock", () => {
    const german = createFormatters({ locale: "de-DE" }, fixed)
    const american = createFormatters({ locale: "en-US", hourCycle: "h23" }, fixed)
    expect(german.utc().exact(EXACT)).toBe("17.10.2026, 13:45:09 UTC")
    expect(american.utc().exact(EXACT)).toBe("Oct 17, 2026, 13:45:09 UTC")
  })
})

describe("utc", () => {
  it("keeps the region format and clock but reads the instant in UTC", () => {
    const format = createFormatters(
      { locale: "de-DE", timeZone: "Asia/Tokyo", hourCycle: "h23" },
      fixed,
    )
    const utc = format.utc()
    expect(utc.timeZone).toBe("UTC")
    expect(utc.locale).toBe("de-DE")
    expect(utc.hourCycle).toBe("h23")
    expect(utc.time(AT)).toBe("13:45")
    expect(format.time(AT)).toBe("22:45")
  })

  it("keeps a day counted in UTC on its own date for a reader west of UTC", () => {
    const bucket = Date.parse("2026-10-17T00:00:00Z")
    const reader = createFormatters({ locale: "en-GB", timeZone: "America/New_York" }, fixed)
    expect(reader.dayMonth(bucket)).toBe("16 Oct")
    expect(reader.utc().dayMonth(bucket)).toBe("17 Oct")
  })

  it("keeps the injected current time for relative labels", () => {
    const utc = createFormatters({ locale: "en-GB" }, fixed).utc()
    expect(utc.relative(AT - 5 * 60_000)).toBe("5 minutes ago")
  })
})

describe("regionHourCycle", () => {
  it("reads the clock a region format uses on its own", () => {
    expect(regionHourCycle("en-US")).toBe("h12")
    expect(regionHourCycle("de-DE")).toBe("h23")
    expect(regionHourCycle("en-GB")).toBe("h23")
  })

  it("reads a malformed tag as en-GB instead of throwing", () => {
    expect(regionHourCycle("not a tag!!")).toBe("h23")
  })
})

describe("relative", () => {
  const format = createFormatters({ locale: "en-GB" }, fixed)
  const ago = (ms: number) => format.relative(AT - ms)

  it("names the largest unit the distance fills", () => {
    expect(ago(0)).toBe("now")
    expect(ago(30_000)).toBe("30 seconds ago")
    expect(ago(5 * 60_000)).toBe("5 minutes ago")
    expect(ago(3 * 3_600_000)).toBe("3 hours ago")
    expect(ago(26 * 3_600_000)).toBe("yesterday")
    expect(ago(14 * 86_400_000)).toBe("2 weeks ago")
    expect(ago(90 * 86_400_000)).toBe("3 months ago")
    expect(ago(800 * 86_400_000)).toBe("2 years ago")
  })

  it("speaks of the future too", () => {
    expect(format.relative(AT + 2 * 3_600_000)).toBe("in 2 hours")
  })

  it("speaks the person's region format", () => {
    const german = createFormatters({ locale: "de-DE" }, fixed)
    expect(german.relative(AT - 5 * 60_000)).toBe("vor 5 Minuten")
  })
})

describe("deviceFormat", () => {
  it("reports a locale and a zone this runtime accepts", () => {
    const { locale, timeZone } = deviceFormat()
    expect(Intl.DateTimeFormat.supportedLocalesOf([locale])).toHaveLength(1)
    expect(() => new Intl.DateTimeFormat("en", { timeZone })).not.toThrow()
  })
})
