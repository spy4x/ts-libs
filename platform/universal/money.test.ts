import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  currencyDecimals,
  formatMoney,
  formatMoneyParts,
  moneyDecimalString,
  parseMoney,
} from "./money.ts"

/** Locales exercised by the round-trip test below — see its own doc for what each one covers. */
const ROUND_TRIP_LOCALES = [
  "sv",
  "fi",
  "nb",
  "lt",
  "sl",
  "he",
  "ur",
  "ar-EG",
  "fa",
  "bn",
  "mr",
  "de",
  "fr",
  "de-CH",
  "en-IN",
  "en",
  "ja",
]

/**
 * The plain, ungrouped decimal text a caller would show for editing — the same shape
 * `money-input.tsx`'s own `editableText` builds, reimplemented here rather than imported so this
 * test does not depend on `ui/`'s own file layout.
 */
function editableText(value: number, currency: string, locale: string): string {
  const decimals = currencyDecimals(currency, locale)
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(moneyDecimalString(value, decimals) as unknown as number)
}

describe("currencyDecimals", () => {
  it("never assumes two decimals", () => {
    expect(currencyDecimals("EUR")).toBe(2)
    expect(currencyDecimals("JPY")).toBe(0)
    expect(currencyDecimals("KWD")).toBe(3)
  })
})

describe("moneyDecimalString", () => {
  it("gives a zero amount the currency's own decimals, not a bare '0'", () => {
    expect(moneyDecimalString(0, 2)).toBe("0.00")
    expect(moneyDecimalString(0, 3)).toBe("0.000")
  })

  it("gives a zero-decimal currency's zero amount a bare '0', with no trailing point", () => {
    expect(moneyDecimalString(0, 0)).toBe("0")
  })

  it("never puts a minus sign on a zero amount, including -0", () => {
    expect(moneyDecimalString(-0, 2)).toBe("0.00")
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

  it("is exact for an amount right at Number.MAX_SAFE_INTEGER, where a float division rounds the last digit", () => {
    // amount / 10 ** decimals as a double rounds this to a value that prints ".90"; the exact
    // decimal value's last digit is ".91". Built from the digit string, not the division.
    expect(formatMoney(9_007_199_254_740_991, "USD")).toBe("$90,071,992,547,409.91")
  })

  it("shows a zero amount as a plain zero, never -0", () => {
    expect(formatMoney(-0, "EUR")).toBe("€0.00")
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

  it("refuses a grouping mark typed where Intl would not place one, instead of stripping it", () => {
    // "12.50" in German reads "." as the grouping mark, not a decimal point — stripping it
    // unconditionally used to turn this into €1,250.00 with no error.
    expect(parseMoney("12.50", "EUR", "de")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
    expect(parseMoney("12,50", "EUR", "en")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
    expect(parseMoney("1,5", "EUR", "en")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
    expect(parseMoney(",5", "EUR", "en")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
    expect(parseMoney("5,", "EUR", "en")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
  })

  it("accepts Indian lakh grouping and refuses western grouping for the same locale", () => {
    expect(parseMoney("1,23,456.00", "EUR", "en-IN")).toEqual({ ok: true, value: 12345600 })
    expect(parseMoney("123,456.00", "EUR", "en-IN")).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
  })

  it("refuses a second decimal mark instead of silently dropping everything after it", () => {
    // Without this check, destructuring the split result reads only its first two parts and
    // silently discards the rest — "1.2.3" in English would parse as "1.2", i.e. 120 cents,
    // dropping the ".3" a visitor typed with no error at all.
    expect(parseMoney("1.2.3", "USD")).toEqual({ ok: false, error: { type: "invalid-characters" } })
  })

  it("accepts a plain space or an ASCII apostrophe as the locale's own look-alike grouping mark", () => {
    // fr's own grouping mark is U+202F NARROW NO-BREAK SPACE; de-CH's is U+2019 RIGHT SINGLE
    // QUOTATION MARK. A visitor's own keyboard types a plain space or a plain apostrophe instead.
    expect(parseMoney("1 234,56", "EUR", "fr")).toEqual({ ok: true, value: 123456 })
    expect(parseMoney("1'234.56", "CHF", "de-CH")).toEqual({ ok: true, value: 123456 })
  })

  it("normalises a parsed negative zero to a plain zero", () => {
    const result = parseMoney("-0.00", "EUR")
    expect(result).toEqual({ ok: true, value: 0 })
    // toEqual alone does not distinguish 0 from -0 (both satisfy ===); Object.is does, and this is
    // exactly the value a caller could hand straight to formatMoney and print "-€0.00" for what is
    // actually a zero amount.
    expect(result.ok && Object.is(result.value, -0)).toBe(false)
  })

  it("round-trips value, the locale's own edited text, and parseMoney for every listed locale", () => {
    // Each of these locales prints something ASCII-digit-and-hyphen parsing cannot read back:
    // sv/fi/nb/lt/sl print U+2212 MINUS SIGN for a negative amount; he/ur are right-to-left and may
    // wrap the sign in a bidi mark; ar-EG/fa/bn/mr print their own digit glyphs, not 0-9; de/fr/
    // de-CH/en-IN exercise this module's own group and decimal marks; en and ja are the plain
    // baseline.
    for (const locale of ROUND_TRIP_LOCALES) {
      for (const value of [12345, -12345, 0, 1, 9007199254740991]) {
        const text = editableText(value, "USD", locale)
        const result = parseMoney(text, "USD", locale)
        expect({ locale, value, text, result }).toEqual({
          locale,
          value,
          text,
          result: { ok: true, value },
        })
      }
    }
  })
})
