import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type } from "arktype"

import {
  allocate,
  convertMoney,
  crossRate,
  currencies,
  CURRENCIES_PUBLISHED,
  currencyCode,
  currencyDecimals,
  currencyOptions,
  detectNumberFormat,
  type ExchangeRate,
  formatMoney,
  formatMoneyParts,
  isCurrencyCode,
  isDebitCreditPair,
  moneyDecimalString,
  NUMBER_FORMATS,
  parseAmount,
  parseMoney,
  sumMoney,
} from "./money.ts"
import { seededRandom } from "./statistics.ts"

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

describe("money with caller-given decimals", () => {
  it("formats USDT, a code Intl rejects, with the six decimals the caller gives", () => {
    expect(formatMoney(1500000, "USDT", "en", { decimals: 6 })).toBe("USDT\u00a01.500000")
    expect(formatMoney(-1, "USDT", "en", { decimals: 6 })).toBe("-USDT\u00a00.000001")
  })

  it("rejects an invalid locale with a RangeError when the code is one Intl rejects", () => {
    expect(() => formatMoney(1, "USDT", "!!bad", { decimals: 6 })).toThrow(RangeError)
  })

  it("places the currency code the way the locale places a currency symbol", () => {
    expect(formatMoney(1500000, "USDT", "de", { decimals: 6 })).toBe("1,500000\u00a0USDT")
  })

  it("formats BTC with eight decimals instead of the two Intl gives it", () => {
    expect(formatMoney(1, "BTC", "en", { decimals: 8 })).toBe("BTC\u00a00.00000001")
    expect(formatMoney(123456789, "BTC", "en", { decimals: 8 })).toBe("BTC\u00a01.23456789")
    expect(formatMoney(123456789, "BTC")).toBe("BTC\u00a01,234,567.89")
  })

  it("lets a caller override the decimals of a currency Intl knows", () => {
    expect(formatMoney(12345, "EUR", "en", { decimals: 3 })).toBe("€12.345")
  })

  it("keeps existing calls exactly as they were when no decimals are given", () => {
    expect(formatMoney(12345, "EUR")).toBe("€123.45")
    expect(formatMoney(12345, "JPY")).toBe("¥12,345")
    expect(formatMoney(12345, "KWD")).toBe("KWD\u00a012.345")
    expect(formatMoney(12345, "EUR", "en", {})).toBe("€123.45")
  })

  it("returns the code as a currency part from formatMoneyParts", () => {
    const parts = formatMoneyParts(1500000, "USDT", "en", { decimals: 6 })
    expect(parts.find((part) => part.type === "currency")?.value).toBe("USDT")
  })

  it("parses typed text into an integer count of the smallest unit", () => {
    expect(parseMoney("1.5", "USDT", "en", { decimals: 6 })).toEqual({ ok: true, value: 1500000 })
    expect(parseMoney("0.00000001", "BTC", "en", { decimals: 8 })).toEqual({ ok: true, value: 1 })
    expect(parseMoney("0.0000001", "USDT", "en", { decimals: 6 })).toEqual({
      ok: false,
      error: { type: "too-many-decimals", maxDecimals: 6 },
    })
  })

  it("reports the given decimals from currencyDecimals", () => {
    expect(currencyDecimals("USDT", "en", { decimals: 6 })).toBe(6)
    expect(currencyDecimals("BTC", "en", { decimals: 0 })).toBe(0)
  })

  it("refuses decimals that are not a whole number from 0 to 20", () => {
    for (const decimals of [-1, 1.5, 21, NaN]) {
      expect(() => currencyDecimals("BTC", "en", { decimals })).toThrow(/whole number from 0 to 20/)
    }
  })

  it("still rejects an unknown code when no decimals are given", () => {
    expect(() => currencyDecimals("USDT")).toThrow(RangeError)
  })
})

