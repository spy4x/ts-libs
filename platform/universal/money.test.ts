import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { currencyDecimals, formatMoney, formatMoneyParts, parseMoney } from "./money.ts"

describe("currencyDecimals", () => {
  it("never assumes two decimals", () => {
    expect(currencyDecimals("EUR")).toBe(2)
    expect(currencyDecimals("JPY")).toBe(0)
    expect(currencyDecimals("KWD")).toBe(3)
  })
})

describe("formatMoney", () => {
  it("shows 12345 as €123.45 in euros, ¥12,345 in yen, three decimals in Kuwaiti dinar", () => {
    expect(formatMoney(12345, "EUR")).toBe("€123.45")
    expect(formatMoney(12345, "JPY")).toBe("¥12,345")
    expect(formatMoney(12345, "KWD")).toBe("KWD 12.345")
  })

  it("formats a negative amount with its sign", () => {
    expect(formatMoney(-500, "USD")).toBe("-$5.00")
  })

  it("formats a very large safe-integer amount without a rounding error", () => {
    // 12,345,678,901,234 minor units of a 2-decimal currency is $123,456,789,012.34 — a value a
    // naive `amount / 100` division followed by a loose format could round away the last digit.
    expect(formatMoney(12_345_678_901_234, "USD")).toBe("$123,456,789,012.34")
  })

  it("throws for a non-integer amount instead of silently formatting the wrong number", () => {
    expect(() => formatMoney(12.5, "USD")).toThrow()
  })

  it("throws for an amount beyond Number.MAX_SAFE_INTEGER", () => {
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 2, "USD")).toThrow()
  })
})

describe("formatMoneyParts", () => {
  it("splits the same text formatMoney renders into parts", () => {
    const parts = formatMoneyParts(12345, "EUR")
    expect(parts.map((part) => part.value).join("")).toBe(formatMoney(12345, "EUR"))
    expect(parts.some((part) => part.type === "currency")).toBe(true)
  })
})

describe("parseMoney", () => {
  it("parses '12,5' in German to 1250, understanding the German decimal mark", () => {
    const result = parseMoney("12,5", "EUR", "de")
    expect(result).toEqual({ ok: true, value: 1250 })
  })

  it("parses '1.234,56' in German to 123456, understanding the German group mark", () => {
    const result = parseMoney("1.234,56", "EUR", "de")
    expect(result).toEqual({ ok: true, value: 123456 })
  })

  it("parses the same amount typed in English with its own marks", () => {
    expect(parseMoney("1,234.56", "EUR", "en")).toEqual({ ok: true, value: 123456 })
  })

  it("has no 0.1 + 0.2 rounding error: digits are combined with BigInt, never multiplied floats", () => {
    // The naive `Math.round(parseFloat("0.1") * 100 + parseFloat("0.2") * 100)` still lands on 30
    // by luck; this checks the digit path directly, and a value where the naive float path visibly
    // drifts: 0.1 + 0.2 as a double is 0.30000000000000004, one ULP off 0.3.
    expect(parseMoney("0.30", "USD")).toEqual({ ok: true, value: 30 })
    expect(parseMoney(String(0.1 + 0.2), "USD")).toEqual(
      { ok: false, error: { type: "too-many-decimals", maxDecimals: 2 } },
    )
  })

  it("refuses 1.005 for a 2-decimal currency instead of rounding it to 100 or 101", () => {
    // `Math.round(1.005 * 100)` is 100, from the same 100.49999999999999 error `round()` in
    // `format-number.ts` exists to correct for display — money refuses instead of guessing.
    expect(parseMoney("1.005", "USD")).toEqual(
      { ok: false, error: { type: "too-many-decimals", maxDecimals: 2 } },
    )
  })

  it("refuses more decimals than JPY (0) or KWD (3) allow", () => {
    expect(parseMoney("12.5", "JPY")).toEqual(
      { ok: false, error: { type: "too-many-decimals", maxDecimals: 0 } },
    )
    expect(parseMoney("1.2345", "KWD")).toEqual(
      { ok: false, error: { type: "too-many-decimals", maxDecimals: 3 } },
    )
    expect(parseMoney("1.234", "KWD")).toEqual({ ok: true, value: 1234 })
  })

  it("parses a whole yen amount with no fraction digits at all", () => {
    expect(parseMoney("12345", "JPY")).toEqual({ ok: true, value: 12345 })
  })

  it("refuses an amount whose smallest-unit value exceeds Number.MAX_SAFE_INTEGER", () => {
    expect(parseMoney("99999999999999999", "USD")).toEqual(
      { ok: false, error: { type: "too-large" } },
    )
  })

  it("accepts an amount right at Number.MAX_SAFE_INTEGER", () => {
    expect(parseMoney("90071992547409.91", "USD")).toEqual(
      { ok: true, value: Number.MAX_SAFE_INTEGER },
    )
  })

  it("refuses letters, giving a caller something to show rather than a wrong number", () => {
    expect(parseMoney("12a5", "USD")).toEqual({ ok: false, error: { type: "invalid-characters" } })
    expect(parseMoney("abc", "USD")).toEqual({ ok: false, error: { type: "invalid-characters" } })
  })

  it("treats empty text, and a bare sign or decimal mark, as empty rather than invalid", () => {
    expect(parseMoney("", "USD")).toEqual({ ok: false, error: { type: "empty" } })
    expect(parseMoney("   ", "USD")).toEqual({ ok: false, error: { type: "empty" } })
    expect(parseMoney("-", "USD")).toEqual({ ok: false, error: { type: "empty" } })
    expect(parseMoney(".", "USD")).toEqual({ ok: false, error: { type: "empty" } })
  })

  it("parses a negative amount", () => {
    expect(parseMoney("-12.50", "USD")).toEqual({ ok: true, value: -1250 })
  })

  it("parses a leading-decimal amount as a fraction of the major unit", () => {
    expect(parseMoney(".5", "USD")).toEqual({ ok: true, value: 50 })
  })
})
