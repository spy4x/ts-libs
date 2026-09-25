/**
 * "Nice" axis scales for charts: a round step near a target tick count, and the tick values that
 * cover a range.
 *
 * Pure arithmetic, no DOM and no SVG — the caller decides how to draw the result.
 *
 * @module
 */

/**
 * Hard ceiling on generated ticks, and on the iterations the tick loop may spend
 * producing them — see the doc of `ticksForStep` (the private loop behind {@link ticks} and
 * {@link stepAxis}) for why the loop needs its own bound, not just the
 * output's. Exported so `axis.test.ts` can assert against it instead of a repeated literal.
 */
export const MAX_TICKS = 1_000

/**
 * Coerce a tick target to a usable step count.
 *
 * Ported from `preact-components/charts/scales.ts`'s `normaliseTarget`, which this module lacked:
 * a target of `0`, a negative number, `NaN` or `undefined` used to throw here. A chart passes its
 * tick target from layout code (available width divided by a label's pixel width, say), and a
 * transient bad value there is exactly the kind of input a chart must render *something* for
 * rather than crash the whole component on. Falling back to the default of `5` matches what
 * happens when the caller supplies no target at all — a bad target is treated as no target — and a
 * caller that fixes its own layout math sees no difference, since the fallback and the default are
 * the same number.
 */
function normaliseTarget(target: number | undefined): number {
  return target !== undefined && Number.isFinite(target) && target >= 1 ? Math.floor(target) : 5
}

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
 * is never `0` or negative. A `target` that is not a finite number `>= 1` falls back to `5`, through
 * {@link normaliseTarget}, rather than throwing — see its own doc for why.
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
  const wanted = normaliseTarget(target)
  const exponent = Math.floor(Math.log10(span))
  const fraction = span / 10 ** exponent
  let niceFraction: number
  if (fraction < 1.5) niceFraction = 1
  else if (fraction < 3) niceFraction = 2
  else if (fraction < 7) niceFraction = 5
  else niceFraction = 10
  const step = (niceFraction * 10 ** exponent) / wanted
  if (Number.isFinite(step) && step > 0) return step
  // Subnormal spans underflow here (`10 ** exponent` itself rounds to 0); keep the smallest positive
  // step rather than returning 0, which would make tick generation divide by zero.
  const fallback = span / wanted
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Number.MIN_VALUE
}

/**
 * Tick values covering `[min, max]`, expanded outward to the next nice step.
 *
 * Reversed bounds are swapped rather than rejected — `ticks(10, 0)` equals `ticks(0, 10)` — so a
 * caller does not have to sort its own domain first; ported from
 * `preact-components/charts/scales.ts`, whose JSDoc calls the swap out as deliberate. When
 * `min === max` a single-element array is returned, so a caller can render a degenerate axis
 * without dividing by zero. Non-finite bounds return an empty axis rather than throwing — the same
 * "render something, not nothing" reasoning as {@link normaliseTarget}: a chart fed a bad domain
 * (an empty data set's `Infinity`/`-Infinity` extent, say) gets an axis with no ticks instead of an
 * exception that takes the rest of the render down with it.
 */
export function ticks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  const [low, high] = min <= max ? [min, max] : [max, min]
  if (low === high) return [low]
  return ticksForStep(low, high, niceStep(high - low, maxTicks))
}

/** Bounds rounded outward to multiples of a step, and the ticks between them. */
export interface StepAxis {
  /** Lower bound, rounded down to a multiple of the step. */
  min: number
  /** Upper bound, rounded up to a multiple of the step. */
  max: number
  /**
   * Tick values from `min` at the step, at most {@link MAX_TICKS} of them. The last one is `max`
   * unless that cap cut the list short.
   */
  ticks: number[]
}

/**
 * Round `[min, max]` outward to multiples of `step` and return the new bounds with the ticks between
 * them.
 *
 * Use it when the step is already chosen (by {@link niceStep}, say) and the axis must start and end
 * on a tick. The bounds and the ticks are rounded by the same rule, so `ticks[0]` is exactly `min`
 * and, unless the {@link MAX_TICKS} cap cuts the list short, the last tick is exactly `max`:
 * `stepAxis(0.35, 1.25, 0.1)` is `{ min: 0.3, max: 1.3, ticks: [0.3, 0.4, …, 1.3] }`, not a lower
 * bound of `0.30000000000000004`.
 * At most {@link MAX_TICKS} ticks are returned.
 *
 * Bad input degrades instead of throwing, like {@link ticks}:
 *
 * - a bound that is not a finite number returns the bounds as given with no ticks;
 * - reversed bounds are swapped;
 * - a step that is not a finite number above zero, or one so fine that rounding the bounds to it
 *   overflows, returns the bounds unchanged with `ticks: [min, max]`.
 */