describe("money with a blank currency code", () => {
  const blanks = ["", " ", "\t"]

  it("formatMoney throws a RangeError for a blank code, with or without decimals", () => {
    expect(() => formatMoney(1, "", "en", { decimals: 2 })).toThrow(RangeError)
    for (const code of blanks) {
      expect(() => formatMoney(1, code, "en", { decimals: 2 })).toThrow(RangeError)
      expect(() => formatMoney(1, code)).toThrow(RangeError)
    }
  })

  it("formatMoneyParts throws a RangeError for a blank code, with or without decimals", () => {
    for (const code of blanks) {
      expect(() => formatMoneyParts(1, code, "en", { decimals: 2 })).toThrow(RangeError)
      expect(() => formatMoneyParts(1, code)).toThrow(RangeError)
    }
  })

  it("currencyDecimals throws a RangeError for a blank code, with or without decimals", () => {
    for (const code of blanks) {
      expect(() => currencyDecimals(code, "en", { decimals: 2 })).toThrow(RangeError)
      expect(() => currencyDecimals(code)).toThrow(RangeError)
    }
  })

  it("parseMoney throws a RangeError for a blank code, even for blank text", () => {
    for (const code of blanks) {
      expect(() => parseMoney("1.00", code, "en", { decimals: 2 })).toThrow(RangeError)
      expect(() => parseMoney("1.00", code)).toThrow(RangeError)
      expect(() => parseMoney("", code, "en", { decimals: 2 })).toThrow(RangeError)
    }
  })
})

describe("the ISO 4217 currency table", () => {
  it("gives currencyDecimals the table's value for every code, without a decimals option", () => {
    const codes = Object.keys(currencies)
    expect(codes.length).toBe(165)
    for (const code of codes) {
      expect([code, currencyDecimals(code)]).toEqual([code, currencies[code]])
      expect([code, currencyDecimals(code, "ar-EG")]).toEqual([code, currencies[code]])
    }
  })

  it("answers ISO, not the runtime, for the codes the runtimes disagree on", () => {
    expect(currencyDecimals("RSD")).toBe(2)
    expect(currencyDecimals("IQD")).toBe(3)
    expect(currencyDecimals("HUF")).toBe(2)
    expect(currencyDecimals("VND")).toBe(0)
    expect(currencyDecimals("UYW")).toBe(4)
    expect(currencyDecimals("YER")).toBe(2)
  })

  it("leaves out the codes whose minor unit is N.A.", () => {
    for (const code of ["XAU", "XAG", "XDR", "XTS", "XXX"]) {
      expect(Object.hasOwn(currencies, code)).toBe(false)
    }
    expect(CURRENCIES_PUBLISHED).toBe("2026-09-17")
  })

  it("still lets a code the table lacks fall back to Intl", () => {
    // The Italian lira is no longer in ISO 4217; Intl still knows it, with no decimals.
    expect(Object.hasOwn(currencies, "ITL")).toBe(false)
    expect(currencyDecimals("ITL")).toBe(0)
  })
})

describe("isCurrencyCode and currencyCode", () => {
  it("accepts ISO codes and refuses anything else", () => {
    expect(isCurrencyCode("EUR")).toBe(true)
    expect(isCurrencyCode("RSD")).toBe(true)
    for (const code of ["XYZ", "usd", "XAU", "EURO", "", "constructor", 978, null]) {
      expect([code, isCurrencyCode(code)]).toEqual([code, false])
    }
  })

  it("makes an arktype schema refuse XYZ", () => {
    const schema = type({ currency: currencyCode })
    expect(schema({ currency: "EUR" })).toEqual({ currency: "EUR" })
    expect(schema({ currency: "XYZ" })).toBeInstanceOf(type.errors)
  })
})

