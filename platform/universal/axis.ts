/**
 * "Nice" axis scales for charts: a round step near a target tick count, and the tick values that
 * cover a range.
 *
 * Pure arithmetic, no DOM and no SVG — the caller decides how to draw the result.
 */

/**
 * Round a span up to a sensible tick step at roughly `target` ticks.
 *
 * **The exact contract, measured.** The snapped quantity is the *span's* significand, placed on the
 * `{1, 2, 5, 10} x 10^floor(log10(span))` grid, and the returned step is that grid value divided by
 * `target`:
 *
 * | `target` | returned step |
 * | --- | --- |
 * | `1` | the snapped span itself |
 * | `5` (the default) | snapped / 5 |
 * | `10` | snapped / 10 — the result's own significand stays on the `1, 2, 5` grid |
 * | `2`, `20` | snapped / `target`; **on the grid except when the snapped value is 5** (`niceStep(42, 2) === 25`) |
 * | any other | snapped / `target`, **no grid guarantee** (`niceStep(10, 4) === 2.5`, `niceStep(10, 7) === 1.4285714285714286`) |
 *
 * So **the `1/2/5` invariant holds only for `target` in `{1, 5, 10}` plus the powers of ten that
 * follow them.** This is source behaviour, preserved deliberately: the invariant is documented here as
 * conditional rather than claimed unconditionally, and `axis.test.ts` pins both the grid cases and the
 * counterexamples so the difference cannot be lost again. The textbook form — snap `span / target`
 * onto the grid — would change every chart's tick values, so it is a follow-up with a rendering diff
 * to review, not a change to make while porting.
 *
 * A non-positive or non-finite span returns `1` so a degenerate axis still has a step, and the result
 * is never `0` or negative.
 */
export function niceStep(span: number, target = 5): number {
  if (!Number.isFinite(span) || span <= 0) return 1
  if (!Number.isFinite(target) || target <= 0) throw new Error("niceStep: target must be positive")
  const exponent = Math.floor(Math.log10(span))
  const fraction = span / 10 ** exponent
  let niceFraction: number
  if (fraction < 1.5) niceFraction = 1
  else if (fraction < 3) niceFraction = 2
  else if (fraction < 7) niceFraction = 5
  else niceFraction = 10
  const raw = (niceFraction * 10 ** exponent) / target
  return Math.max(1e-9, raw)
}

/**
 * Tick values covering `[min, max]`, expanded outward to the next nice step.
 *
 * When `min === max` a single-element array is returned, so a caller can render a degenerate
 * axis without dividing by zero. Every returned value is rounded to 8 decimal places to keep
 * float accumulation out of the labels.
 */
export function ticks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("ticks: min and max must be finite")
  }
  if (max === min) return [min]
  const step = niceStep(max - min, maxTicks)
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const out: number[] = []
  for (let value = start; value <= end + step / 2; value += step) {
    if (value >= min - step / 2 && value <= max + step / 2) {
      out.push(Number(value.toFixed(8)))
    }
  }
  return out
}
