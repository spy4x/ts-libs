import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { parseBoundedInteger } from "./bounded-integer.ts"

const page = { fallback: 20, max: 50 }

describe("parseBoundedInteger", () => {
  it("gives the fallback for a missing value", () => {
    expect(parseBoundedInteger(undefined, page)).toBe(20)
  })

  it("accepts the smallest and the largest value and those between", () => {
    expect(parseBoundedInteger("1", page)).toBe(1)
    expect(parseBoundedInteger("37", page)).toBe(37)
    expect(parseBoundedInteger("50", page)).toBe(50)
  })

  it("gives null for a number outside the bounds", () => {
    expect(parseBoundedInteger("0", page)).toBeNull()
    expect(parseBoundedInteger("51", page)).toBeNull()
    expect(parseBoundedInteger("99999999999999999999999", page)).toBeNull()
  })

  it("gives null for text that is not plain decimal digits", () => {
    for (const bad of ["-3", "1.5", "1e2", "x", "", " 5", "5 ", "0x10", "+5", "٣"]) {
      expect(parseBoundedInteger(bad, page)).toBeNull()
    }
  })

  it("takes the minimum from the options", () => {
    expect(parseBoundedInteger("0", { fallback: 0, min: 0, max: 5 })).toBe(0)
    expect(parseBoundedInteger("4", { fallback: 5, min: 5, max: 9 })).toBeNull()
  })

  it("gives null for a signed number even when the bounds include negatives", () => {
    const signed = { fallback: 0, min: -5, max: 5 }
    expect(parseBoundedInteger("-3", signed)).toBeNull()
    expect(parseBoundedInteger("+3", signed)).toBeNull()
    expect(parseBoundedInteger("3", signed)).toBe(3)
  })

  it("refuses options that cannot hold a value", () => {
    expect(() => parseBoundedInteger("1", { fallback: 1, min: 9, max: 5 })).toThrow(RangeError)
    expect(() => parseBoundedInteger("1", { fallback: 60, max: 50 })).toThrow(RangeError)
    expect(() => parseBoundedInteger("1", { fallback: 0, max: 50 })).toThrow(RangeError)
  })

  it("refuses options that are not safe integers", () => {
    const bad = [
      { fallback: 20, max: Infinity },
      { fallback: 20, max: Number.MAX_VALUE },
      { fallback: Number.NaN, max: 50 },
      { fallback: 2.5, max: 50 },
      { fallback: 20, min: 0.5, max: 50 },
      { fallback: 20, min: Number.NaN, max: 50 },
    ]
    for (const options of bad) {
      expect(() => parseBoundedInteger("5", options)).toThrow(RangeError)
    }
  })
})