describe("currencyOptions", () => {
  it("lists every ISO code with its name, symbol, decimals and search aliases", () => {
    const options = currencyOptions("en")
    expect(options.length).toBe(165)
    expect(options.find((option) => option.code === "EUR")).toEqual({
      code: "EUR",
      name: "Euro",
      symbol: "€",
      decimals: 2,
      aliases: ["EUR", "€"],
    })
    expect(options.find((option) => option.code === "RSD")?.decimals).toBe(2)
  })

  it("names currencies in the display locale and keeps the English name as an alias", () => {
    const usd = currencyOptions("ru").find((option) => option.code === "USD")
    expect(usd?.name).toBe("доллар США")
    expect(usd?.aliases).toContain("US Dollar")
    expect(usd?.aliases).toContain("USD")
  })

  it("sorts by name in the display locale", () => {
    const names = currencyOptions("en").map((option) => option.name)
    const collator = new Intl.Collator("en")
    expect(names).toEqual([...names].sort(collator.compare))
  })

  it("adds a custom currency with its own decimals", () => {
    const options = currencyOptions("en", [{ code: "BTC", name: "Bitcoin", decimals: 8 }])
    expect(options.length).toBe(166)
    expect(options.find((option) => option.code === "BTC")).toEqual({
      code: "BTC",
      name: "Bitcoin",
      symbol: "BTC",
      decimals: 8,
      aliases: ["BTC"],
    })
  })

  it("refuses a custom currency that is ISO, repeated, unnamed, badly coded or past 8 decimals", () => {
    const bad = [
      [{ code: "EUR", name: "Euro", decimals: 2 }],
      [{ code: "BTC", name: "Bitcoin", decimals: 8 }, { code: "BTC", name: "Again", decimals: 8 }],
      [{ code: "BTC", name: " ", decimals: 8 }],
      [{ code: "btc", name: "Bitcoin", decimals: 8 }],
      [{ code: "BTC", name: "Bitcoin", decimals: 9 }],
      [{ code: "BTC", name: "Bitcoin", decimals: 1.5 }],
    ]
    for (const extra of bad) expect(() => currencyOptions("en", extra)).toThrow(RangeError)
    expect(currencyOptions("en", [{ code: "SHIB", name: "Shiba Inu", decimals: 0 }]).length)
      .toBe(166)
  })
})

describe("sumMoney", () => {
  it("adds amounts of one currency exactly", () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(sumMoney([], "USD")).toEqual({ ok: true, value: 0 })
    expect(sumMoney([{ amount: 1250, currency: "USD" }, { amount: -250, currency: "USD" }], "USD"))
      .toEqual({ ok: true, value: 1000 })
    // The running total passes the safe range and comes back: the exact total is still safe.
    const back = [max, 2, -2].map((amount) => ({ amount, currency: "USD" }))
    expect(sumMoney(back, "USD")).toEqual({ ok: true, value: max })
  })

  it("refuses a yen amount in a dollar sum", () => {
    const items = [{ amount: 1000, currency: "USD" }, { amount: 1000, currency: "JPY" }]
    expect(sumMoney(items, "USD")).toEqual({ ok: false, error: "mixed-currencies" })
  })

  it("refuses a total past Number.MAX_SAFE_INTEGER instead of rounding it", () => {
    const max = Number.MAX_SAFE_INTEGER
    const over = [{ amount: max, currency: "USD" }, { amount: 1, currency: "USD" }]
    expect(sumMoney(over, "USD")).toEqual({ ok: false, error: "unsafe-sum" })
    const under = [{ amount: -max, currency: "USD" }, { amount: -1, currency: "USD" }]
    expect(sumMoney(under, "USD")).toEqual({ ok: false, error: "unsafe-sum" })
  })
})

describe("allocate", () => {
  it("gives the leftover units to the largest remainders, earlier parts first on a tie", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(allocate(-1000, [1, 1, 1])).toEqual([-334, -333, -333])
    expect(allocate(100, [1, 2])).toEqual([33, 67])
    expect(allocate(5, [0, 1, 0])).toEqual([0, 5, 0])
    expect(allocate(0, [1, 1])).toEqual([0, 0])
  })

  it("returns parts that add up to the amount exactly, over random amounts and weights", () => {
    const random = seededRandom(815)
    const max = Number.MAX_SAFE_INTEGER
    for (let run = 0; run < 2000; run++) {
      const amount = Math.floor((random() * 2 - 1) * (run % 2 ? max : 100_000))
      const weights = Array.from(
        { length: 1 + Math.floor(random() * 7) },
        () => Math.floor(random() * 1000),
      )
      if (!weights.some((weight) => weight > 0)) weights[0] = 1
      const parts = allocate(amount, weights)
      expect(parts.length).toBe(weights.length)
      expect(parts.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(BigInt(amount))
      for (const [index, part] of parts.entries()) {
        const share = Number(amount) * weights[index] / weights.reduce((a, b) => a + b, 0)
        expect(Math.abs(part - share)).toBeLessThan(1 + Math.abs(share) * 1e-12)
      }
    }
  })

  it("refuses no weights, negative or fractional weights, and all-zero weights", () => {
    expect(() => allocate(100, [])).toThrow(/at least one weight/)
    expect(() => allocate(100, [-1, 2])).toThrow(/safe integer of zero or more/)
    expect(() => allocate(100, [0.5, 1])).toThrow(/safe integer of zero or more/)
    expect(() => allocate(100, [0, 0])).toThrow(/a weight above zero/)
    expect(() => allocate(1.5, [1])).toThrow(/safe integer, got 1.5/)
  })
})

