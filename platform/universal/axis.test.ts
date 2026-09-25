import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { MAX_TICKS, niceStep, roundToStep, ticks, ticksForStep } from "./axis.ts"

describe("niceStep", () => {
  it("snaps the significand to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(10, 5)).toBe(2)
    expect(niceStep(100, 5)).toBe(20)
    expect(niceStep(1, 5)).toBe(0.2)
  })

  const gridTargets = "keeps the significand on the 1/2/5 grid for target 1, 5, 10 and powers"
  it(gridTargets, () => {
    const onGrid = (step: number): boolean => {
      const significand = step / 10 ** Math.floor(Math.log10(step))
      return [1, 2, 5].some((candidate) => Math.abs(significand - candidate) < 1e-9)
    }
    for (const target of [1, 5, 10, 100, 50]) {
      for (const span of [1, 7, 10, 42, 100, 999, 1000, 123456]) {
        expect({ target, span, onGrid: onGrid(niceStep(span, target)) }).toEqual({
          target,
          span,
          onGrid: true,
        })
      }
    }
  })

  const gridException = "keeps the grid for target 2 except when the snapped span is 5"
  it(gridException, () => {
    expect(niceStep(100, 2)).toBe(50)
    expect(niceStep(999, 2)).toBe(500)
    // The documented exception: snapped 50 / 2 is 25, whose significand 2.5 is off the grid.
    expect(niceStep(42, 2)).toBe(25)
  })

  it("documents that targets outside 1/2/5 leave the grid, rather than claiming otherwise", () => {
    // Pinned so the conditional wording in the JSDoc stays honest.
    expect(niceStep(10, 4)).toBe(2.5)
    expect(niceStep(42, 4)).toBe(12.5)
    expect(niceStep(10, 7)).toBeCloseTo(1.4285714285714286, 12)
    expect(niceStep(1000, 7)).toBeCloseTo(142.85714285714286, 10)
  })

  it("divides the nice span by the target tick count", () => {
    // span 10 with 10 wanted ticks is 1 per tick.
    expect(niceStep(10, 10)).toBe(1)
    // Span 10 snaps to the 1-significand (10), divided by 4 wanted ticks.
    expect(niceStep(10, 4)).toBe(2.5)
  })

  const degenerateSpan = "returns 1 for a non-positive or non-finite span, so an axis has a step"
  it(degenerateSpan, () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-5)).toBe(1)
    expect(niceStep(Number.NaN)).toBe(1)
    expect(niceStep(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("never returns zero or a negative step", () => {
    expect(niceStep(1e-12, 5)).toBeGreaterThan(0)
  })

  it("falls back to the default target of 5 for a non-positive, non-finite or missing target", () => {
    // Matches the reference's normaliseTarget: a chart's tick target usually comes from its own
    // layout math (available width / label width), and a transient bad value there should degrade
    // to the default rather than take the whole render down.
    expect(niceStep(10, 0)).toBe(niceStep(10, 5))
    expect(niceStep(10, -1)).toBe(niceStep(10, 5))
    expect(niceStep(10, Number.NaN)).toBe(niceStep(10, 5))
    expect(niceStep(10)).toBe(niceStep(10, 5))
  })

  it("floors a fractional target instead of producing a fractional step count", () => {
    expect(niceStep(10, 4.9)).toBe(niceStep(10, 4))
  })

  it("returns a finite step above zero for a subnormal span", () => {
    // `10 ** exponent` underflows to 0 for these spans, so the grid computation alone yields a
    // zero step, and a zero step makes tick generation divide by zero. Ported from
    // preact-components' `charts/scales.test.ts` before spy4x/preact-components#287.
    for (const span of [Number.MIN_VALUE, 1e-320, 1e-310]) {
      const step = niceStep(span)
      expect({ span, positive: step > 0, finite: Number.isFinite(step) }).toEqual({
        span,
        positive: true,
        finite: true,
      })
    }
  })

  it("lands on five to eight ticks for every span from 1e-12 to 1e12", () => {
    // Ported from preact-components' `charts/scales.test.ts` before spy4x/preact-components#287.
    for (let exponent = -12; exponent <= 12; exponent++) {
      for (const multiplier of [1, 2.5, 7.5]) {
        const span = multiplier * 10 ** exponent
        const count = ticks(0, span, 5).length
        expect({ span, inRange: count >= 5 && count <= 8 }).toEqual({ span, inRange: true })
      }
    }
  })
})

