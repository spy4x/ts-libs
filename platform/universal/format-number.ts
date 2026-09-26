/**
 * Number formatting for display.
 *
 * {@link round} replaces the source's `Math.round(value * factor) / factor`, which is wrong for any
 * value whose decimal digits are not exactly representable in binary: `round(1.005)` returned `1`
 * because `1.005 * 100` is `100.49999999999999` in IEEE 754. Rounding through the number's own
 * decimal representation (the same approach the platform spec takes) removes the class of bug.
 *
 * @module
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
  const shifted = shiftDecimal(value, decimals)
  if (!Number.isFinite(shifted)) return value
  // A literal `Math.round(x * factor) / factor` re-introduces the representation error for a
  // negative exponent, so the division is done on the decimal string too.
  return shiftDecimal(Math.round(shifted), -decimals)
}

/**
 * `value * 10^places`, computed on the decimal string so no binary multiplication error creeps in.
 *
 * JavaScript prints a number below 1e-6 or from 1e21 up in exponent form (`1.234e-7`), so the
 * places are added to that exponent rather than appended as a second one: `"1.234e-7e2"` is `NaN`.
 */
function shiftDecimal(value: number, places: number): number {
  const [mantissa, exponent = "0"] = String(value).split(/e/i)
  return Number(`${mantissa}e${Number(exponent) + places}`)
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

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const

/**
 * A byte count for display, in binary (1024) steps: `"512 B"`, `"1.5 KB"`, `"2 MB"`.
 *
 * Below 1024 the count is shown as whole bytes. Above it the value is rounded to one decimal with
 * {@link round}, and a whole result drops its decimal. The unit is chosen *after* rounding, so a
 * value that rounds up to 1024 of one unit is shown as 1 of the next: `1024 * 1024 - 1` is `"1 MB"`,
 * not `"1024 KB"`. `TB` is the largest unit; anything bigger is shown as that many terabytes.
 *
 * @param bytes A non-negative byte count, e.g. a `File`'s `size`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unitIndex = 0
  while (round(value, 1) >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  const rounded = round(value, 1)
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${
    BYTE_UNITS[unitIndex]
  }`
}
