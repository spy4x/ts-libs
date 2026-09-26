import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { HONEYPOT_FIELD_NAME, honeypotFilled } from "./honeypot.ts"

describe("honeypotFilled", () => {
  it("is false when the field was never filled in", () => {
    const data = new FormData()
    expect(honeypotFilled(data)).toBe(false)
  })

  it("is false when the field is present but empty", () => {
    const data = new FormData()
    data.set(HONEYPOT_FIELD_NAME, "")
    expect(honeypotFilled(data)).toBe(false)
  })

  it("is true once something filled it in", () => {
    const data = new FormData()
    data.set(HONEYPOT_FIELD_NAME, "http://spam.example")
    expect(honeypotFilled(data)).toBe(true)
  })

  it("reads a caller-chosen field name instead of the default", () => {
    const data = new FormData()
    data.set("company-site", "http://spam.example")
    expect(honeypotFilled(data)).toBe(false)
    expect(honeypotFilled(data, "company-site")).toBe(true)
  })
})

describe("HONEYPOT_FIELD_NAME", () => {
  it("is not a name browser autofill fills in", () => {
    expect(HONEYPOT_FIELD_NAME).toBe("hp-field")
  })
})
