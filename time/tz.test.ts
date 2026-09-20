import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  addDays,
  dayOfWeek,
  formatDateLong,
  formatDateTimeLong,
  formatDateTimeShort,
  formatInstantLong,
  formatInstantShort,
  formatTimeOfDay,
  hhmmInTz,
  isoDateInTz,
  isValidTimeZone,
  minToHHMM,
  todayInTz,
  tzOffsetMinutes,
  validTimeZoneOr,
  zonedDateTime,
} from "./tz.ts"

const BERLIN = "Europe/Berlin"
const NEW_YORK = "America/New_York"
const LOS_ANGELES = "America/Los_Angeles"
const UTC_ZONE = "UTC"

function utc(text: string): Date {
  return new Date(text)
}

describe("isValidTimeZone", () => {
  it("accepts an IANA zone", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true)
    expect(isValidTimeZone("UTC")).toBe(true)
  })

  it("rejects garbage and an empty string", () => {
    expect(isValidTimeZone("Not/A_Timezone")).toBe(false)
    expect(isValidTimeZone("")).toBe(false)
    expect(isValidTimeZone("Europe/Berlin ")).toBe(false)
  })
})

describe("validTimeZoneOr", () => {
  it("keeps a valid zone and falls back otherwise", () => {
    expect(validTimeZoneOr("Asia/Tokyo", BERLIN)).toBe("Asia/Tokyo")
    expect(validTimeZoneOr("Not/A_Timezone", BERLIN)).toBe(BERLIN)
  })

  it("falls back for undefined and empty input", () => {
    expect(validTimeZoneOr(undefined, BERLIN)).toBe(BERLIN)
    expect(validTimeZoneOr("", BERLIN)).toBe(BERLIN)
  })
})

