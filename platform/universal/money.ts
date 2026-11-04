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

import { type Type, type } from "arktype"

import { currencies } from "./money-currencies.ts"
import { err, ok, type Result } from "./result.ts"

export { currencies, CURRENCIES_PUBLISHED } from "./money-currencies.ts"

/**
 * Optional, additive overrides for {@link formatMoney}, {@link formatMoneyParts},
 * {@link parseMoney} and {@link currencyDecimals}.
 *
 * `Intl` only knows ISO 4217: it rejects a code such as `USDT` and gives `BTC` two decimals. A
 * caller that holds such an asset states its decimals here instead.
 */
export interface MoneyOptions {
  /**
   * How many fraction digits the smallest unit has — `6` for `USDT`, `8` for `BTC`. A whole number
   * from 0 to 20. When omitted, the ISO 4217 table ({@link currencies}) decides, and `Intl` only
   * for a code the table lacks.
   */
  decimals?: number
  /**
   * Whether a positive amount gets a `+`, passed to `Intl.NumberFormat`: `"exceptZero"` prints
   * `"+€12.00"` for `1200` in `en`, with the sign where the locale puts it, and no sign on zero.
   * `"auto"`, the default, signs only negative amounts. Read by {@link formatMoney} and
   * {@link formatMoneyParts}.
   */
  signDisplay?: `auto` | `exceptZero`
}

function checkedDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) {
    throw new Error(`money decimals must be a whole number from 0 to 20, got ${decimals}`)
  }
  return decimals
}

/**
 * Refuse a blank currency code with the same `RangeError` `Intl.NumberFormat` throws for it. Without
 * this, a caller-given `decimals` skips `Intl`'s own check, and `formatMoney(1, "", "en", {
 * decimals: 2 })` printed `" 0.01"` — a number with a stray space where the currency should be.
 */
function checkedCurrency(currency: string): string {
  if (currency.trim() === "") {
    throw new RangeError(`money currency code must not be empty, got ${JSON.stringify(currency)}`)
  }
  return currency
}

/**
 * How many fraction digits `currency` uses, in `locale`'s own currency display rules.
 *
 * Never assume two: the yen (`JPY`) has none, the Kuwaiti dinar (`KWD`) has three. An ISO 4217
 * code reads the checked-in table ({@link currencies}), so Deno, Node and Bun give the same answer:
 * their `Intl` data disagree on 17 codes (`RSD` is 0 on Deno and 2 on Node; ISO says 2). Only a
 * code the table lacks asks `Intl`, so a code this module has never seen still works.
 *
 * An empty or whitespace-only `currency` throws a `RangeError`, with or without `options.decimals`,
 * and so does every other helper here that takes a code.
 */