/** An exchange rate dated and sourced like a real one, for the conversion tests. */
function rate(base: string, quote: string, value: string, date = "2026-11-03"): ExchangeRate {
  return { base, quote, rate: value, date, source: "ECB" }
}

describe("convertMoney", () => {
  it("converts EUR to VND by hand-worked numbers", () => {
    // €12.50 × 27,500.5 = 343,756.25 VND, which has no minor unit → 343,756.
    expect(convertMoney(1250, "EUR", "VND", rate("EUR", "VND", "27500.5")))
      .toEqual({ ok: true, value: 343756 })
  })

  it("uses the same rate from VND back to EUR", () => {
    // 343,756 VND ÷ 27,500.5 = €12.4999909… → 1,249.99909 cents → 1,250.
    expect(convertMoney(343756, "VND", "EUR", rate("EUR", "VND", "27500.5")))
      .toEqual({ ok: true, value: 1250 })
  })

  it("keeps every digit of a rate of 0.000012907", () => {
    // 1,000,000 VND × 0.000012907 = €12.907 → 1,290.7 cents → 1,291.
    expect(convertMoney(1_000_000, "VND", "EUR", rate("VND", "EUR", "0.000012907")))
      .toEqual({ ok: true, value: 1291 })
    // 77,479 VND × 0.000012907 = €1.000021553 → 100.0021553 cents → 100.
    expect(convertMoney(77479, "VND", "EUR", rate("VND", "EUR", "0.000012907")))
      .toEqual({ ok: true, value: 100 })
  })

  it("rounds half a unit away from zero, once", () => {
    const half = rate("USD", "EUR", "0.5")
    expect(convertMoney(1, "USD", "EUR", half)).toEqual({ ok: true, value: 1 })
    expect(convertMoney(-1, "USD", "EUR", half)).toEqual({ ok: true, value: -1 })
    expect(convertMoney(3, "USD", "EUR", half)).toEqual({ ok: true, value: 2 })
    expect(convertMoney(-3, "USD", "EUR", half)).toEqual({ ok: true, value: -2 })
  })

  it("returns no-rate for a missing rate instead of 0", () => {
    expect(convertMoney(1250, "EUR", "USD", undefined)).toEqual({ ok: false, error: "no-rate" })
    expect(convertMoney(1250, "EUR", "USD", null)).toEqual({ ok: false, error: "no-rate" })
  })

  it("returns wrong-pair for a rate between other currencies", () => {
    expect(convertMoney(1250, "EUR", "USD", rate("EUR", "VND", "27500.5")))
      .toEqual({ ok: false, error: "wrong-pair" })
  })

  it("returns unsafe for a result past Number.MAX_SAFE_INTEGER", () => {
    expect(convertMoney(Number.MAX_SAFE_INTEGER, "EUR", "VND", rate("EUR", "VND", "27500.5")))
      .toEqual({ ok: false, error: "unsafe" })
  })

  it("returns the amount itself for the same currency, with no rate needed", () => {
    expect(convertMoney(1250, "EUR", "EUR", undefined)).toEqual({ ok: true, value: 1250 })
  })

  it("takes the decimals of a coin the table lacks", () => {
    // 1 BTC in satoshis at $65,000.12 → 6,500,012 cents.
    const btc = rate("BTC", "USD", "65000.12")
    expect(convertMoney(100_000_000, "BTC", "USD", btc, { fromDecimals: 8 }))
      .toEqual({ ok: true, value: 6500012 })
  })

  it("refuses a malformed rate or date", () => {
    for (const value of ["", "0", "0.000", "-1", "1e5", "1,5", " 1", ".5", "1."]) {
      expect(() => convertMoney(1, "EUR", "USD", rate("EUR", "USD", value))).toThrow(RangeError)
    }
    expect(() => convertMoney(1, "EUR", "USD", rate("EUR", "USD", "1.1", "2026/11/03")))
      .toThrow(RangeError)
  })
})

