/**
 * Number formatting for display.
 *
 * {@link round} replaces the source's `Math.round(value * factor) / factor`, which is wrong for any
 * value whose decimal digits are not exactly representable in binary: `round(1.005)` returned `1`
 * because `1.005 * 100` is `100.49999999999999` in IEEE 754. Rounding through the number's own
 * decimal representation (the same approach the platform spec takes) removes the class of bug.
 */

/**
 * Round to the nearest 10^-`decimals`.
 *
 * Halfway values are resolved by the *decimal* representation of `value`, which is what a reader
 * means by "round" — `round(1.005, 2)` is `1.01`, where `Math.round(1.005 * 100) / 100` is `1`.
 *
 * Known limitation, pinned by a test: a negative halfway value can still under-round, because the
 * binary value of e.g. `-1.005` sits slightly closer to zero than the decimal `-1.005`, so
 * `round(-1.005, 2)` is `-1` rather than `-1.01`. Correcting that needs an epsilon whose size is
 * magnitude-dependent, which trades a visible, testable limitation for an invisible one. Display
 * only — never use this for money or for a stored value.
 *
 * Non-finite input is passed through unchanged, so a caller can render it deliberately rather than
 * receive a `NaN` from a rounding call.
 */
export function round(value: number, decimals = 0): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value
  const shifted = Number(`${value}e${decimals}`)
  if (!Number.isFinite(shifted)) return value
  // A literal `Math.round(x * factor) / factor` re-introduces the representation error for a
  // negative exponent, so the division is done on the decimal string too.
  return Number(`${Math.round(shifted)}e${-decimals}`)
}

/**
 * Format a decimal number to exactly two decimal places. Example: `13.5` → `"13.50"`.
 *
 * Rounds through {@link round} first: `toFixed` alone rounds on the binary representation, so it
 * disagrees with `round` on exactly the values `round` exists to get right (`1.005.toFixed(2)` is
 * `"1.00"`).
 */
export function formatDecimal(value: number, decimals = 2): string {
  const rounded = round(value, decimals)
  if (!Number.isFinite(rounded)) return String(rounded)
  return rounded.toFixed(decimals)
}

/**
 * Format a fraction in `0..1` as a percentage string with two decimals.
 *
 * Rounds through {@link formatDecimal} for the same reason `formatDecimal` goes through
 * {@link round}: `(value * 100).toFixed(2)` rounds the binary representation, so it disagreed with
 * `round` on exactly the values `round` exists to get right — `formatPct(0.01005)` rendered `"1.00%"`
 * while `round(0.01005 * 100, 2)` is `1.01`.
 *
 * Non-finite input renders as `"0.00%"` rather than `"NaN%"`, so a chart label never breaks.
 */
export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "0.00%"
  return `${formatDecimal(value * 100)}%`
}
