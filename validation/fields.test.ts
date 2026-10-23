import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type ArkErrors, type } from "arktype"
import { fieldErrors, fieldErrorsSchema } from "./fields.ts"
import { FORM_FIELD } from "./model.ts"

function rejection(schema: { (value: unknown): unknown }, value: unknown): ArkErrors {
  const outcome = schema(value)
  if (!(outcome instanceof type.errors)) throw new Error("the schema accepted the value")
  return outcome
}

describe("fieldErrors", () => {
  it("names each failing field with arktype's code and the rule it missed", () => {
    const schema = type({ title: "string", name: "string <= 120", age: "number > 17" })
    const errors = rejection(schema, { name: "x".repeat(121), age: 17 })
    expect(fieldErrors(errors)).toEqual({
      title: { code: "required" },
      name: { code: "maxLength", values: { rule: 120 } },
      age: { code: "min", values: { rule: 17, exclusive: true } },
    })
  })

  it("keys a nested field by its path and a value with no path by the form key", () => {
    expect(fieldErrors(rejection(type({ address: { city: "string" } }), { address: { city: 1 } })))
      .toEqual({ "address.city": { code: "domain" } })
    expect(fieldErrors(rejection(type("string"), 1))).toEqual({ [FORM_FIELD]: { code: "domain" } })
  })

  it("sends a date rule as its ISO string", () => {
    const errors = rejection(type({ at: "Date > d'2020-01-01'" }), { at: new Date(0) })
    expect(fieldErrors(errors)).toEqual({
      at: { code: "after", values: { rule: "2020-01-01T00:00:00.001Z" } },
    })
  })

  it("never carries the submitted value", () => {
    const errors = rejection(type({ password: /^.{12,}$/ }), { password: "hunter2" })
    expect(JSON.stringify(fieldErrors(errors))).not.toContain("hunter2")
  })

  it("keeps the first issue arktype reports when one field fails twice", () => {
    const errors = rejection(type({ name: "/^a/ & string >= 3" }), { name: "1" })
    const [first, second] = errors.flatByPath.name
    expect(first.code).not.toBe(second.code)
    expect(fieldErrors(errors).name.code).toBe(first.code)
  })

  it("produces what fieldErrorsSchema accepts", () => {
    const errors = rejection(type({ name: "string <= 3", n: "number % 2" }), { name: "abcd", n: 3 })
    expect(fieldErrorsSchema(fieldErrors(errors))).not.toBeInstanceOf(type.errors)
    expect(fieldErrorsSchema({ name: { code: 1 } })).toBeInstanceOf(type.errors)
  })
})