describe("crossRate", () => {
  it("derives USD to VND from EUR to USD and EUR to VND, dated by the older rate", () => {
    const derived = crossRate(
      rate("EUR", "USD", "1.25", "2026-11-03"),
      rate("EUR", "VND", "30000", "2026-11-02"),
    )
    expect(derived).toEqual({
      ok: true,
      value: { base: "USD", quote: "VND", rate: "24000", date: "2026-11-02", source: "ECB" },
    })
  })

  it("takes either rate quoted the other way round and joins two sources", () => {
    const usdEur = { ...rate("USD", "EUR", "0.8"), source: "Fed" }
    const derived = crossRate(usdEur, rate("EUR", "VND", "30000"))
    expect(derived).toEqual({
      ok: true,
      value: { base: "USD", quote: "VND", rate: "24000", date: "2026-11-03", source: "Fed, ECB" },
    })
  })

  it("keeps 20 significant digits of a rate that does not end", () => {
    const derived = crossRate(rate("EUR", "USD", "3"), rate("EUR", "VND", "1"))
    expect(derived.ok && derived.value.rate).toBe("0.33333333333333333333")
    const back = crossRate(rate("EUR", "USD", "3"), rate("EUR", "VND", "2"))
    expect(back.ok && back.value.rate).toBe("0.66666666666666666667")
  })

  it("returns wrong-pair for rates that share no currency, or both", () => {
    expect(crossRate(rate("EUR", "USD", "1.1"), rate("GBP", "VND", "33000")))
      .toEqual({ ok: false, error: "wrong-pair" })
    expect(crossRate(rate("EUR", "USD", "1.1"), rate("USD", "EUR", "0.9")))
      .toEqual({ ok: false, error: "wrong-pair" })
  })
})

describe("signDisplay", () => {
  it("prints a plus on a positive amount where the locale puts the sign", () => {
    const sign = { signDisplay: "exceptZero" } as const
    expect(formatMoney(1200, "EUR", "en", sign)).toBe("+€12.00")
    expect(formatMoney(-1200, "EUR", "en", sign)).toBe("-€12.00")
    expect(formatMoney(0, "EUR", "en", sign)).toBe("€0.00")
    expect(formatMoney(1200, "EUR", "de", sign)).toBe("+12,00\u00a0€")
    expect(formatMoney(1_000_000, "USDT", "en", { ...sign, decimals: 6 })).toBe(
      "+USDT\u00a01.000000",
    )
    expect(formatMoney(1200, "EUR", "en")).toBe("€12.00")
  })
})

