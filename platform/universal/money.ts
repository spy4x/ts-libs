/**
 * Money as a whole number in its currency's smallest unit — `1250` means `€12.50`, `12345` means
 * `¥12,345` because the yen has no minor unit, and `12345` means `12.345 KWD` because the Kuwaiti
 * dinar has three. {@link formatMoney} turns such a number into display text; {@link parseMoney}
 * turns typed text back into one.
 *
 * {@link parseMoney} never multiplies or divides the typed text as a `number`: it walks the text's
 * own digits and combines them with {@link BigInt}, so there is no floating-point step for a
 * rounding error to hide in. `parseFloat("1.005") * 100` is `100.49999999999999` — a value with
 * more fraction digits than the currency allows is refused, never rounded, because rounding a typed
 * amount can move a cent that was never approved. {@link formatMoney} builds the exact decimal
 * string with {@link moneyDecimalString} (also `BigInt`-based) and hands that string straight to
 * `Intl.NumberFormat`, rather than dividing `amount` by a power of ten first: `amount / 10 **
 * decimals` is a `double` division, and for an `amount` near `Number.MAX_SAFE_INTEGER` the nearest
 * representable `double` is not always the exact value — `9007199254740991` minor units in `USD`
 * divides to a `double` that prints `.90`, when the exact amount is `.91`. Building the decimal
 * string with integer arithmetic and letting `Intl.NumberFormat` parse the string itself (per the
 * ECMA-402 string-input behaviour) avoids that step entirely.
 *
 * `parseMoney` also has to read back exactly what a locale's own formatting prints, not just ASCII
 * digits and an ASCII `-`: `sv`, `fi`, `nb`, `lt` and `sl` print U+2212 MINUS SIGN for a negative
 * amount, not U+002D HYPHEN-MINUS, and `ar-EG`, `fa`, `bn` and `mr` print the locale's own digit
 * glyphs, not `0`–`9`. Both are read from `Intl` itself — see {@link digitMap} and
 * {@link localeMarks} — rather than assumed to be ASCII, and the bidi marks (U+200E, U+200F,
 * U+061C) some locales wrap the sign in are stripped before anything else runs.
 *
 * Grouping is validated, not merely stripped: `parseMoney` refuses a grouping mark that is not
 * exactly where `Intl` itself would place one for that locale, rather than deleting every
 * occurrence of the mark wherever it stands. Deleting unconditionally is the bug this module used
 * to have — `"12.50"` typed in a German field, where `.` is the *grouping* mark and `,` is the
 * decimal mark, silently became `€1,250.00` instead of being refused, because the `.` was stripped
 * as if it were always a thousands separator. See {@link groupedDigits} and the "Accept ungrouped,
 * or grouped exactly as Intl would" branch below.
 *
 * @module
 */

import { err, ok, type Result } from "./result.ts"

/**
 * How many fraction digits `currency` uses, in `locale`'s own currency display rules.
 *
 * Never assume two: the yen (`JPY`) has none, the Kuwaiti dinar (`KWD`) has three. This asks
 * `Intl` rather than hard-coding a table, so a currency this module has never seen still works.
 */
export function currencyDecimals(currency: string, locale = "en"): number {
  const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).resolvedOptions()
  // The spec guarantees this field for `style: "currency"` (ECMA-402 `Intl.NumberFormat` §5.5.10);
  // the type is `number | undefined` only because the same interface also covers plain-number and
  // percent formatting, where it can be unset. Thrown rather than defaulted to 2, so a runtime that
  // somehow disagrees with the spec fails loudly instead of silently assuming two decimals — the
  // one thing this module exists not to do.
  if (maximumFractionDigits === undefined) {
    throw new Error(`Intl reported no fraction-digit count for currency ${currency}`)
  }
  return maximumFractionDigits
}

/**
 * `amount`, in `currency`'s smallest unit, as the exact base-ten string `Intl.NumberFormat` should
 * format — `moneyDecimalString(12345, 2)` is `"123.45"`, `moneyDecimalString(-500, 0)` is `"-500"`.
 * Built with `BigInt` digit slicing rather than `amount / 10 ** decimals`, which is not exact for
 * every safe integer — see the module doc. `-0` (and any amount whose magnitude is exactly `0`)
 * normalises to `"0"`, never `"-0"`: a `double` cannot carry a meaningful negative zero here, and a
 * displayed `"-€0.00"` for an amount that is actually zero is a bug, not a sign a caller asked for.
 *
 * `amount` must already be a safe integer — throws otherwise, the same as {@link formatMoney}.
 */
export function moneyDecimalString(amount: number, decimals: number): string {
  const safe = safeAmount(amount)
  if (safe === 0) return "0"
  const negative = safe < 0
  const digits = BigInt(Math.abs(safe)).toString().padStart(decimals + 1, "0")
  const cut = digits.length - decimals
  const intPart = digits.slice(0, cut)
  const fracPart = decimals > 0 ? "." + digits.slice(cut) : ""
  return (negative ? "-" : "") + intPart + fracPart
}

