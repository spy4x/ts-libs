import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { formatBytes, formatDecimal, formatPct, round } from "./format-number.ts"

describe("round", () => {
  it("rounds a positive halfway value up, where the naive form rounds down", () => {
    expect(round(1.005, 2)).toBe(1.01)
    // The naive `Math.round(v * 100) / 100` returns 1, because 1.005 * 100 is 100.49999999999999.
    expect(Math.round(1.005 * 100) / 100).toBe(1)
    expect(round(1.015, 2)).toBe(1.02)
    expect(round(1.275, 2)).toBe(1.28)
  })

  it("documents the negative-halfway limitation rather than pretending it is fixed", () => {
    // `-1.005` is binary-closer to zero than the decimal string, so the sign-inverted case still
    // under-rounds. Pinned here so a future change to this behaviour is a deliberate one.
    expect(round(-1.005, 2)).toBe(-1)
    expect(round(-1.015, 2)).toBe(-1.01)
  })

  it("rounds to an integer by default", () => {
    expect(round(13.50354562)).toBe(14)
    expect(round(1.4)).toBe(1)
  })

  it("rounds to two decimals when asked", () => {
    expect(round(13.50354562, 2)).toBe(13.5)
    expect(round(123456.789, 2)).toBe(123456.79)
  })

  it("honours an explicit precision", () => {
    expect(round(1.23456, 0)).toBe(1)
    expect(round(1.23456, 4)).toBe(1.2346)
    expect(round(2.5, 0)).toBe(3)
  })

  it("rounds float arithmetic noise away", () => {
    expect(round(0.1 + 0.2, 2)).toBe(0.3)
  })

  it("rounds a value small enough that JavaScript prints it in exponent form", () => {
    expect(round(0.0000001234, 2)).toBe(0)
    expect(round(1.2345e-7, 9)).toBe(1.23e-7)
    expect(round(-1.2345e-7, 9)).toBe(-1.23e-7)
  })

  it("keeps a value whose shifted form JavaScript prints in exponent form", () => {
    // 123456.789 * 10^20 prints as "1.23456789e+25"; unshifting must not append a second exponent.
    expect(round(123456.789, 20)).toBe(123456.789)
  })

  it("passes non-finite values through instead of producing NaN", () => {
    expect(round(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(Number.isNaN(round(Number.NaN))).toBe(true)
  })
})

describe("formatDecimal", () => {
  it("always renders exactly two decimals", () => {
    expect(formatDecimal(13.50354562)).toBe("13.50")
    expect(formatDecimal(2)).toBe("2.00")
    expect(formatDecimal(-0.015)).toBe("-0.01")
  })

  it("rounds the same way round() does, not the way toFixed does", () => {
    expect(formatDecimal(1.005)).toBe("1.01")
    expect(1.005.toFixed(2)).toBe("1.00")
    expect(formatDecimal(1.004)).toBe("1.00")
  })

  it("supports an explicit precision and passes non-finite input through", () => {
    expect(formatDecimal(1.23456, 4)).toBe("1.2346")
    expect(formatDecimal(Number.NaN)).toBe("NaN")
    expect(formatDecimal(Number.POSITIVE_INFINITY)).toBe("Infinity")
  })
})

describe("formatPct", () => {
  it("turns a fraction into a percentage with two decimals", () => {
    expect(formatPct(0.1234)).toBe("12.34%")
    expect(formatPct(1)).toBe("100.00%")
    expect(formatPct(0)).toBe("0.00%")
  })

  it("agrees with round and formatDecimal on the halfway case", () => {
    // `(value * 100).toFixed(2)` gave "1.00%" here; the shifted-decimal path gives "1.01%".
    expect(formatPct(0.01005)).toBe("1.01%")
    expect(formatDecimal(0.01005 * 100)).toBe("1.01")
  })

  it("agrees with formatDecimal for a spread of values", () => {
    for (const fraction of [0, 0.00005, 0.01005, 0.1234, 0.12345, 0.615, 0.999999, 1]) {
      expect(formatPct(fraction)).toBe(`${formatDecimal(fraction * 100)}%`)
    }
  })

  it("renders a non-finite value as zero instead of NaN", () => {
    expect(formatPct(Number.NaN)).toBe("0.00%")
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("0.00%")
  })
})

describe("formatBytes", () => {
  it("renders a byte count under 1024 as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("renders a whole unit with no decimal", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB")
  })

  it("renders a fractional unit to one decimal place", () => {
    expect(formatBytes(1.5 * 1024)).toBe("1.5 KB")
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe("1.3 GB")
  })

  it("moves to the next unit when rounding reaches 1024 of the current one", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB")
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe("1 GB")
  })

  it("stops at terabytes", () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2048 TB")
  })
})
