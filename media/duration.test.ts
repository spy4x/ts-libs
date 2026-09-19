import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { formatDurationParam, getTrueResolution, parseDurationMs } from "./duration.ts"

describe("parseDurationMs", () => {
  it("reads a six-digit fraction as milliseconds without assuming the digit count", () => {
    // The extracted source ran `durationStr.slice(0, -3)`, so the assertion is
    // on the value, not on the string surgery: 12.345678 s is 12345 ms.
    expect(parseDurationMs("12.345678")).toBe(12345)
  })

  it("reads a three-digit fraction as milliseconds", () => {
    expect(parseDurationMs("10.500")).toBe(10500)
  })

  it("reads a one-digit fraction as tenths of a second", () => {
    // `"10.5".slice(0, -3)` is `"10."`, i.e. the old code returned 10000 here.
    expect(parseDurationMs("10.5")).toBe(10500)
  })

  it("reads a value without any fraction as whole seconds", () => {
    expect(parseDurationMs("42")).toBe(42000)
  })

  it("reads an integer-second string that arrives with a trailing dot", () => {
    expect(parseDurationMs("42.")).toBe(42000)
  })

  it("truncates below a millisecond rather than rounding up past it", () => {
    expect(parseDurationMs("0.000999")).toBe(0)
    expect(parseDurationMs("1.9999")).toBe(1999)
  })

  it("accepts a comma as the decimal separator", () => {
    expect(parseDurationMs("10,5")).toBe(10500)
    expect(parseDurationMs("10,25")).toBe(10250)
  })

  it("accepts a number as well as a string", () => {
    expect(parseDurationMs(10.5)).toBe(10500)
    expect(parseDurationMs(0)).toBe(0)
  })

  it("returns null for empty, absent and unparseable values", () => {
    expect(parseDurationMs("")).toBe(null)
    expect(parseDurationMs("   ")).toBe(null)
    expect(parseDurationMs("N/A")).toBe(null)
    expect(parseDurationMs("1m30s")).toBe(null)
    expect(parseDurationMs(null)).toBe(null)
    expect(parseDurationMs(undefined)).toBe(null)
  })

  it("returns null for a negative duration instead of a negative number", () => {
    expect(parseDurationMs("-1")).toBe(null)
    expect(parseDurationMs(-1)).toBe(null)
  })

  it("returns null for a group-separated number", () => {
    expect(parseDurationMs("1,234.5")).toBe(null)
  })
})

describe("formatDurationParam", () => {
  it("formats milliseconds as seconds with a three-digit fraction", () => {
    expect(formatDurationParam(120250)).toBe("120.250")
  })

  it("pads a fraction below 100 ms to three digits", () => {
    expect(formatDurationParam(1005)).toBe("1.005")
  })

  it("formats zero", () => {
    expect(formatDurationParam(0)).toBe("0.000")
  })

  it("formats a negative offset with the sign in front of the seconds", () => {
    // The source produced "-2.-500" for this input.
    expect(formatDurationParam(-2500)).toBe("-2.500")
  })

  it("drops a fractional millisecond input", () => {
    expect(formatDurationParam(1500.7)).toBe("1.500")
  })

  it("rejects a non-finite input", () => {
    expect(() => formatDurationParam(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => formatDurationParam(Number.NaN)).toThrow(RangeError)
  })
})

describe("getTrueResolution", () => {
  it("keeps the coded resolution when the frame is not rotated", () => {
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: 0 })).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it("swaps the axes for a quarter-turn rotation", () => {
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: 90 })).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: -90 })).toEqual({
      width: 1080,
      height: 1920,
    })
  })

  it("swaps the axes for the equivalent three-quarter turns", () => {
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: 270 })).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: -270 })).toEqual({
      width: 1080,
      height: 1920,
    })
  })

  it("keeps the coded resolution for a half turn", () => {
    expect(getTrueResolution({ width: 1920, height: 1080, rotation: 180 })).toEqual({
      width: 1920,
      height: 1080,
    })
  })
})