/**
 * Format an amount in `currency`'s smallest unit as display text — `formatMoney(12345, "EUR")` is
 * `"€123.45"`, `formatMoney(12345, "JPY")` is `"¥12,345"`, `formatMoney(12345, "KWD")` is
 * `"KWD 12.345"`.
 *
 * `amount` must be a safe integer — a non-integer or unsafe `amount` is a programming error, not a
 * display choice, so it throws rather than silently formatting the wrong number.
 */
export function formatMoney(amount: number, currency: string, locale = "en"): string {
  const decimals = currencyDecimals(currency, locale)
  return moneyFormatter(currency, locale).format(
    moneyDecimalString(amount, decimals) as unknown as number,
  )
}

/**
 * {@link formatMoney}'s output as `Intl.NumberFormatPart`s, for a caller that renders the currency
 * symbol, the grouped digits and the sign as separate pieces instead of one string.
 */
export function formatMoneyParts(
  amount: number,
  currency: string,
  locale = "en",
): Intl.NumberFormatPart[] {
  const decimals = currencyDecimals(currency, locale)
  return moneyFormatter(currency, locale).formatToParts(
    moneyDecimalString(amount, decimals) as unknown as number,
  )
}

function moneyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const decimals = currencyDecimals(currency, locale)
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function safeAmount(amount: number): number {
  if (!Number.isInteger(amount) || !Number.isSafeInteger(amount)) {
    throw new Error(`money amount must be a safe integer, got ${amount}`)
  }
  return amount
}

/** Why {@link parseMoney} could not turn the typed text into a smallest-unit amount. */
export type ParseMoneyError =
  /** Nothing to parse: empty, or only a sign or a decimal mark. */
  | { type: "empty" }
  /**
   * A character that is not a digit, the locale's sign, decimal mark or its own grouping mark —
   * or a grouping mark present but not positioned the way `Intl` itself would place one.
   */
  | { type: "invalid-characters" }
  /** More fraction digits than the currency allows. Refused, never rounded. */
  | { type: "too-many-decimals"; maxDecimals: number }
  /** The smallest-unit amount would exceed `Number.MAX_SAFE_INTEGER`. */
  | { type: "too-large" }

/** U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK, U+061C ARABIC LETTER MARK. */
const DIRECTION_MARKS = /[‎‏؜]/g

/** Characters a person reasonably types for a space-shaped grouping mark, ASCII space included. */
const SPACE_GROUP_CHARS = new Set([" ", " ", " ", " "])

/** Characters a person reasonably types for an apostrophe-shaped grouping mark (`de-CH`). */
const APOSTROPHE_GROUP_CHARS = new Set(["'", "’", "ʼ"])

/**
 * Every character {@link parseMoney} accepts as `locale`'s own grouping mark. A plain ASCII space
 * or apostrophe is common enough on real keyboards that refusing it in favour of only the exact
 * codepoint `Intl` prints (U+202F for `fr`, U+2019 for `de-CH`) would refuse ordinary typing; every
 * other mark (`,`, `.`, the Arabic thousands mark, …) has no such look-alike problem and is matched
 * exactly.
 */
function groupEquivalents(groupMark: string): Set<string> {
  if (SPACE_GROUP_CHARS.has(groupMark)) return SPACE_GROUP_CHARS
  if (APOSTROPHE_GROUP_CHARS.has(groupMark)) return APOSTROPHE_GROUP_CHARS
  return new Set(groupMark === "" ? [] : [groupMark])
}

/**
 * Map from `locale`'s own digit glyph to the ASCII digit it means — `digitMap("fa").get("۱")` is
 * `"1"`. Built by formatting `0`–`9` themselves in `locale` with no grouping, rather than a
 * hard-coded numbering-system table, so a numbering system this module has never seen still works
 * as long as `Intl` renders each digit as one character.
 */
function digitMap(locale: string): Map<string, string> {
  const map = new Map<string, string>()
  for (let digit = 0; digit <= 9; digit++) {
    const glyph = new Intl.NumberFormat(locale, { useGrouping: false }).format(digit)
    if (glyph.length === 1) map.set(glyph, String(digit))
  }
  return map
}

/** `text` with every character `digits` maps mapped to its ASCII digit; anything else unchanged. */
function toAsciiDigits(text: string, digits: Map<string, string>): string {
  return Array.from(text).map((char) => digits.get(char) ?? char).join("")
}

/**
 * `magnitude`'s digits, grouped the way `Intl` would group them for `locale`, as ASCII digits with
 * a plain `,` standing in for whatever character `Intl` actually uses at each group boundary —
 * `groupedDigits(1234567n, "en-IN")` is `"12,34,567"` (lakh grouping), matching what
 * `Intl.NumberFormat("en-IN").format(1234567)` prints once its own digits and group mark are
 * normalised the same way {@link parseMoney} normalises what was typed. `magnitude` is a `BigInt`
 * so this stays exact for an integer part beyond `Number.MAX_SAFE_INTEGER`, the same way
 * {@link moneyDecimalString} does for the fraction side.
 */
