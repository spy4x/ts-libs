import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { isRecord } from "./is-record.ts"

describe("isRecord", () => {
  it("accepts an object, empty or not", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ error: "x" })).toBe(true)
  })

  it("refuses null, arrays and primitives", () => {
    for (const other of [null, undefined, [], [1], "x", 1, true, () => {}]) {
      expect(isRecord(other)).toBe(false)
    }
  })

  it("narrows the type so keys can be read", () => {
    const body: unknown = JSON.parse(`{"error":{"message":"no"}}`)
    const message = isRecord(body) && isRecord(body.error) ? body.error.message : undefined
    expect(message).toBe("no")
  })
})
