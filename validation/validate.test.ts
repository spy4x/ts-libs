import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Type, type } from "arktype"
import {
  firstIssueMessage,
  isArkErrors,
  toValidationError,
  validate,
  type ValidationError,
} from "./validate.ts"

/**
 * An object with arktype's public rejection shape — an array of issues with a `summary` string
 * and a `throw` method — built without arktype's own `ArkErrors` class.
 *
 * Stands in for a rejection built by a second, differently-loaded copy of arktype: same shape,
 * different class identity, so `instanceof` against this module's `type.errors` fails on it even
 * though it is exactly what a real rejection looks like.
 */
function foreignArkErrors(message: string) {
  return Object.assign([{ path: [], message }], {
    summary: message,
    throw: () => {
      throw new Error(message)
    },
  })
}

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

describe("isArkErrors", () => {
  it("recognizes a real rejection", () => {
    const result = userSchema({ name: "", joinedAt: "nope", address: {} })
    expect(isArkErrors(result)).toBe(true)
  })

  it("does not mistake a successful parse for a rejection", () => {
    const result = userSchema({ name: "Ada", joinedAt: new Date(), address: { city: "Berlin" } })
    expect(isArkErrors(result)).toBe(false)
  })

  it("does not mistake a plain array for a rejection", () => {
    expect(isArkErrors(["a", "b"])).toBe(false)
  })

  it("recognizes an errors-shaped value that fails instanceof", () => {
    const foreign = foreignArkErrors("start before end")
    expect(foreign instanceof type.errors).toBe(false)
    expect(isArkErrors(foreign)).toBe(true)
  })
})

describe("validate — a rejection from a differently-loaded arktype copy", () => {
  it("still reports an error instead of reading the rejection as the parsed value", () => {
    const foreign = foreignArkErrors("must be a equal to b")
    const fakeSchema = ((_value: unknown) => foreign) as unknown as Type

    const { error, data } = validate(fakeSchema, { a: "x", b: "y" })

    expect(data).toBeNull()
    expect(error?.description).toBe("must be a equal to b")
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