function groupedDigits(magnitude: bigint, locale: string): string {
  const digits = digitMap(locale)
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(magnitude)
  return parts
    .filter((part) => part.type === "integer" || part.type === "group")
    .map((part) => part.type === "group" ? "," : toAsciiDigits(part.value, digits))
    .join("")
}

/**
 * Parse text typed in `locale` into a whole number of `currency`'s smallest unit —
 * `parseMoney("12,5", "EUR", "de")` is `ok(1250)`, `parseMoney("1.234,56", "EUR", "de")` is
 * `ok(123456)`.
 *
 * Reads `locale`'s own group, decimal and minus marks from `Intl.NumberFormat(...).formatToParts`
 * rather than assuming ASCII, and maps `locale`'s own digit glyphs to `0`–`9` the same way — see
 * the module doc. A grouping mark is accepted only where `Intl` itself would place one for the
 * digits typed (or not at all): `"12.50"` typed in `de`, where `.` is the grouping mark, is refused
 * rather than read as €1,250.00.
 *
 * Too many fraction digits for the currency (`"1.005"` for `USD`, which has two) is refused, not
 * rounded to `100` the way `Math.round(1.005 * 100)` would silently give `100.49999999999999` →
 * `100`: the caller decides what to do with a refusal, this module never guesses which cent the
 * typist meant.
 */
export function parseMoney(
  text: string,
  currency: string,
  locale = "en",
): Result<number, ParseMoneyError> {
  const cleaned = text.replace(DIRECTION_MARKS, "").trim()
  if (cleaned === "") return err({ type: "empty" })

  const digits = digitMap(locale)
  const normalized = toAsciiDigits(cleaned, digits)

  const { group, decimal, minus } = localeMarks(locale)
  const decimals = currencyDecimals(currency, locale)

  let negative = false
  let rest = normalized
  const matchedMinus = minus.find((sign) => rest.startsWith(sign))
  if (matchedMinus) {
    negative = true
    rest = rest.slice(matchedMinus.length)
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1)
  }

  const decimalParts = rest.split(decimal)
  if (decimalParts.length > 2) return err({ type: "invalid-characters" })
  const [intPartRaw, fracPartRaw = ""] = decimalParts

  if (intPartRaw === "" && fracPartRaw === "") return err({ type: "empty" })
  if (!/^\d*$/.test(fracPartRaw)) return err({ type: "invalid-characters" })

  // Walk the integer part once: every character is either an ASCII digit (kept) or a character
  // equivalent to `locale`'s own grouping mark (folded to a canonical `,`); anything else refuses
  // immediately, the same way a stray letter always has.
  const groupChars = groupEquivalents(group)
  let intDigitsOnly = ""
  let canonicalIntPart = ""
  for (const char of intPartRaw) {
    if (/\d/.test(char)) {
      intDigitsOnly += char
      canonicalIntPart += char
    } else if (groupChars.has(char)) {
      canonicalIntPart += ","
    } else {
      return err({ type: "invalid-characters" })
    }
  }
  if (intPartRaw !== "" && intDigitsOnly === "") return err({ type: "invalid-characters" })

  // Accept ungrouped, or grouped exactly as Intl would group these digits for this locale —
  // anything else (a grouping mark in the wrong place, or the wrong locale's grouping pattern) is
  // refused rather than silently stripped. This is the check that keeps a decimal mark typed in the
  // wrong locale (`"12.50"` in `de`) from being read as a thousands separator.
  if (canonicalIntPart.includes(",")) {
    const magnitude = intDigitsOnly === "" ? 0n : BigInt(intDigitsOnly)
    if (canonicalIntPart !== groupedDigits(magnitude, locale)) {
      return err({ type: "invalid-characters" })
    }
  }

  if (fracPartRaw.length > decimals) {
    return err({ type: "too-many-decimals", maxDecimals: decimals })
  }

  const intPart = intDigitsOnly === "" ? "0" : intDigitsOnly
  const combined = intPart + fracPartRaw.padEnd(decimals, "0")
  const magnitude = BigInt(combined)
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return err({ type: "too-large" })
  if (magnitude === 0n) return ok(0)

  return ok(Number(magnitude) * (negative ? -1 : 1))
}

/**
 * `locale`'s own group, decimal and minus marks, read off a real formatted negative number rather
 * than assumed. `minus` lists every sign `parseMoney` accepts as negative: the locale's own (`sv`,
 * `fi`, `nb`, `lt` and `sl` print U+2212 MINUS SIGN, not `-`), plus U+2212 itself and the plain
 * ASCII hyphen-minus unconditionally, since both are common enough to type regardless of locale.
 */
function localeMarks(locale: string): { group: string; decimal: string; minus: string[] } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 1 })
    .formatToParts(-1234.5)
  const group = parts.find((part) => part.type === "group")?.value ?? ","
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? "."
  const localeMinus = parts.find((part) => part.type === "minusSign")?.value ?? "-"
  return { group, decimal, minus: Array.from(new Set(["-", "−", localeMinus])) }
}
