import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

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

    it("rejects a calendar date that does not exist when the year carries a sign", () => {
      expect(dateSchema("+2023-02-29") instanceof type.errors).toBe(true)
      expect(dateSchema("+2026-04-31") instanceof type.errors).toBe(true)
      expect(dateSchema("-1900-02-29") instanceof type.errors).toBe(true)
      expect(dateSchema("+2024-02-29") instanceof type.errors).toBe(false)
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