export function stepAxis(min: number, max: number, step: number): StepAxis {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min, max, ticks: [] }
  const [low, high] = min <= max ? [min, max] : [max, min]
  if (!Number.isFinite(step) || step <= 0) return { min: low, max: high, ticks: [low, high] }
  const roundedLow = roundToStep(Math.floor(low / step) * step, step)
  const roundedHigh = roundToStep(Math.ceil(high / step) * step, step)
  if (!Number.isFinite(roundedLow) || !Number.isFinite(roundedHigh)) {
    return { min: low, max: high, ticks: [low, high] }
  }
  return { min: roundedLow, max: roundedHigh, ticks: ticksForStep(roundedLow, roundedHigh, step) }
}

/**
 * Tick values for `[low, high]` at a given step, limited to the bounds ± half a step. The callers
 * pass finite bounds with `low <= high` and a finite step above zero.
 *
 * A cursor walked by `value += step` never advances once `step` is finer than the float precision
 * of `low`/`high` — one ulp at `1e18` is `128`, so a nice step of `20` makes `value += step` a no-op
 * and a loop that read `value <= end + step / 2` ran forever. Walking by index
 * (`start + index * step`) always terminates: `index` is an ordinary incrementing integer, never a
 * float that can stop moving.
 *
 * Values are rounded relative to the step (see {@link roundToStep}) rather than to a fixed number of
 * decimals: rounding to a fixed 8 decimals collapsed every tick of a sub-nanosecond span to `0`
 * (`ticks(0, 1e-12)` returned a single `[0]`), and a fixed-decimal form cannot represent a step like
 * `2e-13` at all.
 *
 * **Bounded by `MAX_TICKS`, not just its output.** `steps` is `(end - start) / step`, and an absurd
 * tick target (`ticks(1_000_000, 2_000_000, 1e25)`, say) makes `step` many orders of magnitude
 * smaller than the float precision at `low`/`high`'s magnitude. Every rounded value then collapses
 * onto the same handful of doubles, so `out.length` almost stops growing while `index` keeps
 * climbing toward a `steps` that can itself be `1e25` — relying on `out.length < MAX_TICKS` alone
 * never terminates. Capping the loop itself at `Math.min(steps + 1, MAX_TICKS)` is the fix: return
 * whichever ticks distinguish themselves within `MAX_TICKS` iterations — as few as one, if the
 * target is absurd enough that nothing else is representable — rather than freeze the page. The
 * `index > MAX_TICKS` check below is a regression tripwire, not the fix itself: the ceiling already
 * makes it unreachable, so it exists purely so that weakening the ceiling back to plain `steps + 1`
 * fails `axis.test.ts` with a fast thrown error instead of hanging the whole suite.
 */
function ticksForStep(low: number, high: number, step: number): number[] {
  const start = Math.floor(low / step) * step
  const end = Math.ceil(high / step) * step
  const steps = Math.round((end - start) / step)
  if (!Number.isFinite(steps) || steps < 0) return [low, high]

  const out: number[] = []
  const iterationCeiling = Math.min(steps + 1, MAX_TICKS)
  for (let index = 0; index <= iterationCeiling && out.length < MAX_TICKS; index++) {
    if (index > MAX_TICKS) {
      throw new RangeError(`ticksForStep: exceeded MAX_TICKS (${MAX_TICKS}) iterations`)
    }
    const value = roundToStep(start + index * step, step)
    // Near the largest double, `start + index * step` overflows; Infinity is never a tick.
    if (!Number.isFinite(value)) break
    if (value < low - step / 2 || value > high + step / 2) continue
    if (out.length > 0 && out[out.length - 1] === value) continue
    out.push(value)
  }
  return out.length > 0 ? out : [low, high]
}

/**
 * Round `value` to as many decimals as `step` itself has: `0.1` keeps one, `2.5` keeps one, `0.25`
 * and `0.125` keep two and three, and a whole step such as `20` rounds to a whole number.
 *
 * The decimals come from `step`'s digits, read to 13 significant digits so float noise in the step
 * (`0.30000000000000004`) does not count. Taking them from the step's magnitude alone
 * (`-floor(log10(step))`) kept one decimal for `0.25` and none for `2.5`, so `ticks(0, 10, 4)`
 * returned `[0, 3, 5, 8, 10]` instead of `[0, 2.5, 5, 7.5, 10]`. A precision too fine to represent
 * leaves `value` as it is.
 */
function roundToStep(value: number, step: number): number {
  const decimals = stepDecimals(step)
  const factor = decimals > 0 ? 10 ** decimals : 1
  if (!Number.isFinite(factor)) return value
  const rounded = Math.round(value * factor) / factor
  return Number.isFinite(rounded) ? rounded : value
}

/** Decimal places `step` has, read to 13 significant digits; negative for a multiple of ten. */
function stepDecimals(step: number): number {
  const [significand, exponent] = step.toExponential(12).split("e")
  const fraction = (significand.split(".")[1] ?? "").replace(/0+$/, "")
  return fraction.length - Number(exponent)
}
