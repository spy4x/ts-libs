import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"
import { validate } from "@spy4x/validation"

import { BaseModelSchema } from "./base-model.ts"
import { DateNullableSchema, dateSchema } from "./date.ts"

describe("dateSchema", () => {
  it("accepts a Date instance unchanged", () => {
    const now = new Date("2024-01-01T00:00:00.000Z")
    const result = dateSchema(now)
    expect(result).toEqual(now)
    expect(result instanceof type.errors).toBe(false)
  })

  it("parses an ISO 8601 date string into a Date", () => {
    const result = dateSchema("2024-01-01T00:00:00.000Z")
    expect(result instanceof type.errors).toBe(false)
    expect(result).toBeInstanceOf(Date)
    expect((result as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z")
  })

  it("parses a date-only ISO string", () => {
    const result = dateSchema("2024-01-01")
    expect(result instanceof type.errors).toBe(false)
    expect((result as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z")
  })

  it("parses an ISO date-time string with a numeric offset", () => {
    const result = dateSchema("2024-01-01T10:00:00+02:00")
    expect(result instanceof type.errors).toBe(false)
    expect((result as Date).toISOString()).toBe("2024-01-01T08:00:00.000Z")
  })

  it("rejects a string that is not an ISO 8601 date", () => {
    const result = dateSchema("not a date")
    expect(result instanceof type.errors).toBe(true)
  })

  it("rejects a plain number", () => {
    const result = dateSchema(1_700_000_000_000)
    expect(result instanceof type.errors).toBe(true)
  })

  /**
   * #131: `new Date(...)` silently rolls an out-of-range day into the next month instead of
   * refusing it (`new Date("2026-02-30")` is 2 March 2026), so the schema must catch this itself
   * rather than delegate to `Date` parsing.
   */
  describe("calendar dates that do not exist (#131)", () => {
    it("rejects 30 February", () => {
      expect(dateSchema("2026-02-30") instanceof type.errors).toBe(true)
    })

    it("rejects 31 April", () => {
      expect(dateSchema("2024-04-31") instanceof type.errors).toBe(true)
    })

    it("rejects 29 February in a non-leap year", () => {
      expect(dateSchema("2023-02-29") instanceof type.errors).toBe(true)
    })

    it("still accepts 29 February in a leap year", () => {
      const result = dateSchema("2024-02-29")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-02-29T00:00:00.000Z")
    })

    it("accepts year 0000 and year 0099 (setUTCFullYear, not Date.UTC's two-digit-year mapping)", () => {
      const y0000 = dateSchema("0000-01-01")
      expect(y0000 instanceof type.errors).toBe(false)
      expect((y0000 as Date).toISOString()).toBe("0000-01-01T00:00:00.000Z")

      const y0099 = dateSchema("0099-12-31")
      expect(y0099 instanceof type.errors).toBe(false)
      expect((y0099 as Date).toISOString()).toBe("0099-12-31T00:00:00.000Z")
    })

    it("rejects a week date and the compact no-dashes form instead of returning an unusable Invalid Date", () => {
      expect(dateSchema("2024-W01-1") instanceof type.errors).toBe(true)
      expect(dateSchema("20240230") instanceof type.errors).toBe(true)
    })

    it("checks the string's own YYYY-MM-DD digits, not the UTC date after the time and offset are applied", () => {
      // 23:30 on 29 February at -05:00 is 04:30 UTC on 1 March — a check built from the fully
      // parsed date (`new Date(iso)`) would read back month 3 / day 1 in UTC and wrongly reject a
      // string whose own date part, 2024-02-29, is a real (leap-year) calendar date.
      const result = dateSchema("2024-02-29T23:30:00-05:00")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-03-01T04:30:00.000Z")
    })

    it("rejects a date-time new Date cannot read instead of returning an unusable Invalid Date", () => {
      for (
        const input of [
          "2024-01-01T",
          "2024-01-01T10",
          "2024-01-01T1030",
          "2024-01-01T10:30+05",
          "2024-01-01T10:30:45,123",
        ]
      ) {
        expect(dateSchema(input) instanceof type.errors).toBe(true)
      }
    })

    it("rejects a date written without dashes, which V8 would read as a far-off year", () => {
      for (const input of ["00000230", "+00010229", "0001366", "00010101"]) {
        expect(dateSchema(input) instanceof type.errors).toBe(true)
      }
    })

    it("rejects a calendar date that does not exist when the year carries a sign", () => {
      expect(dateSchema("+2023-02-29") instanceof type.errors).toBe(true)
      expect(dateSchema("+2026-04-31") instanceof type.errors).toBe(true)
      expect(dateSchema("-1900-02-29") instanceof type.errors).toBe(true)
      // Refused since #136: a signed year is refused even when the date exists.
      expect(dateSchema("+2024-02-29") instanceof type.errors).toBe(true)
    })
  })

  /**
   * #136: V8's `new Date` reads an ordinal date's day of the year as a month, and drops the sign
   * of a signed four-digit year, with no error. Both shapes are refused rather than mis-dated.
   */
  describe("shapes new Date reads as the wrong date (#136)", () => {
    it("rejects an ordinal date that new Date would read as the first of a month", () => {
      // "2024-005" is 5 January; new Date reads it as 1 May.
      for (const input of ["2024-002", "2024-005", "2024-012"]) {
        expect(dateSchema(input) instanceof type.errors).toBe(true)
      }
    })

    it("rejects an ordinal date even where new Date happens to read it right", () => {
      expect(dateSchema("2024-001") instanceof type.errors).toBe(true)
    })

    it("rejects an ordinal date followed by a time", () => {
      expect(dateSchema("2024-005T10:00:00Z") instanceof type.errors).toBe(true)
    })

    it("rejects a year with a minus sign, which new Date reads as a positive year", () => {
      // "-2024-01-01" becomes 2024; "-0001-01-01" becomes 2001.
      for (const input of ["-2024-01-01", "-0001-01-01", "-2024-05"]) {
        expect(dateSchema(input) instanceof type.errors).toBe(true)
      }
    })

    it("rejects a year with a plus sign, which new Date can read in the wrong century", () => {
      // "+0099-12-31" becomes 1999.
      for (const input of ["+0099-12-31", "+2024-01-01", "+2024"]) {
        expect(dateSchema(input) instanceof type.errors).toBe(true)
      }
    })

    it("still accepts a year, a year and month, and an unsigned calendar date", () => {
      expect((dateSchema("2024") as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z")
      expect((dateSchema("2024-05") as Date).toISOString()).toBe("2024-05-01T00:00:00.000Z")
      expect((dateSchema("2024-01-05") as Date).toISOString()).toBe("2024-01-05T00:00:00.000Z")
    })
  })

  /**
   * #135: a date-time string with a time but no offset and no `Z` is read in the host's own time
   * zone by `new Date`, so the same wire string would parse to a different instant depending on
   * where the process runs. These cases pin the fix without depending on the host's `TZ` — they
   * assert only that the string is refused, never a particular instant — and are also proven by
   * hand in the PR body: the same script run once under `TZ=UTC` and once under `TZ=Asia/Bangkok`.
   */
  describe("offset-less date-time strings depend on the host time zone (#135)", () => {
    it("rejects a date-time with no offset and no Z", () => {
      expect(dateSchema("2024-02-29T10:00:00") instanceof type.errors).toBe(true)
    })

    it("rejects a date-time with no offset and no Z, with a fractional second", () => {
      expect(dateSchema("2024-02-29T10:00:00.500") instanceof type.errors).toBe(true)
    })

    it("rejects a date-time with no offset and no Z, with minutes but no seconds", () => {
      expect(dateSchema("2024-02-29T10:00") instanceof type.errors).toBe(true)
    })

    it("rejects a date-time with no offset and no Z, with a fraction longer than 3 digits", () => {
      expect(dateSchema("2024-02-29T10:00:00.123456789") instanceof type.errors).toBe(true)
    })

    it("reports its own message, not the calendar-date message, for a missing time zone", () => {
      const result = dateSchema("2024-02-29T10:00:00")
      expect(result instanceof type.errors).toBe(true)
      expect((result as type.errors).summary).toContain(
        "must name a time zone: end the time with `Z` or an offset such as `+02:00`",
      )
    })

    it("reports the same message through BaseModelSchema, with the field name prefixed", () => {
      const result = BaseModelSchema({
        id: 1,
        createdAt: "2024-02-29T10:00:00",
        updatedAt: new Date(),
      })
      expect(result instanceof type.errors).toBe(true)
      expect((result as type.errors).summary).toContain(
        "createdAt must name a time zone: end the time with `Z` or an offset such as `+02:00`",
      )
    })

    /**
     * `ctx.reject({ problem })` alone is not enough: arktype's `ArkError.expected` getter falls
     * back to a per-node default config when `input.expected` is unset, and a bare `.narrow`
     * predicate has none — reading it throws `Cannot read properties of undefined (reading
     * 'name')`. That getter runs inside `toJSON`, so `JSON.stringify` on the rejection threw, and
     * so did anything that serializes it downstream, such as `validate` from `@spy4x/validation`.
     * Passing `expected` alongside `problem` fixes both without changing the rendered message
     * (pinned above).
     */
    it("keeps the rejection JSON-serializable instead of throwing from a missing expected", () => {
      const result = dateSchema("2024-02-29T10:00:00")
      expect(result instanceof type.errors).toBe(true)
      const json = JSON.stringify(result)
      expect(json).toContain("must name a time zone")
    })

    it("keeps validate() from @spy4x/validation working, with the time-zone message reachable", () => {
      const schema = type({ d: dateSchema.or("''") })
      const result = validate(schema, { d: "2024-02-29T10:00" })
      expect(result.error).not.toBeNull()
      const json = JSON.stringify(result.error?.details)
      expect(json).toContain("must name a time zone")
    })

    it("still accepts the same date-time with a lower-case z", () => {
      const result = dateSchema("2024-02-29T10:00:00z")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-02-29T10:00:00.000Z")
    })

    it("still accepts the same date-time with a trailing Z", () => {
      const result = dateSchema("2024-02-29T10:00:00Z")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-02-29T10:00:00.000Z")
    })

    it("still accepts the same date-time with a numeric offset", () => {
      const result = dateSchema("2024-02-29T10:00:00+02:00")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-02-29T08:00:00.000Z")
    })

    it("still accepts a date-only string, which ECMA-262 reads as UTC midnight regardless of host TZ", () => {
      const result = dateSchema("2024-02-29")
      expect(result instanceof type.errors).toBe(false)
      expect((result as Date).toISOString()).toBe("2024-02-29T00:00:00.000Z")
    })

    it("still accepts a year and a year-month, which ECMA-262 also reads as UTC", () => {
      expect((dateSchema("2024") as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z")
      expect((dateSchema("2024-05") as Date).toISOString()).toBe("2024-05-01T00:00:00.000Z")
    })

    it("still rejects an ordinal date regardless of a time part, unaffected by host TZ (#136)", () => {
      expect(dateSchema("2024-001") instanceof type.errors).toBe(true)
      expect(dateSchema("2024-001T10:00:00Z") instanceof type.errors).toBe(true)
    })
  })

  /** The ISO shape check, not just the calendar check, must still apply. */
  describe("non-ISO strings Date.parse can read but the ISO shape check refuses", () => {
    it("rejects a slash-separated date", () => {
      expect(dateSchema("2024/01/02") instanceof type.errors).toBe(true)
    })

    it("rejects a month-name date", () => {
      expect(dateSchema("Jan 2 2024") instanceof type.errors).toBe(true)
    })
  })
})

/**
 * `DateNullableSchema` is `dateSchema.or("null").default(null)`, arktype's `[Type, "=", default]`
 * tuple form — a value only usable as an object property (as `deletedAt` is in
 * `base-model.ts`'s `BaseModelSchema`), not a standalone callable schema. These tests exercise it
 * embedded the same way, through a one-field wrapper object.
 */
describe("DateNullableSchema", () => {
  const wrapper = type({ d: DateNullableSchema })

  it("defaults the field to null when it is absent from the input", () => {
    const result = wrapper({})
    expect(result instanceof type.errors).toBe(false)
    expect((result as { d: Date | null }).d).toBeNull()
  })

  it("accepts an explicit null", () => {
    const result = wrapper({ d: null })
    expect(result instanceof type.errors).toBe(false)
    expect((result as { d: Date | null }).d).toBeNull()
  })

  it("still parses a real date", () => {
    const result = wrapper({ d: "2024-01-01T00:00:00.000Z" })
    expect(result instanceof type.errors).toBe(false)
    expect((result as { d: Date | null }).d).toBeInstanceOf(Date)
  })

  it("still rejects garbage", () => {
    const result = wrapper({ d: "not a date" })
    expect(result instanceof type.errors).toBe(true)
  })

  it("inherits the calendar-date check (#131): still rejects 30 February", () => {
    const result = wrapper({ d: "2026-02-30" })
    expect(result instanceof type.errors).toBe(true)
  })
})