export function currencyDecimals(
  currency: string,
  locale = "en",
  options: MoneyOptions = {},
): number {
  checkedCurrency(currency)
  if (options.decimals !== undefined) return checkedDecimals(options.decimals)
  if (Object.hasOwn(currencies, currency)) return currencies[currency]
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
 * format — `moneyDecimalString(12345, 2)` is `"123.45"`, `moneyDecimalString(-500, 0)` is `"-500"`,
 * `moneyDecimalString(0, 2)` is `"0.00"`, `moneyDecimalString(0, 0)` is `"0"` — a zero amount gets
 * `decimals` zero digits after the point, same as any other amount, never a bare `"0"` for a
 * currency that has decimals. Built with `BigInt` digit slicing rather than `amount / 10 ** decimals`,
 * which is not exact for every safe integer — see the module doc. `-0` (and any amount whose
 * magnitude is exactly `0`) normalises to a positive zero string, never a leading `"-"`: a `double`
 * cannot carry a meaningful negative zero here, and a displayed `"-€0.00"` for an amount that is
 * actually zero is a bug, not a sign a caller asked for.
 *
 * `amount` must already be a safe integer — throws otherwise, the same as {@link formatMoney}.
 */
export function moneyDecimalString(amount: number, decimals: number): string {
  const safe = safeAmount(amount)
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
 *
 * `options.decimals` gives the decimals of an asset `Intl` does not know: `formatMoney(1500000,
 * "USDT", "en", { decimals: 6 })` is `"USDT 1.500000"`, and `formatMoney(1, "BTC", "en", {
 * decimals: 8 })` is `"BTC 0.00000001"`. A code `Intl` rejects is printed as given, in the
 * position the locale gives a currency symbol.
 */
export function formatMoney(
  amount: number,
  currency: string,
  locale = "en",
  options: MoneyOptions = {},
): string {
  return formatMoneyParts(amount, currency, locale, options).map((part) => part.value).join("")
}

/**
 * {@link formatMoney}'s output as `Intl.NumberFormatPart`s, for a caller that renders the currency
 * symbol, the grouped digits and the sign as separate pieces instead of one string.
 */
export function formatMoneyParts(
  amount: number,
  currency: string,
  locale = "en",
  options: MoneyOptions = {},
): Intl.NumberFormatPart[] {
  const decimals = currencyDecimals(currency, locale, options)
  const digits = moneyDecimalString(amount, decimals) as unknown as number
  const { signDisplay } = options
  const formatter = moneyFormatter(currency, locale, decimals, signDisplay)
  if (formatter) return formatter.formatToParts(digits)
  // `Intl` rejects the code (`USDT`). Format with the placeholder code `XXX`, so the locale still
  // decides where the currency goes, then print the caller's code in its place.
  // `XXX` is always a valid code, so a throw here is the locale's own error: let it reach the caller.
  const placeholder = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "XXX",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay,
  })
  return placeholder.formatToParts(digits).map((part) =>
    part.type === "currency" ? { type: part.type, value: currency } : part
  )
}