describe("parseAmount", () => {
  const german = { decimal: ",", group: "." } as const
  const english = { decimal: ".", group: "," } as const

  it("reads a German amount in parentheses as a negative number of cents", () => {
    expect(parseAmount("(1.234,56)", "EUR", german, { negatives: ["parentheses"] }))
      .toEqual({ ok: true, value: -123456 })
  })

  it("reads a leading minus, U+2212 and a trailing minus when allowed", () => {
    expect(parseAmount("-1,234.56", "USD", english)).toEqual({ ok: true, value: -123456 })
    expect(parseAmount("−7.40", "USD", english)).toEqual({ ok: true, value: -740 })
    expect(parseAmount("7.40-", "USD", english, { negatives: ["trailing-minus"] }))
      .toEqual({ ok: true, value: -740 })
    expect(parseAmount("+7.40", "USD", english)).toEqual({ ok: true, value: 740 })
  })

  it("refuses a negative written in a style not allowed", () => {
    expect(parseAmount("(7.40)", "USD", english)).toEqual({
      ok: false,
      error: { type: "invalid-characters" },
    })
    expect(parseAmount("7.40-", "USD", english).ok).toBe(false)
    expect(parseAmount("-7.40", "USD", english, { negatives: ["parentheses"] }).ok).toBe(false)
  })

  it("takes the decimals from the currency table", () => {
    expect(parseAmount("1.234", "KWD", { decimal: ".", group: "" }))
      .toEqual({ ok: true, value: 1234 })
    expect(parseAmount("1.234", "JPY", { decimal: ",", group: "." }))
      .toEqual({ ok: true, value: 1234 })
    expect(parseAmount("12.5", "BTC", { decimal: ".", group: "" }, { decimals: 8 }))
      .toEqual({ ok: true, value: 1_250_000_000 })
  })

  it("refuses extra fraction digits unless they are zeros", () => {
    expect(parseAmount("12.505", "USD", english)).toEqual({
      ok: false,
      error: { type: "too-many-decimals", maxDecimals: 2 },
    })
    expect(parseAmount("12.5000", "USD", english)).toEqual({ ok: true, value: 1250 })
  })

  it("refuses a grouping mark out of place or not in the format", () => {
    expect(parseAmount("12.50", "EUR", german).ok).toBe(false)
    expect(parseAmount("1,234.56", "USD", { decimal: ".", group: "" }).ok).toBe(false)
    expect(parseAmount("12,34", "USD", english).ok).toBe(false)
    expect(parseAmount("1.2.3", "USD", english).ok).toBe(false)
  })

  it("reads space and apostrophe groups and lakh grouping", () => {
    expect(parseAmount("1\u00a0234,56", "EUR", { decimal: ",", group: " " }))
      .toEqual({ ok: true, value: 123456 })
    expect(parseAmount("1\u2019234.56", "CHF", { decimal: ".", group: "'" }))
      .toEqual({ ok: true, value: 123456 })
    expect(parseAmount("12,34,567.00", "INR", english)).toEqual({ ok: true, value: 123456700 })
  })

  it("refuses empty text and an amount past the safe range", () => {
    expect(parseAmount(" ", "USD", english)).toEqual({ ok: false, error: { type: "empty" } })
    expect(parseAmount("()", "USD", english, { negatives: ["parentheses"] }))
      .toEqual({ ok: false, error: { type: "empty" } })
    expect(parseAmount("90071992547409.92", "USD", english))
      .toEqual({ ok: false, error: { type: "too-large" } })
  })

  it("reads a negative zero as zero", () => {
    expect(Object.is(unwrapAmount(parseAmount("-0.00", "USD", english)), 0)).toBe(true)
  })
})

function unwrapAmount(result: ReturnType<typeof parseAmount>): number {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

describe("detectNumberFormat", () => {
  it("returns only the German format for 1.234,56", () => {
    expect(detectNumberFormat(["-1.234,56", "3.100,00", "-7,40"]))
      .toEqual([{ decimal: ",", group: "." }])
  })

  it("returns every format that reads an ambiguous column", () => {
    expect(detectNumberFormat(["1.234"])).toEqual([
      { decimal: ".", group: "" },
      { decimal: ".", group: "," },
      { decimal: ".", group: " " },
      { decimal: ".", group: "'" },
      { decimal: ",", group: "." },
    ])
  })

  it("reads negatives in every style", () => {
    expect(detectNumberFormat(["(1,234.56)", "7.40-", "-3.00"]))
      .toEqual([{ decimal: ".", group: "," }])
  })

  it("returns nothing for a column of words or of blanks", () => {
    expect(detectNumberFormat(["12.00", "n/a"])).toEqual([])
    expect(detectNumberFormat(["", " "])).toEqual([])
  })

  it("hands out copies the caller may change", () => {
    const [first] = detectNumberFormat(["1"])
    first.group = ","
    expect(NUMBER_FORMATS[0]).toEqual({ decimal: ".", group: "" })
  })
})

describe("isDebitCreditPair", () => {
  it("is true when every row holds an amount in exactly one column", () => {
    expect(isDebitCreditPair(["12,00", "", "0,00"], ["", "3,50", "1.200,00"])).toBe(true)
  })

  it("is false when a row holds an amount in both columns or in neither", () => {
    expect(isDebitCreditPair(["12,00", "4,00"], ["", "3,50"])).toBe(false)
    expect(isDebitCreditPair(["12,00", ""], ["", ""])).toBe(false)
  })

  it("is false for an amount column beside an empty one", () => {
    expect(isDebitCreditPair(["12,00", "4,00"], ["", ""])).toBe(false)
  })

  it("is false when a column holds words", () => {
    expect(isDebitCreditPair(["12,00", "Coffee"], ["", "3,50"])).toBe(false)
  })

  it("is false for columns of different lengths or no rows", () => {
    expect(isDebitCreditPair(["12,00", ""], ["", "3,50", "9,00"])).toBe(false)
    expect(isDebitCreditPair([], [])).toBe(false)
  })
})
