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
})