/** The formatter, or `undefined` when `Intl` refuses `currency` as a code. */
function moneyFormatter(
  currency: string,
  locale: string,
  decimals: number,
  signDisplay: MoneyOptions[`signDisplay`],
): Intl.NumberFormat | undefined {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay,
    })
  } catch {
    return undefined
  }
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
  options: MoneyOptions = {},
): Result<number, ParseMoneyError> {
  // Checked before the text, so a blank code is a programming error even for blank text.
  checkedCurrency(currency)
  const cleaned = text.replace(DIRECTION_MARKS, "").trim()
  if (cleaned === "") return err({ type: "empty" })

  const digits = digitMap(locale)
  const normalized = toAsciiDigits(cleaned, digits)

  const { group, decimal, minus } = localeMarks(locale)
  const decimals = currencyDecimals(currency, locale, options)

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

/**
 * How a column writes its numbers: the decimal mark, and the grouping mark (`""` for none). A `" "`
 * group also accepts the other space-shaped marks (no-break space, narrow no-break space) and a
 * `"'"` group the other apostrophes, as {@link parseMoney} does.
 */
export interface NumberFormatGuess {
  /** The mark before the fraction: `"."` in `1,234.56`, `","` in `1.234,56`. */
  decimal: `.` | `,`
  /** The mark between thousands: `","` in `1,234.56`, `""` when the column has none. */
  group: `` | `,` | `.` | ` ` | `'`
}

/** Every format {@link detectNumberFormat} tries, in the order it lists them. */
export const NUMBER_FORMATS: readonly Readonly<NumberFormatGuess>[] = Object.freeze([
  { decimal: `.`, group: `` },
  { decimal: `.`, group: `,` },
  { decimal: `.`, group: ` ` },
  { decimal: `.`, group: `'` },
  { decimal: `,`, group: `` },
  { decimal: `,`, group: `.` },
  { decimal: `,`, group: ` ` },
].map((format) => Object.freeze(format as NumberFormatGuess)))

/** Every way a negative amount can be written, in the order {@link NegativeStyle} lists them. */
export const NEGATIVE_STYLES = Object.freeze([`minus`, `parentheses`, `trailing-minus`] as const)

/** How a negative amount is written: `-12.50`, `(12.50)` or `12.50-`. */
export type NegativeStyle = typeof NEGATIVE_STYLES[number]

/** Optional settings for {@link parseAmount}. */
export interface ParseAmountOptions {
  /** Which ways of writing a negative amount to accept. Default `["minus"]`. */
  negatives?: readonly NegativeStyle[]
  /** The currency's decimals, for a code ISO 4217 lacks; as in {@link MoneyOptions}. */
  decimals?: number
}

/** `-` and U+2212 MINUS SIGN, both read as a minus. */
const MINUS_SIGNS = [`-`, `−`]

/** A grouped integer part, groups shown as `,`: thousands (`1,234,567`) or lakhs (`12,34,567`). */
const GROUPED_INTEGER = /^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/

/** The parts of a number {@link readNumber} found, as digit strings. */
interface NumberParts {
  negative: boolean
  integer: string
  fraction: string
}

/**
 * Split `text` into its sign, integer digits and fraction digits as written in `format`, or say why
 * it is not a number written that way. A grouping mark must sit where thousands (or lakhs) put it.
 */
function readNumber(
  text: string,
  format: NumberFormatGuess,
  negatives: readonly NegativeStyle[],
): Result<NumberParts, ParseMoneyError> {
  let rest = text.replace(DIRECTION_MARKS, ``).trim()
  if (rest === ``) return err({ type: `empty` })
  let negative = false
  const sign = (style: NegativeStyle, stripped: string): boolean => {
    if (!negatives.includes(style)) return false
    negative = true
    rest = stripped.trim()
    return true
  }
  if (rest.startsWith(`(`) && rest.endsWith(`)`)) {
    if (!sign(`parentheses`, rest.slice(1, -1))) return err({ type: `invalid-characters` })
  } else if (MINUS_SIGNS.some((minus) => rest.startsWith(minus))) {
    if (!sign(`minus`, rest.slice(1))) return err({ type: `invalid-characters` })
  } else if (MINUS_SIGNS.some((minus) => rest.endsWith(minus))) {
    if (!sign(`trailing-minus`, rest.slice(0, -1))) return err({ type: `invalid-characters` })
  } else if (rest.startsWith(`+`)) {
    rest = rest.slice(1).trim()
  }

  const parts = rest.split(format.decimal)
  if (parts.length > 2) return err({ type: `invalid-characters` })
  const [integerRaw, fraction = ``] = parts
  if (integerRaw === `` && fraction === ``) return err({ type: `empty` })
  if (!/^\d*$/.test(fraction)) return err({ type: `invalid-characters` })

  const groupChars = groupEquivalents(format.group)
  let integer = ``
  let canonical = ``
  for (const char of integerRaw) {
    if (/\d/.test(char)) {
      integer += char
      canonical += char
    } else if (groupChars.has(char)) {
      canonical += `,`
    } else {
      return err({ type: `invalid-characters` })
    }
  }
  if (canonical !== integer && !GROUPED_INTEGER.test(canonical)) {
    return err({ type: `invalid-characters` })
  }
  return ok({ negative, integer, fraction })
}

/**
 * Read an amount from a file column written in `format` as a whole number of `currency`'s smallest
 * unit, like {@link parseMoney} does for typed text: `parseAmount("(1.234,56)", "EUR", { decimal:
 * ",", group: "." }, { negatives: ["parentheses"] })` is `ok(-123456)`.
 *
 * The currency's decimals come from the ISO 4217 table ({@link currencyDecimals}). More fraction
 * digits than it has are refused unless every extra digit is `0` (`12.5000` is €12.50 exactly);
 * nothing is ever rounded. A negative written in a style `options.negatives` does not list is
 * refused; the default accepts only a leading minus.
 */
export function parseAmount(
  text: string,
  currency: string,
  format: NumberFormatGuess,
  options: ParseAmountOptions = {},
): Result<number, ParseMoneyError> {
  checkedCurrency(currency)
  const decimals = currencyDecimals(currency, `en`, { decimals: options.decimals })
  const read = readNumber(text, format, options.negatives ?? [`minus`])
  if (!read.ok) return read
  const { negative, integer } = read.value
  let { fraction } = read.value
  if (fraction.length > decimals) {
    if (/[^0]/.test(fraction.slice(decimals))) {
      return err({ type: `too-many-decimals`, maxDecimals: decimals })
    }
    fraction = fraction.slice(0, decimals)
  }
  const magnitude = BigInt((integer || `0`) + fraction.padEnd(decimals, `0`))
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return err({ type: `too-large` })
  if (magnitude === 0n) return ok(0)
  return ok(Number(magnitude) * (negative ? -1 : 1))
}

/**
 * Every format in {@link NUMBER_FORMATS} that reads all `samples` as numbers, negatives in any
 * {@link NegativeStyle} included. More than one means the column is ambiguous and a person picks:
 * `["1.234"]` reads as 1.234 with a `.` decimal and as 1234 with a `.` group. Blank samples are
 * skipped; with none left the answer is empty, since nothing was seen.
 */
export function detectNumberFormat(samples: readonly string[]): NumberFormatGuess[] {
  const filled = samples.filter((sample) => sample.trim() !== ``)
  if (filled.length === 0) return []
  return NUMBER_FORMATS
    .filter((format) => filled.every((sample) => readNumber(sample, format, NEGATIVE_STYLES).ok))
    .map((format) => ({ ...format }))
}

/**
 * Whether two columns are a debit and a credit column: on every row exactly one of them holds an
 * amount, and the other is blank or zero (`0,00`). Both columns must hold an amount on some row,
 * since an amount column beside an empty one is not a pair, and a cell that is neither blank nor a
 * number in some {@link NUMBER_FORMATS} format makes the answer `false`. Columns of different
 * lengths, or no rows, are `false` too.
 */
export function isDebitCreditPair(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false
  let leftAmounts = 0
  let rightAmounts = 0
  for (let row = 0; row < left.length; row++) {
    const leftCell = cellAmount(left[row])
    const rightCell = cellAmount(right[row])
    if (leftCell === null || rightCell === null || leftCell === rightCell) return false
    if (leftCell) leftAmounts++
    else rightAmounts++
  }
  return leftAmounts > 0 && rightAmounts > 0
}

/** `true` for a non-zero amount, `false` for a blank or zero cell, `null` for anything else. */
function cellAmount(cell: string): boolean | null {
  if (cell.trim() === ``) return false
  for (const format of NUMBER_FORMATS) {
    const read = readNumber(cell, format, NEGATIVE_STYLES)
    if (read.ok) return /[1-9]/.test(read.value.integer + read.value.fraction)
  }
  return null
}

/**
 * Whether `code` is an ISO 4217 currency code in {@link currencies}: `"RSD"` is, `"XYZ"`, `"usd"`
 * and `"XAU"` (gold, which has no minor unit) are not. Asking whether `Intl.NumberFormat` throws is
 * no check, because it accepts any three letters.
 */
export function isCurrencyCode(code: unknown): code is string {
  return typeof code === `string` && Object.hasOwn(currencies, code)
}

/** A `string` that {@link isCurrencyCode} accepts, for an arktype schema. */
export const currencyCode: Type<string> = type(`string`).narrow((value, ctx) =>
  isCurrencyCode(value) || ctx.mustBe(`an ISO 4217 currency code like EUR`)
)

/**
 * A currency ISO 4217 does not list, such as a crypto coin, that a person adds to a picker. `code`
 * is 2 to 12 capital letters or digits and must not be an ISO code. `decimals` is a whole number
 * from 0 to 8: amounts stay plain safe integers, so a coin gets as many decimals as its price
 * needs, not as many as its chain uses.
 */
export interface CustomCurrency {
  code: string
  name: string
  decimals: number
}

/** One row of a currency picker, from {@link currencyOptions}. */
export interface CurrencyOption {
  code: string
  /** The name in the display locale: `"Euro"` in `en`, `"евро"` in `ru`. */
  name: string
  /** The symbol the display locale prints for it, as {@link formatMoney} does: `"€"`, `"CA$"`. */
  symbol: string
  decimals: number
  /**
   * More words a search should match: the code, the English name, and the symbol in its default
   * and narrow forms, without repeats and without `name` itself. Shaped for `searchEntries` in
   * `universal/text`, with `name` as the label.
   */
  aliases: string[]
}

const CUSTOM_CODE = /^[A-Z0-9]{2,12}$/
const MAX_CUSTOM_DECIMALS = 8

/**
 * Every ISO 4217 currency in {@link currencies} as a picker row, plus `extra`, sorted by name in
 * `displayLocale`. Names and symbols come from `Intl`, because they are display, not stored data;
 * decimals come from the table, or from the custom currency.
 *
 * @throws {RangeError} When a custom currency has a code that is not 2 to 12 capital letters or
 * digits, an ISO code, a code given twice, a blank name, or decimals that are not 0 to 8.
 */
export function currencyOptions(
  displayLocale: string,
  extra: readonly CustomCurrency[] = [],
): CurrencyOption[] {
  const names = new Intl.DisplayNames(displayLocale, { type: `currency` })
  const englishNames = new Intl.DisplayNames(`en`, { type: `currency` })
  const rows = Object.entries(currencies).map(([code, decimals]): CurrencyOption => {
    const name = names.of(code) ?? code
    const symbol = currencySymbol(code, displayLocale, `symbol`)
    const narrow = currencySymbol(code, displayLocale, `narrowSymbol`)
    const aliases = [code, englishNames.of(code) ?? code, symbol, narrow]
    return { code, name, symbol, decimals, aliases: distinctAliases(aliases, name) }
  })
  const seen = new Set<string>()
  for (const custom of extra) {
    const { code, name, decimals } = custom
    if (!CUSTOM_CODE.test(code)) {
      throw new RangeError(
        `a custom currency code is 2 to 12 capital letters or digits, got ${code}`,
      )
    }
    if (isCurrencyCode(code)) throw new RangeError(`${code} is an ISO 4217 code, not a custom one`)
    if (seen.has(code)) throw new RangeError(`custom currency ${code} is given twice`)
    if (name.trim() === ``) throw new RangeError(`custom currency ${code} needs a name`)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_CUSTOM_DECIMALS) {
      throw new RangeError(`custom currency decimals must be 0 to 8, got ${decimals} for ${code}`)
    }
    seen.add(code)
    rows.push({ code, name, symbol: code, decimals, aliases: distinctAliases([code], name) })
  }
  const collator = new Intl.Collator(displayLocale)
  return rows.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.code, b.code))
}

