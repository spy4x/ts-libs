/**
 * Money as a whole number in its currency's smallest unit — `1250` means `€12.50`, `12345` means
 * `¥12,345` because the yen has no minor unit, and `12345` means `12.345 KWD` because the Kuwaiti
 * dinar has three. {@link formatMoney} turns such a number into display text; {@link parseMoney}
 * turns typed text back into one.
 *
 * {@link parseMoney} never converts the typed text to a `number` and multiplies or divides it: it
 * walks the text's own digits and combines them with {@link BigInt}, so there is no floating-point
 * step for a rounding error to hide in. `parseFloat("1.005") * 100` is `100.49999999999999` — the
 * same representation error {@link https://jsr.io/@spy4x/platform/doc/universal~format-number/~/round | `round`}
 * exists to correct for *display*, which this module does not accept for *money*: a value with more
 * fraction digits than the currency allows is refused, never rounded, because rounding a typed
 * amount can move a cent that was never approved. {@link formatMoney} divides the integer amount by
 * a power of ten, which is safe for every integer this module accepts: the nearest `double` to
 * `amount / 10 ** decimals` is always within far less than half a unit of the last decimal place
 * for any `amount` inside `Number.MAX_SAFE_INTEGER`, so formatting it back to exactly `decimals`
 * fraction digits always reproduces the exact decimal value.
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
 * Format an amount in `currency`'s smallest unit as display text — `formatMoney(12345, "EUR")` is
 * `"€123.45"`, `formatMoney(12345, "JPY")` is `"¥12,345"`, `formatMoney(12345, "KWD")` is
 * `"KWD 12.345"`.
 *
 * `amount` must be a safe integer — see the module doc for why the division below cannot introduce
 * a rounding error for one. A non-integer or unsafe `amount` is a programming error, not a display
 * choice, so it throws rather than silently formatting the wrong number.
 */
export function formatMoney(amount: number, currency: string, locale = "en"): string {
  return moneyFormatter(currency, locale).format(
    safeAmount(amount) / 10 ** currencyDecimals(currency, locale),
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
  return moneyFormatter(currency, locale).formatToParts(
    safeAmount(amount) / 10 ** currencyDecimals(currency, locale),
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
  /** A character that is not a digit, the locale's sign, group mark or decimal mark. */
  | { type: "invalid-characters" }
  /** More fraction digits than the currency allows. Refused, never rounded. */
  | { type: "too-many-decimals"; maxDecimals: number }
  /** The smallest-unit amount would exceed `Number.MAX_SAFE_INTEGER`. */
  | { type: "too-large" }

/**
 * Parse text typed in `locale` into a whole number of `currency`'s smallest unit —
 * `parseMoney("12,5", "EUR", "de")` is `ok(1250)`, `parseMoney("1.234,56", "EUR", "de")` is
 * `ok(123456)`.
 *
 * Reads `locale`'s own group and decimal marks from `Intl.NumberFormat(...).formatToParts` rather
 * than assuming `.`/`,`, so a German `"12,5"` and an English `"12.5"` both parse as the same
 * currency amount when the caller passes the right `locale`. The digits are combined with
 * `BigInt`, never a `number` multiplication — see the module doc.
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
  const trimmed = text.trim()
  if (trimmed === "") return err({ type: "empty" })

  const { group, decimal } = localeMarks(locale)
  const decimals = currencyDecimals(currency, locale)

  let negative = false
  let rest = trimmed
  if (rest.startsWith("-")) {
    negative = true
    rest = rest.slice(1)
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1)
  }
  rest = group === "" ? rest : rest.split(group).join("")

  const decimalParts = rest.split(decimal)
  if (decimalParts.length > 2) return err({ type: "invalid-characters" })
  const [intPartRaw, fracPartRaw = ""] = decimalParts

  if (intPartRaw === "" && fracPartRaw === "") return err({ type: "empty" })
  if (!/^\d*$/.test(intPartRaw) || !/^\d*$/.test(fracPartRaw)) {
    return err({ type: "invalid-characters" })
  }
  if (fracPartRaw.length > decimals) {
    return err({ type: "too-many-decimals", maxDecimals: decimals })
  }

  const intPart = intPartRaw === "" ? "0" : intPartRaw
  const digits = intPart + fracPartRaw.padEnd(decimals, "0")
  const magnitude = BigInt(digits)
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return err({ type: "too-large" })

  return ok(Number(magnitude) * (negative ? -1 : 1))
}

/** `locale`'s own group and decimal marks, read off a real formatted number rather than assumed. */
function localeMarks(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 1 })
    .formatToParts(1234.5)
  return {
    group: parts.find((part) => part.type === "group")?.value ?? ",",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  }
}
