/**
 * "Nice" axis scales for charts: a round step near a target tick count, and the tick values that
 * cover a range.
 *
 * Pure arithmetic, no DOM and no SVG — the caller decides how to draw the result.
 */

/**
 * Hard ceiling on generated ticks. A safety net rather than a tested path: the index-driven loop
 * terminates on its own for every input the tests exercise.
 */
const MAX_TICKS = 1_000

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
 *
 * **No hard floor on the result.** An earlier revision clamped with `Math.max(1e-9, raw)`, which made
 * every span narrower than about `2e-9` round up to a step 1e-9 — coarser than the whole span, so
 * `ticks(0, 1e-12)` collapsed to a single `[0]` tick instead of six. The floor is gone; the only
 * remaining safety net is for a genuine underflow (`10 ** exponent` rounding to `0` for a subnormal
 * span), where the grid computation itself yields `0` or a non-finite value — ported from
 * `preact-components/charts/scales.ts`, which found and fixed the same loss of precision.
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
  const step = (niceFraction * 10 ** exponent) / target
  if (Number.isFinite(step) && step > 0) return step
  // Subnormal spans underflow here (`10 ** exponent` itself rounds to 0); keep the smallest positive
  // step rather than returning 0, which would make tick generation divide by zero.
  const fallback = span / target
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Number.MIN_VALUE
}

/**
 * Tick values covering `[min, max]`, expanded outward to the next nice step.
 *
 * Reversed bounds are swapped rather than rejected — `ticks(10, 0)` equals `ticks(0, 10)` — so a
 * caller does not have to sort its own domain first; ported from
 * `preact-components/charts/scales.ts`, whose JSDoc calls the swap out as deliberate. When
 * `min === max` a single-element array is returned, so a caller can render a degenerate axis
 * without dividing by zero.
 */
export function ticks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("ticks: min and max must be finite")
  }
  const [low, high] = min <= max ? [min, max] : [max, min]
  if (low === high) return [low]
  const step = niceStep(high - low, maxTicks)
  return ticksForStep(low, high, step)
}

/**
 * Tick values for `[low, high]` at a given step, limited to the bounds ± half a step.
 *
 * Ported from `preact-components/charts/scales.ts`, which diagnosed the failure this replaces: a
 * cursor walked by `value += step` never advances once `step` is finer than the float precision of
 * `low`/`high` — one ulp at `1e18` is `128`, so a nice step of `20` makes `value += step` a no-op and
 * the loop that read `value <= end + step / 2` ran forever. Walking by index
 * (`start + index * step`) always terminates: `index` is an ordinary incrementing integer, never a
 * float that can stop moving.
 *
 * Values are rounded relative to the step rather than to a fixed number of decimals: rounding to a
 * fixed 8 decimals collapsed every tick of a sub-nanosecond span to `0` (`ticks(0, 1e-12)` returned a
 * single `[0]`), and a fixed-decimal form cannot represent a step like `2e-13` at all.
 */
function ticksForStep(low: number, high: number, step: number): number[] {
  const start = Math.floor(low / step) * step
  const end = Math.ceil(high / step) * step
  const steps = Math.round((end - start) / step)
  if (!Number.isFinite(steps) || steps < 0) return [low, high]

  const out: number[] = []
  for (let index = 0; index <= steps + 1 && out.length < MAX_TICKS; index++) {
    const value = roundToStep(start + index * step, step)
    if (value < low - step / 2 || value > high + step / 2) continue
    if (out.length > 0 && out[out.length - 1] === value) continue
    out.push(value)
  }
  return out.length > 0 ? out : [low, high]
}

/** Round to the precision implied by `step`, keeping only exactly representable magnitudes. */
function roundToStep(value: number, step: number): number {
  const decimals = -Math.floor(Math.log10(step))
  const factor = decimals > 0 ? 10 ** decimals : 1
  if (!Number.isFinite(factor) || factor === 0) return value
  const rounded = Math.round(value * factor) / factor
  return Number.isFinite(rounded) ? rounded : value
}