function currencySymbol(code: string, locale: string, display: `symbol` | `narrowSymbol`): string {
  return new Intl.NumberFormat(locale, {
    style: `currency`,
    currency: code,
    currencyDisplay: display,
  })
    .formatToParts(0).find((part) => part.type === `currency`)?.value ?? code
}

function distinctAliases(aliases: string[], name: string): string[] {
  return [...new Set(aliases)].filter((alias) => alias !== name)
}

/** An amount in `currency`'s smallest unit: `{ amount: 1250, currency: "EUR" }` is €12.50. */
export interface Money {
  amount: number
  currency: string
}

/**
 * Why {@link sumMoney} gave no total: an item in another currency, or a total past
 * `Number.MAX_SAFE_INTEGER` (either sign), which a `number` could no longer hold exactly.
 */
export type SumMoneyError = `mixed-currencies` | `unsafe-sum`

/**
 * The total of `items`, all in `currency`. Yen in a dollar sum is `err("mixed-currencies")`, never
 * a number: convert first. The sum is exact, and a total past `Number.MAX_SAFE_INTEGER` is
 * `err("unsafe-sum")` instead of a silently rounded number. An empty list sums to `0`.
 *
 * @throws {Error} When an item's amount is not a safe integer, a programming error.
 */
export function sumMoney(items: readonly Money[], currency: string): Result<number, SumMoneyError> {
  checkedCurrency(currency)
  let total = 0n
  for (const item of items) {
    if (item.currency !== currency) return err(`mixed-currencies`)
    total += BigInt(safeAmount(item.amount))
  }
  return isSafeBigInt(total) ? ok(Number(total)) : err(`unsafe-sum`)
}