describe("ticks", () => {
  it("expands outward to the next step, so the ends are covered", () => {
    const values = ticks(0, 100)
    expect(values[0]).toBeLessThanOrEqual(0)
    expect(values[values.length - 1]).toBeGreaterThanOrEqual(100)
    // 0..100 at a 20 step is exactly six ticks, not eight.
    expect(values).toEqual([0, 20, 40, 60, 80, 100])
  })

  it("returns a single tick for a degenerate range instead of dividing by zero", () => {
    expect(ticks(5, 5)).toEqual([5])
  })

  it("produces roughly the requested number of ticks", () => {
    expect(ticks(0, 100, 5).length).toBeGreaterThanOrEqual(3)
    expect(ticks(0, 100, 5).length).toBeLessThanOrEqual(12)
  })

  it("is monotonically increasing with no float accumulation noise", () => {
    const values = ticks(0.1, 0.9, 5)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
    for (const value of values) {
      expect(Number(value.toFixed(8))).toBe(value)
    }
  })

  it("handles a negative range", () => {
    const values = ticks(-50, 50, 5)
    expect(values[0]).toBeLessThanOrEqual(-50)
    expect(values[values.length - 1]).toBeGreaterThanOrEqual(50)
  })

  it("returns an empty axis for a non-finite bound instead of throwing", () => {
    // Matches the reference: a chart fed a bad domain (an empty series' Infinity/-Infinity extent,
    // for instance) gets an axis with no ticks, not an exception that takes the render down too.
    // Expected values taken from `preact-components/charts/scales.ts`.
    expect(ticks(0, Number.NaN)).toEqual([])
    expect(ticks(Number.POSITIVE_INFINITY, 1)).toEqual([])
    expect(ticks(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual([])
  })

  it("swaps reversed bounds instead of returning them as given", () => {
    // Before this fix `ticks(10, 0)` returned `[10, 0]` (a two-element descending pair that reads
    // as a valid axis) and, on origin/main before this PR, `[]`. The reference swaps unconditionally
    // and documents it as deliberate; expected values taken from running it.
    expect(ticks(10, 0)).toEqual(ticks(0, 10))
    expect(ticks(10, 0)).toEqual([0, 2, 4, 6, 8, 10])
    expect(ticks(1, -1)).toEqual([-1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2])
  })

  it("falls back to the default tick target instead of throwing on a bad one", () => {
    // Expected values taken from the reference: a bad `maxTicks` behaves as if it were omitted.
    expect(ticks(0, 100, 0)).toEqual(ticks(0, 100))
    expect(ticks(0, 100, -3)).toEqual(ticks(0, 100))
    expect(ticks(0, 100, Number.NaN)).toEqual(ticks(0, 100))
  })

  it("terminates on a span narrower than the float precision of its bounds, instead of looping forever", () => {
    // Before the fix, a cursor advanced by `value += step` never moved once the step (20) was
    // finer than one ulp at 1e18 (128), so the loop that read `value <= end + step / 2` never
    // returned. Expected values taken from `preact-components/charts/scales.ts`, the reference
    // this package is now the single home for (see `platform/universal/axis.ts`'s JSDoc).
    expect(ticks(1e18, 1e18 + 100)).toEqual([1e18, 1e18 + 100])
  })

  it("keeps a zero tick and whole steps across a span of 1e36", () => {
    // Ported from preact-components' `charts/scales.test.ts` before spy4x/preact-components#287.
    const values = ticks(-1e18, 1e18)
    expect(values.length).toBeGreaterThanOrEqual(5)
    expect(values.length).toBeLessThanOrEqual(8)
    expect(values).toContain(0)
    for (let i = 0; i < values.length; i++) {
      const quotient = values[i] / 4e17
      expect(Math.abs(quotient - Math.round(quotient))).toBeLessThan(1e-6)
      if (i > 0) expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })

  it("keeps six distinct ticks for a span far below one unit, instead of collapsing to a single 0", () => {
    // Before the fix, `niceStep` floored its result at 1e-9 — coarser than the whole 1e-12 span —
    // so every tick but the first rounded away and `ticks(0, 1e-12)` returned `[0]`. Expected
    // values taken from `preact-components/charts/scales.ts`.
    expect(ticks(0, 1e-12)).toEqual([0, 2e-13, 4e-13, 6e-13, 8e-13, 1e-12])
  })

  it("returns at once for an absurd tick target instead of looping without bound", () => {
    // Before the fix, `ticksForStep`'s loop ran `steps + 1` times (here `steps` is `1e25`) and
    // relied on `out.length < MAX_TICKS` alone to stop it; a step this many orders of magnitude
    // below the float precision at this range's magnitude makes every rounded value collapse onto
    // the same handful of doubles, so `out.length` never reaches MAX_TICKS and the loop never
    // reached `steps + 1` either — it did not return within a 25-second wait. No wall clock is
    // asserted here: `ticksForStep`'s own `index > MAX_TICKS` tripwire makes a regression throw
    // within a few thousand iterations instead of hanging this test run.
    const values = ticks(1_000_000, 2_000_000, 1e25)
    expect(values.length).toBeGreaterThan(0)
    expect(values.length).toBeLessThanOrEqual(MAX_TICKS)
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true)
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
    // The collapse leaves every surviving tick within a hair of `low`; a generous margin avoids
    // pinning the exact rounding artefact while still catching a wildly out-of-range result.
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(1_000_000 - 1)
      expect(value).toBeLessThanOrEqual(2_000_000 + 1)
    }
  })

  it("stays bounded for other absurd targets and spans, not just the one reported case", () => {
    // Same class of bug, different corners of it: an absurd target with an ordinary span, an
    // ordinary target with an absurd span (both directions), and Infinity as the target (which
    // normaliseTarget should catch before it ever reaches the loop).
    const cases: [number, number, number][] = [
      [0, 1, 1e300],
      [0, 1, Number.MAX_VALUE],
      [0, 1, Number.POSITIVE_INFINITY],
      [0, 1e300, 5],
      [0, 1e-300, 1e25],
      [-1e300, 1, 1e20],
    ]
    for (const [min, max, target] of cases) {
      const values = ticks(min, max, target)
      expect(values.length).toBeLessThanOrEqual(MAX_TICKS)
      expect(values.every(Number.isFinite)).toBe(true)
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1])
      }
    }
  })
})

