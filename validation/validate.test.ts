import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import { firstIssueMessage, toValidationError, validate, type ValidationError } from "./validate.ts"

const dateSchema = type("Date | string.date.iso.parse")
const userSchema = type({
  name: "1 <= string <= 10",
  joinedAt: dateSchema,
  address: { city: "string" },
})

describe("validate", () => {
  it("returns null error and the parsed value for a valid input", () => {
    const { error, data } = validate(userSchema, {
      name: "Ada",
      joinedAt: "2024-01-01T00:00:00.000Z",
      address: { city: "Berlin" },
    })
    expect(error).toBeNull()
    expect(data?.joinedAt).toBeInstanceOf(Date)
    expect(data?.address.city).toBe("Berlin")
  })

  it("returns the parsed value rather than the input when the schema morphs it", () => {
    const schema = type({ n: "string" }).pipe((value) => ({ n: Number(value.n) }))
    const { error, data } = validate(schema, { n: "42" })

    expect(error).toBeNull()
    expect(data?.n).toBe(42)
    expect(typeof data?.n).toBe("number")
  })

  it("returns null data and a summary when the schema rejects", () => {
    const { error, data } = validate(userSchema, { name: "", joinedAt: "nope", address: {} })

    expect(data).toBeNull()
    if (error === null) throw new Error("expected a validation error")
    expect(error.description).toContain("name must be non-empty")
    expect(error.description).toContain("joinedAt must be an ISO 8601")
  })

  it("carries arktype's own errors instance in details", () => {
    const { error } = validate(userSchema, { name: "", joinedAt: "nope", address: {} })

    if (error === null) throw new Error("expected a validation error")
    expect(error.details).toBeInstanceOf(type.errors)
    expect(Object.keys(error.details.flatByPath).sort()).toEqual([
      "address.city",
      "joinedAt",
      "name",
    ])
    expect(error.details.flatByPath.name?.[0].code).toBe("minLength")
  })

  it("surfaces a nested failure in the summary and the first issue message", () => {
    const { error } = validate(userSchema, { name: "Ada", joinedAt: new Date(), address: {} })

    if (error === null) throw new Error("expected a validation error")
    expect(error.description).toContain("address.city")
    expect(firstIssueMessage(error)).toContain("address.city")
  })

  it("names the offending field of a nested failure by dotted path", () => {
    const { error } = validate(userSchema, { name: "Ada", joinedAt: new Date(), address: {} })

    if (error === null) throw new Error("expected a validation error")
    // `path` is arktype's `ReadonlyPath`, an array subclass carrying a cache, so compare a copy.
    expect([...error.details.flatByPath["address.city"]![0].path]).toEqual(["address", "city"])
    expect(error.description).not.toContain("name must")
  })

  it("does not parse a valid value twice", () => {
    let calls = 0
    const schema = type({ n: "string" }).pipe((value) => {
      calls++
      return { n: Number(value.n) }
    })
    const { error, data } = validate(schema, { n: "42" })

    expect(error).toBeNull()
    expect(data?.n).toBe(42)
    expect(calls).toBe(1)
  })

  it("parses once on the failure path", () => {
    // The bug this guards is parsing twice, and the source only parsed twice when the value was
    // rejected: the second call sat inside the `else` of the first. A counter on the success path
    // cannot see that, so the schema here rejects one field while a sibling's morph counts — arktype
    // still runs the sibling morph, which makes the count observable on the failure path.
    let calls = 0
    const schema = type({
      n: type("string").pipe((value) => {
        calls++
        return value
      }),
      bad: "number",
    })
    const { error, data } = validate(schema, { n: "42", bad: "not a number" })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(calls).toBe(1)
  })
})

describe("toValidationError", () => {
  it("wraps arktype's issues in the description/details envelope", () => {
    const result = userSchema({ name: 5, joinedAt: new Date(), address: { city: "x" } })
    if (!(result instanceof type.errors)) throw new Error("expected errors")

    const error = toValidationError(result)
    expect(error.description).toBe(result.summary)
    expect(error.details).toBe(result)
  })
})

describe("firstIssueMessage", () => {
  it("returns the first issue arktype reports, path included", () => {
    const { error } = validate(userSchema, { name: "", joinedAt: "nope", address: {} })
    if (error === null) throw new Error("expected a validation error")

    const first = [...error.details][0]
    expect(firstIssueMessage(error)).toBe(first?.message)
    expect(firstIssueMessage(error)).toBeTruthy()
  })

  it("returns null when the error carries no issues", () => {
    // No schema produces a rejection with zero issues, and `type.errors` takes a traversal, so the
    // branch is reached with the shape the function actually reads: an empty issue list.
    const bare = { description: "", details: [] } as unknown as ValidationError
    expect(firstIssueMessage(bare)).toBeNull()
  })
})