/**
 * Split `amount` into parts proportional to `weights`, by largest remainder: each part is its
 * share rounded down, then the units left over go one each to the parts with the largest
 * remainders, ties to the earlier part. The parts always add up to `amount` exactly.
 * `allocate(1000, [1, 1, 1])` is `[334, 333, 333]`; a negative amount splits the same way with
 * every part negated, so `allocate(-1000, [1, 1, 1])` is `[-334, -333, -333]`.
 *
 * @throws {RangeError} When `amount` is not a safe integer, `weights` is empty, a weight is not a
 * safe integer of zero or more, or every weight is zero.
 */
export function allocate(amount: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`money amount must be a safe integer, got ${amount}`)
  }
  if (weights.length === 0) throw new RangeError(`allocate needs at least one weight`)
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError(`a weight must be a safe integer of zero or more, got ${weight}`)
    }
  }
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n)
  if (total === 0n) throw new RangeError(`allocate needs a weight above zero`)
  const magnitude = BigInt(Math.abs(amount))
  const parts = weights.map((weight) => magnitude * BigInt(weight) / total)
  const remainders = weights.map((weight) => magnitude * BigInt(weight) % total)
  let left = magnitude - parts.reduce((sum, part) => sum + part, 0n)
  const order = weights.map((_, index) => index).sort((a, b) =>
    remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1
  )
  for (let k = 0; left > 0n; k++, left--) parts[order[k]]++
  return parts.map((part) => part === 0n ? 0 : Number(amount < 0 ? -part : part))
}

