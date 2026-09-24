/**
 * "Nice" axis scales for charts: a round step near a target tick count, and the tick values that
 * cover a range.
 *
 * Pure arithmetic, no DOM and no SVG — the caller decides how to draw the result.
 *
 * @module
 */

/**
 * Hard ceiling on generated ticks, and on the iterations {@link ticksForStep}'s loop may spend
 * producing them — see that function's doc for why the loop needs its own bound, not just the
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
  const step = niceStep(high - low, maxTicks)
  if (!Number.isFinite(step) || step <= 0) return [low, high]
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
 *
 * **Bounded by `MAX_TICKS`, not just its output.** `steps` is `(end - start) / step`, and an absurd
 * tick target (`ticks(1_000_000, 2_000_000, 1e25)`, say) makes `step` many orders of magnitude
 * smaller than the float precision at `low`/`high`'s magnitude. Every `roundToStep` result then
 * collapses onto the same handful of doubles, so `out.length` almost stops growing while `index`
 * keeps climbing toward a `steps` that can itself be `1e25` — relying on `out.length < MAX_TICKS`
 * alone never terminates. Capping the loop itself at `Math.min(steps + 1, MAX_TICKS)` is the fix:
 * the reference this module is ported from has the exact same defect (it does not return either;
 * `origin/main` before this module threw after ~12s on the same call instead of hanging), so there
 * is no reference behaviour to copy here. The choice is a chart's: return whichever ticks
 * distinguish themselves within `MAX_TICKS` iterations — as few as one, if the target is absurd
 * enough that nothing else is representable — rather than freeze the page. The `index > MAX_TICKS`
 * check below is a regression tripwire, not the fix itself: the ceiling already makes it
 * unreachable, so it exists purely so that weakening the ceiling back to plain `steps + 1` fails
 * `axis.test.ts` with a fast thrown error instead of hanging the whole suite.
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
