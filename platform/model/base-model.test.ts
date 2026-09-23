import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import {
  BaseModelSchema,
  ImmutableBaseModelSchema,
  UndeletableBaseModelSchema,
} from "./base-model.ts"

describe("ImmutableBaseModelSchema", () => {
  it("accepts an id and a createdAt Date", () => {
    const result = ImmutableBaseModelSchema({ id: 1, createdAt: new Date("2024-01-01") })
    expect(result instanceof type.errors).toBe(false)
  })

  it("accepts a createdAt given as an ISO string", () => {
    const result = ImmutableBaseModelSchema({ id: 1, createdAt: "2024-01-01T00:00:00.000Z" })
    expect(result instanceof type.errors).toBe(false)
  })

  it("rejects a missing id", () => {
    const result = ImmutableBaseModelSchema({ createdAt: new Date() })
    expect(result instanceof type.errors).toBe(true)
  })
})

describe("UndeletableBaseModelSchema", () => {
  it("requires updatedAt on top of the immutable fields", () => {
    const missing = UndeletableBaseModelSchema({ id: 1, createdAt: new Date() })
    expect(missing instanceof type.errors).toBe(true)

    const full = UndeletableBaseModelSchema({
      id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(full instanceof type.errors).toBe(false)
  })
})

describe("BaseModelSchema", () => {
  it("defaults deletedAt to null when absent", () => {
    const result = BaseModelSchema({ id: 1, createdAt: new Date(), updatedAt: new Date() })
    expect(result instanceof type.errors).toBe(false)
    expect((result as { deletedAt: Date | null }).deletedAt).toBeNull()
  })

  it("accepts an explicit deletedAt", () => {
    const deletedAt = new Date("2024-06-01")
    const result = BaseModelSchema({
      id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt,
    })
    expect(result instanceof type.errors).toBe(false)
    expect((result as { deletedAt: Date | null }).deletedAt).toEqual(deletedAt)
  })

  /**
   * Pins the `"+": "reject"` decision recorded in `base-model.ts`: none of the three schemas
   * declares it, precisely so an app can `.and()` its own fields onto `BaseModelSchema` without
   * arktype rejecting them. This is that composition, done the way an app would do it.
   */
  it("composes with an app's own object schema via .and(), and the composed schema accepts the app's field", () => {
    const groupSchema = BaseModelSchema.and({ name: "string" })
    const result = groupSchema({
      id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      name: "Acme",
    })
    expect(result instanceof type.errors).toBe(false)
    expect((result as { name: string }).name).toBe("Acme")
  })

  it('a plain, unextended BaseModelSchema does not reject an unrecognised key (no schema here sets "+": "reject")', () => {
    const result = BaseModelSchema({
      id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      extra: "unrecognised",
    })
    expect(result instanceof type.errors).toBe(false)
  })
})