/**
 * One `base` buys `rate` of `quote`, as published by `source` for `date`. `rate` is a plain decimal
 * string such as `"27500.5"` or `"0.000012907"`, never a `number`, so no float step touches it.
 * `date` is a calendar date, `YYYY-MM-DD`.
 */
export interface ExchangeRate {
  base: string
  quote: string
  rate: string
  date: string
  source: string
}

/**
 * Why {@link convertMoney} gave no amount: no rate at all, a rate for another pair of currencies,
 * or a result past `Number.MAX_SAFE_INTEGER`.
 */
export type ConvertError = `no-rate` | `wrong-pair` | `unsafe`

/**
 * The decimals of each side of {@link convertMoney}, for a currency the ISO table lacks (a crypto
 * coin), the same as `MoneyOptions.decimals`.
 */
export interface ConvertMoneyOptions {
  fromDecimals?: number
  toDecimals?: number
}

/**
 * `amount` in `from`'s smallest unit, converted to `to`'s smallest unit with `rate`, which may be
 * quoted either way round (`EUR`→`VND` also converts `VND` to `EUR`). The arithmetic is exact
 * (`BigInt`), and the result is rounded once at the end, half away from zero: half a cent becomes
 * one cent, minus half a cent becomes minus one. The same currency on both sides returns `amount`.
 *
 * A missing rate is `err("no-rate")`, never `0`; a rate for another pair is `err("wrong-pair")`; a
 * result past `Number.MAX_SAFE_INTEGER` is `err("unsafe")`.
 *
 * @throws {RangeError} When `amount` is not a safe integer, a code is blank, or `rate` is
 * malformed: a rate that is not a decimal string above zero, or a date that is not `YYYY-MM-DD`.
 */
export function convertMoney(
  amount: number,
  from: string,
  to: string,
  rate: ExchangeRate | null | undefined,
  options: ConvertMoneyOptions = {},
): Result<number, ConvertError> {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`money amount must be a safe integer, got ${amount}`)
  }
  const fromDecimals = currencyDecimals(from, `en`, { decimals: options.fromDecimals })
  const toDecimals = currencyDecimals(to, `en`, { decimals: options.toDecimals })
  if (from === to) return ok(amount)
  if (!rate) return err(`no-rate`)
  const [rateUnits, rateScale] = rateFraction(rate)
  let numerator = BigInt(amount) * 10n ** BigInt(toDecimals)
  let denominator = 10n ** BigInt(fromDecimals)
  if (rate.base === from && rate.quote === to) {
    numerator *= rateUnits
    denominator *= rateScale
  } else if (rate.base === to && rate.quote === from) {
    numerator *= rateScale
    denominator *= rateUnits
  } else {
    return err(`wrong-pair`)
  }
  const result = divideHalfAwayFromZero(numerator, denominator)
  return isSafeBigInt(result) ? ok(Number(result)) : err(`unsafe`)
}