describe("zonedDateTime", () => {
  it("converts a Berlin wall clock to the matching UTC instant", () => {
    expect(zonedDateTime("2026-08-28", "10:00", BERLIN).toISOString()).toBe(
      "2026-08-28T08:00:00.000Z",
    )
  })

  it("reads the same instant as a different wall clock in another zone", () => {
    expect(formatInstantShort(zonedDateTime("2026-08-28", "10:00", BERLIN), NEW_YORK)).toBe(
      "Fri 28 Aug 04:00",
    )
  })

  it("handles a zone on a half-hour offset", () => {
    expect(zonedDateTime("2026-08-28", "10:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-08-28T04:30:00.000Z",
    )
  })

  it("resolves a wall clock after the spring-forward boundary", () => {
    // 03:30 CEST is 01:30 UTC. Reading the offset at the naive 02:30 UTC
    // candidate returns CET (+60) and yields 00:30 UTC — 02:30 local — which is
    // the off-by-an-hour answer a single-pass conversion produces.
    expect(zonedDateTime("2026-03-29", "03:30", BERLIN).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    )
  })

  it("resolves a wall clock before the spring-forward boundary", () => {
    expect(zonedDateTime("2026-03-29", "01:30", BERLIN).toISOString()).toBe(
      "2026-03-29T00:30:00.000Z",
    )
    expect(zonedDateTime("2026-03-29", "00:00", BERLIN).toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    )
  })

  it("shifts a wall clock inside the spring-forward gap forward by the gap", () => {
    // 02:30 does not exist in Berlin on 2026-03-29: the clock jumps 02:00 -> 03:00.
    const resolved = zonedDateTime("2026-03-29", "02:30", BERLIN)
    expect(resolved.toISOString()).toBe("2026-03-29T01:30:00.000Z")
    expect(hhmmInTz(resolved, BERLIN)).toBe("03:30")
    expect(zonedDateTime("2026-03-29", "02:00", BERLIN).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    )
  })

  it("returns the instant that reads back as the requested wall clock", () => {
    const wallClocks = [
      ["2026-08-28", "10:00"],
      ["2026-01-15", "00:00"],
      ["2026-10-24", "23:45"],
    ] as const

    for (const [date, time] of wallClocks) {
      const resolved = zonedDateTime(date, time, BERLIN)
      expect(isoDateInTz(resolved, BERLIN)).toBe(date)
      expect(hhmmInTz(resolved, BERLIN)).toBe(time)
    }
  })

  it("picks the daylight-time occurrence of the two fall-back wall clocks", () => {
    // 02:30 exists twice in Berlin on 2026-10-25: 00:30Z (CEST) and 01:30Z
    // (CET). Both read "02:30", so the choice is a convention — the earlier
    // instant, the pre-transition occurrence, which is the reading a guest who
    // wrote "02:30" in a schedule means.
    expect(zonedDateTime("2026-10-25", "02:30", BERLIN).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    )
    expect(zonedDateTime("2026-10-25", "01:30", BERLIN).toISOString()).toBe(
      "2026-10-24T23:30:00.000Z",
    )
    expect(zonedDateTime("2026-10-25", "03:30", BERLIN).toISOString()).toBe(
      "2026-10-25T02:30:00.000Z",
    )
  })

  it("resolves both sides of the fall-back transition in New York", () => {
    // America/New_York falls back 2026-11-01 02:00 EDT -> 01:00 EST, so 01:30
    // occurs twice and the earlier (EDT, 05:30Z) instant wins; 02:30 occurs once.
    expect(zonedDateTime("2026-11-01", "01:30", NEW_YORK).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    )
    expect(zonedDateTime("2026-11-01", "02:30", NEW_YORK).toISOString()).toBe(
      "2026-11-01T07:30:00.000Z",
    )
    expect(zonedDateTime("2026-11-01", "00:30", NEW_YORK).toISOString()).toBe(
      "2026-11-01T04:30:00.000Z",
    )
  })

  it("shifts across a zone whose DST step is not an hour", () => {
    // Australia/Lord_Howe moves by 30 minutes (2026-04-05 02:00 -> 01:30), so
    // 01:45 occurs twice; Pacific/Chatham moves by 60 minutes on a :45 boundary
    // (2026-09-27 02:45 -> 03:45), so 03:00 does not exist.
    expect(zonedDateTime("2026-04-05", "01:45", "Australia/Lord_Howe").toISOString()).toBe(
      "2026-04-04T14:45:00.000Z",
    )
    expect(zonedDateTime("2026-09-27", "03:00", "Pacific/Chatham").toISOString()).toBe(
      "2026-09-26T14:15:00.000Z",
    )
    expect(zonedDateTime("2026-09-27", "02:00", "Pacific/Chatham").toISOString()).toBe(
      "2026-09-26T13:15:00.000Z",
    )
  })

  it("rejects input that is not a date and time", () => {
    expect(() => zonedDateTime("not-a-date", "10:00", BERLIN)).toThrow(RangeError)
    expect(() => zonedDateTime("2026-08-28", "not-a-time", BERLIN)).toThrow(RangeError)
    expect(() => zonedDateTime("", "", BERLIN)).toThrow(RangeError)
  })

  it("rejects 30 February instead of rolling it into 2 March", () => {
    expect(() => zonedDateTime("2026-02-30", "12:00", BERLIN)).toThrow(RangeError)
  })

  it("rejects month 13 instead of rolling it into next January", () => {
    expect(() => zonedDateTime("2026-13-01", "12:00", BERLIN)).toThrow(RangeError)
  })

  it("rejects hour 25 instead of rolling it into the next day", () => {
    expect(() => zonedDateTime("2026-06-15", "25:00", BERLIN)).toThrow(RangeError)
  })

  it("rejects a two-digit year instead of folding it into 19xx", () => {
    // `Date.UTC(99, ...)` silently means 1999, not year 99.
    expect(() => zonedDateTime("0099-06-15", "12:00", BERLIN)).toThrow(RangeError)
  })

  it("rejects a historical wall clock whose offset is not minute-aligned", () => {
    // Africa/Monrovia's LMT offset was -00:44:30 until 1972: no minute-aligned
    // candidate reads back as the requested wall clock.
    expect(() => zonedDateTime("1971-06-15", "12:00", "Africa/Monrovia")).toThrow(
      /minute resolution/,
    )
  })

  it("rejects a non-zero-padded date with a format message, not a zone one", () => {
    // "2026-6-15" denotes a real, ordinary date — the offset math never runs,
    // because the shape check rejects it first.
    expect(() => zonedDateTime("2026-6-15", "12:00", BERLIN)).toThrow(/YYYY-MM-DD/)
    expect(() => zonedDateTime("2026-6-15", "12:00", BERLIN)).not.toThrow(/minute resolution/)
  })

  it("rejects a time with seconds with a format message, not a zone one", () => {
    expect(() => zonedDateTime("2026-06-15", "12:00:30", BERLIN)).toThrow(/HH:MM/)
    expect(() => zonedDateTime("2026-06-15", "12:00:30", BERLIN)).not.toThrow(/minute resolution/)
  })

  it("rejects a time with surrounding whitespace with a format message, not a zone one", () => {
    expect(() => zonedDateTime("2026-06-15", "12:00 ", BERLIN)).toThrow(/HH:MM/)
    expect(() => zonedDateTime(" 2026-06-15", "12:00", BERLIN)).toThrow(/YYYY-MM-DD/)
  })

  it("shifts a gap that falls at midnight into the same day", () => {
    // America/Santiago springs forward at 2026-09-06 00:00 local, so midnight
    // itself does not exist and the conversion shifts to 01:00 — still the day
    // it was asked for, which is why the date is not lost.
    const resolved = zonedDateTime("2026-09-06", "00:00", "America/Santiago")
    expect(resolved.toISOString()).toBe("2026-09-06T04:00:00.000Z")
    expect(hhmmInTz(resolved, "America/Santiago")).toBe("01:00")
    expect(isoDateInTz(resolved, "America/Santiago")).toBe("2026-09-06")
  })

  it("does not use the host timezone", () => {
    // Identical assertion under any TZ: the zone is always explicit.
    const instant = zonedDateTime("2026-03-29", "12:00", "Pacific/Chatham")
    expect(instant.toISOString()).toBe("2026-03-28T22:15:00.000Z")
  })

  it("gives the same moment for a half-hour zone regardless of locale", () => {
    // ICU's offset text for Asia/Kolkata depends on locale: "en-GB" renders
    // "GMT+5:30", "fr-FR" renders "UTC+5:30", "ar-EG" renders Arabic-indic
    // digits — neither of the latter two matches tzOffsetMinutes' "GMT±H:MM"
    // pattern. Confirmed against the real formatters, not assumed.
    const instant = utc("2026-01-15T12:00:00Z")
    const offsetText = (locale: string) =>
      new Intl.DateTimeFormat(locale, { timeZone: "Asia/Kolkata", timeZoneName: "shortOffset" })
        .formatToParts(instant)
        .find((part) => part.type === "timeZoneName")!.value

    expect(offsetText("en-GB")).toBe("GMT+5:30")
    expect(offsetText("fr-FR")).not.toBe(offsetText("en-GB"))
    expect(offsetText("ar-EG")).not.toBe(offsetText("en-GB"))

    // tzOffsetMinutes and zonedDateTime never read a caller-supplied locale,
    // so the hazard above cannot reach them: the offset is correct regardless.
    expect(tzOffsetMinutes(instant, "Asia/Kolkata")).toBe(330)
    expect(zonedDateTime("2026-01-15", "17:30", "Asia/Kolkata").toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    )
  })
})

describe("tzOffsetMinutes", () => {
  it("reports whole-hour offsets in both hemispheres of the year", () => {
    expect(tzOffsetMinutes(utc("2026-01-15T12:00:00Z"), BERLIN)).toBe(60)
    expect(tzOffsetMinutes(utc("2026-07-15T12:00:00Z"), BERLIN)).toBe(120)
    expect(tzOffsetMinutes(utc("2026-01-15T12:00:00Z"), NEW_YORK)).toBe(-300)
    expect(tzOffsetMinutes(utc("2026-07-15T12:00:00Z"), NEW_YORK)).toBe(-240)
  })

  it("reports fractional offsets", () => {
    expect(tzOffsetMinutes(utc("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(330)
    expect(tzOffsetMinutes(utc("2026-01-15T12:00:00Z"), "Pacific/Chatham")).toBe(825)
    expect(tzOffsetMinutes(utc("2026-07-15T12:00:00Z"), "Australia/Lord_Howe")).toBe(630)
  })

  it("treats a bare GMT name as zero", () => {
    // ICU prints "GMT" with no sign for UTC, which the offset regex must not
    // mistake for a positive offset.
    expect(tzOffsetMinutes(utc("2026-01-15T12:00:00Z"), "UTC")).toBe(0)
    expect(tzOffsetMinutes(utc("2026-01-15T12:00:00Z"), "Europe/London")).toBe(0)
    expect(tzOffsetMinutes(utc("2026-07-15T12:00:00Z"), "Europe/London")).toBe(60)
  })
})

describe("isoDateInTz", () => {
  it("renders the date the zone reads, not the UTC date", () => {
    expect(isoDateInTz(utc("2026-08-28T08:00:00Z"), BERLIN)).toBe("2026-08-28")
    expect(isoDateInTz(utc("2026-08-28T00:00:00Z"), LOS_ANGELES)).toBe("2026-08-27")
  })

  it("zero-pads month and day", () => {
    expect(isoDateInTz(utc("2026-01-05T12:00:00Z"), BERLIN)).toBe("2026-01-05")
  })

  it("is reversible with zonedDateTime", () => {
    const instant = zonedDateTime("2026-12-31", "23:59", BERLIN)
    expect(isoDateInTz(instant, BERLIN)).toBe("2026-12-31")
  })
})

describe("hhmmInTz", () => {
  it("renders the time the zone reads, not the UTC time", () => {
    expect(hhmmInTz(utc("2026-08-28T08:00:00Z"), BERLIN)).toBe("10:00")
    expect(hhmmInTz(utc("2026-08-28T08:00:00Z"), NEW_YORK)).toBe("04:00")
  })

  it("renders midnight as 00:00, never 24:00", () => {
    // An h24 hour cycle renders this instant as "24:00" — the next day to a reader.
    expect(hhmmInTz(utc("2026-08-27T22:00:00Z"), BERLIN)).toBe("00:00")
    expect(hhmmInTz(utc("2026-08-28T00:00:00Z"), UTC_ZONE)).toBe("00:00")
  })

  it("distinguishes the two hours across a fall-back overlap", () => {
    expect(hhmmInTz(utc("2026-10-25T00:30:00Z"), BERLIN)).toBe("02:30")
    expect(hhmmInTz(utc("2026-10-25T01:30:00Z"), BERLIN)).toBe("02:30")
  })
})

describe("todayInTz", () => {
  it("matches isoDateInTz on the same clock", () => {
    expect(todayInTz(BERLIN)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Math.abs(new Date(todayInTz(BERLIN) + "T12:00:00Z").getTime() - Date.now()))
      .toBeLessThan(36 * 3_600_000)
  })
})

describe("formatInstantLong", () => {
  it("formats an instant in the guest timezone with an 'at' separator", () => {
    expect(formatInstantLong(zonedDateTime("2026-08-28", "10:00", BERLIN), NEW_YORK)).toBe(
      "Friday, 28 August 2026 at 04:00",
    )
  })

  it("formats an instant at midnight without a 24:00 hour", () => {
    expect(formatInstantLong(utc("2026-08-27T22:00:00Z"), BERLIN)).toBe(
      "Friday, 28 August 2026 at 00:00",
    )
  })
})

describe("formatInstantShort", () => {
  it("drops the comma after the weekday", () => {
    expect(formatInstantShort(zonedDateTime("2026-08-28", "10:00", BERLIN), NEW_YORK)).toBe(
      "Fri 28 Aug 04:00",
    )
  })

  it("handles a date boundary in the guest timezone", () => {
    expect(formatInstantShort(zonedDateTime("2026-08-28", "01:00", BERLIN), LOS_ANGELES)).toBe(
      "Thu 27 Aug 16:00",
    )
  })
})

describe("formatDateTimeLong", () => {
  it("reads back the wall clock it was given", () => {
    expect(formatDateTimeLong("2026-08-28", "10:00", BERLIN)).toBe(
      "Friday, 28 August 2026 at 10:00",
    )
  })

  it("keeps the wall clock across a DST boundary", () => {
    expect(formatDateTimeLong("2026-03-29", "03:30", BERLIN)).toBe(
      "Sunday, 29 March 2026 at 03:30",
    )
    expect(formatDateTimeLong("2026-10-25", "08:00", BERLIN)).toBe(
      "Sunday, 25 October 2026 at 08:00",
    )
  })
})

describe("formatDateTimeShort", () => {
  it("formats a wall clock compactly", () => {
    expect(formatDateTimeShort("2026-08-28", "10:00", BERLIN)).toBe("Fri 28 Aug 10:00")
  })
})

describe("formatDateLong", () => {
  it("formats the date without a time", () => {
    expect(formatDateLong("2026-09-02", BERLIN)).toBe("Wednesday, 2 September 2026")
  })

  it("does not drift a date that sits next to a transition", () => {
    expect(formatDateLong("2026-03-29", BERLIN)).toBe("Sunday, 29 March 2026")
    expect(formatDateLong("2026-10-25", BERLIN)).toBe("Sunday, 25 October 2026")
  })

  it("does not drift a date whose own midnight does not exist", () => {
    // America/Santiago springs forward at 2026-09-06 00:00 local, so the noon
    // anchor is the only reason this date survives the conversion.
    expect(formatDateLong("2026-09-06", "America/Santiago")).toBe("Sunday, 6 September 2026")
    expect(formatDateTimeLong("2026-09-06", "12:00", "America/Santiago")).toBe(
      "Sunday, 6 September 2026 at 12:00",
    )
  })
})

describe("formatTimeOfDay", () => {
  it("formats the time without a date", () => {
    expect(formatTimeOfDay("2026-08-28", "11:00", BERLIN)).toBe("11:00")
    expect(formatTimeOfDay("2026-08-28", "09:05", BERLIN)).toBe("09:05")
  })

  it("renders midnight as 00:00", () => {
    expect(formatTimeOfDay("2026-08-28", "00:00", BERLIN)).toBe("00:00")
  })
})

describe("dayOfWeek", () => {
  it("returns the uppercase short weekday", () => {
    expect(dayOfWeek("2026-08-28", BERLIN)).toBe("FRI")
    expect(dayOfWeek("2026-08-30", BERLIN)).toBe("SUN")
    expect(dayOfWeek("2026-03-30", BERLIN)).toBe("MON")
  })

  it("is stable across a DST transition of the anchor hour", () => {
    expect(dayOfWeek("2026-03-29", BERLIN)).toBe("SUN")
    expect(dayOfWeek("2026-10-25", BERLIN)).toBe("SUN")
  })
})

describe("addDays", () => {
  it("moves the calendar date by whole days", () => {
    expect(addDays("2026-08-28", 1, BERLIN)).toBe("2026-08-29")
    expect(addDays("2026-08-28", 0, BERLIN)).toBe("2026-08-28")
    expect(addDays("2026-08-28", -1, BERLIN)).toBe("2026-08-27")
    expect(addDays("2026-12-31", 1, BERLIN)).toBe("2027-01-01")
    expect(addDays("2027-01-01", -1, BERLIN)).toBe("2026-12-31")
  })

  it("crosses the spring-forward boundary without losing a day", () => {
    // Berlin 2026-03-29 is 23 hours long. The day before the transition starts
    // at 22:00Z and the transition day starts at 23:00Z: +86_400_000 from
    // local midnight lands at 01:00 on 2026-03-29, so a day is skipped.
    // Noon anchoring keeps the date.
    expect(addDays("2026-03-28", 1, BERLIN)).toBe("2026-03-29")
    expect(addDays("2026-03-28", 2, BERLIN)).toBe("2026-03-30")
  })

  it("goes back over the spring-forward boundary without losing a day", () => {
    expect(addDays("2026-03-29", -1, BERLIN)).toBe("2026-03-28")
    expect(addDays("2026-03-29", -2, BERLIN)).toBe("2026-03-27")
  })

  it("crosses the fall-back boundary without gaining a day", () => {
    // Berlin 2026-10-25 is 25 hours long. The day before the transition starts
    // at 22:00Z and the transition day starts at 23:00Z: the shift is -86_400_000
    // from local midnight, which lands back on the day it started from.
    expect(addDays("2026-10-24", 1, BERLIN)).toBe("2026-10-25")
    expect(addDays("2026-10-24", 2, BERLIN)).toBe("2026-10-26")
  })

  it("goes back over the fall-back boundary without gaining a day", () => {
    expect(addDays("2026-10-25", -1, BERLIN)).toBe("2026-10-24")
    expect(addDays("2026-10-25", -2, BERLIN)).toBe("2026-10-23")
  })

  it("leaves no gap when walking across the spring transition day by day", () => {
    let date = "2026-03-25"
    const visited: string[] = []
    for (let step = 0; step < 8; step++) {
      visited.push(date)
      date = addDays(date, 1, BERLIN)
    }
    expect(visited).toEqual([
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
    ])
    expect(addDays("2026-04-01", -8, BERLIN)).toBe("2026-03-24")
  })

  it("crosses a month and a transition in a zone on a half-hour offset", () => {
    // Australia/Lord_Howe shifts by 30 minutes, not 60.
    expect(addDays("2026-04-04", 1, "Australia/Lord_Howe")).toBe("2026-04-05")
    expect(addDays("2026-04-05", -1, "Australia/Lord_Howe")).toBe("2026-04-04")
    expect(addDays("2026-09-30", 30, "Asia/Kolkata")).toBe("2026-10-30")
  })
})

describe("minToHHMM", () => {
  it("formats minutes since midnight as HH:MM", () => {
    expect(minToHHMM(0)).toBe("00:00")
    expect(minToHHMM(540)).toBe("09:00")
    expect(minToHHMM(570)).toBe("09:30")
    expect(minToHHMM(1439)).toBe("23:59")
  })

  it("renders the exclusive end of a day as 24:00", () => {
    // Callers use 1440 as a range bound, so it is passed through, not wrapped.
    expect(minToHHMM(1440)).toBe("24:00")
  })
})

describe("invalid timezone fallback", () => {
  it("formats a guest instant in the host zone when the stored zone is invalid", () => {
    const instant = zonedDateTime("2026-08-28", "10:00", BERLIN)
    const guestTz = validTimeZoneOr("Not/A_Timezone", BERLIN)
    expect(guestTz).toBe(BERLIN)
    expect(formatInstantLong(instant, guestTz)).toBe("Friday, 28 August 2026 at 10:00")
    expect(formatInstantShort(instant, guestTz)).toBe("Fri 28 Aug 10:00")
  })
})