describe("ticksForStep", () => {
  it("returns the ticks between two bounds at a fixed step", () => {
    expect(ticksForStep(0, 100, 20)).toEqual([0, 20, 40, 60, 80, 100])
    expect(ticksForStep(0, 100, 25)).toEqual([0, 25, 50, 75, 100])
  })

  it("matches ticks when given the step niceStep picks", () => {
    for (const [min, max] of [[0, 100], [-5, 5], [0.1, 0.9], [0, 1e-12], [-1e18, 1e18]]) {
      expect(ticksForStep(min, max, niceStep(max - min))).toEqual(ticks(min, max))
    }
  })

  it("starts and ends on bounds rounded with roundToStep, as niceScale rounds them", () => {
    // niceScale rounds its padded domain outward to multiples of the step, then asks for the ticks
    // between them. 3 * 0.1 is 0.30000000000000004 in floats, and the first tick is rounded, so
    // an unrounded bound would disagree with its own end label.
    const step = 0.1
    const low = roundToStep(Math.floor(0.35 / step) * step, step)
    const high = roundToStep(Math.ceil(1.25 / step) * step, step)
    expect([low, high]).toEqual([0.3, 1.3])
    const values = ticksForStep(low, high, step)
    expect(values).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3])
  })

  it("stops at MAX_TICKS ticks when the step is far finer than the range", () => {
    const values = ticksForStep(0, 1e6, 1)
    expect(values.length).toBe(MAX_TICKS)
    expect(values[values.length - 1]).toBe(MAX_TICKS - 1)
  })

  it("returns an empty axis for a non-finite bound instead of throwing", () => {
    expect(ticksForStep(Number.NaN, 1, 0.2)).toEqual([])
    expect(ticksForStep(0, Number.POSITIVE_INFINITY, 0.2)).toEqual([])
  })

  it("swaps reversed bounds", () => {
    expect(ticksForStep(10, 0, 5)).toEqual([0, 5, 10])
  })

  it("returns the bounds as they are for a step that is not a finite number above zero", () => {
    expect(ticksForStep(0, 10, 0)).toEqual([0, 10])
    expect(ticksForStep(0, 10, -2)).toEqual([0, 10])
    expect(ticksForStep(0, 10, Number.NaN)).toEqual([0, 10])
    expect(ticksForStep(10, 0, Number.POSITIVE_INFINITY)).toEqual([0, 10])
  })
})

describe("roundToStep", () => {
  it("removes float noise at the precision the step implies", () => {
    expect(roundToStep(0.1 + 0.2, 0.1)).toBe(0.3)
    expect(roundToStep(3 * 2e-13, 2e-13)).toBe(6e-13)
  })

  it("rounds to a whole number for a step of one or more", () => {
    expect(roundToStep(41.6, 20)).toBe(42)
  })

  it("leaves the value as it is for a step that is not a finite number above zero", () => {
    expect(roundToStep(0.35, -0.1)).toBe(0.35)
    expect(roundToStep(0.35, 0)).toBe(0.35)
    expect(roundToStep(0.35, Number.NaN)).toBe(0.35)
  })
})