/** Significant digits of a rate {@link crossRate} derives: past any safe amount's last unit. */
const CROSS_RATE_DIGITS = 20

/**
 * The rate between the two other currencies of two rates that share one: from `EUR`→`USD` and
 * `EUR`→`VND` it derives `USD`→`VND`, `left`'s other currency as the base and `right`'s as the
 * quote. Either rate may be quoted either way round. Its `date` is the older of the two, and its
 * `source` is the one source, or both joined by `", "`. The derived rate is rounded half away from
 * zero to 20 significant digits, far below a unit of any safe amount.
 *
 * Rates that share no currency, or both, are `err("wrong-pair")`.
 *
 * @throws {RangeError} When either rate is malformed, as in {@link convertMoney}.
 */
export function crossRate(
  left: ExchangeRate,
  right: ExchangeRate,
): Result<ExchangeRate, `wrong-pair`> {
  const [leftUnits, leftScale] = rateFraction(left)
  const [rightUnits, rightScale] = rateFraction(right)
  const shared = [left.base, left.quote].filter((code) =>
    code === right.base || code === right.quote
  )
  if (shared.length !== 1) return err(`wrong-pair`)
  const [common] = shared
  // Each side as "one `common` buys this much of the other currency", a fraction of two integers.
  const [aUnits, aScale] = left.base === common ? [leftUnits, leftScale] : [leftScale, leftUnits]
  const [bUnits, bScale] = right.base === common
    ? [rightUnits, rightScale]
    : [rightScale, rightUnits]
  return ok({
    base: left.base === common ? left.quote : left.base,
    quote: right.base === common ? right.quote : right.base,
    rate: significantDecimal(bUnits * aScale, bScale * aUnits, CROSS_RATE_DIGITS),
    date: left.date < right.date ? left.date : right.date,
    source: left.source === right.source ? left.source : `${left.source}, ${right.source}`,
  })
}

const RATE_PATTERN = /^(\d+)(?:\.(\d+))?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** `rate.rate` as the integer fraction `[units, scale]`, after checking the whole rate. */
function rateFraction(rate: ExchangeRate): [bigint, bigint] {
  checkedCurrency(rate.base)
  checkedCurrency(rate.quote)
  const match = RATE_PATTERN.exec(rate.rate)
  const units = match ? BigInt(match[1] + (match[2] ?? ``)) : 0n
  if (!match || units === 0n) {
    throw new RangeError(`an exchange rate is a decimal string above zero, got ${rate.rate}`)
  }
  if (!DATE_PATTERN.test(rate.date)) {
    throw new RangeError(`an exchange rate date is YYYY-MM-DD, got ${rate.date}`)
  }
  return [units, 10n ** BigInt(match[2]?.length ?? 0)]
}

function isSafeBigInt(value: bigint): boolean {
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  return value <= max && value >= -max
}

/** `numerator / denominator` rounded half away from zero; `denominator` is above zero. */
function divideHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const magnitude = numerator < 0n ? -numerator : numerator
  let quotient = magnitude / denominator
  if ((magnitude % denominator) * 2n >= denominator) quotient++
  return numerator < 0n ? -quotient : quotient
}

/**
 * The positive fraction `numerator / denominator` as a decimal string with at least `digits`
 * significant digits, rounded half away from zero, without trailing zeros: `(1n, 3n, 4)` is
 * `"0.3333"`.
 */
function significantDecimal(numerator: bigint, denominator: bigint, digits: number): string {
  const floor = 10n ** BigInt(digits - 1)
  let places = 0
  while (numerator * 10n ** BigInt(places) / denominator < floor) places++
  const scaled = divideHalfAwayFromZero(numerator * 10n ** BigInt(places), denominator)
  const text = scaled.toString().padStart(places + 1, `0`)
  const cut = text.length - places
  const fraction = text.slice(cut).replace(/0+$/, ``)
  return fraction === `` ? text.slice(0, cut) : `${text.slice(0, cut)}.${fraction}`
}
