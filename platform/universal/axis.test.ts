import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { niceStep, ticks } from "./axis.ts"

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

  it("rejects a non-positive target rather than dividing by zero", () => {
    expect(() => niceStep(10, 0)).toThrow("target must be positive")
    expect(() => niceStep(10, -1)).toThrow("target must be positive")
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

  it("rejects a non-finite bound rather than emitting NaN ticks", () => {
    expect(() => ticks(0, Number.NaN)).toThrow("must be finite")
    expect(() => ticks(Number.POSITIVE_INFINITY, 1)).toThrow("must be finite")
  })

  it("swaps reversed bounds instead of returning them as given", () => {
    // Before this fix `ticks(10, 0)` returned `[10, 0]` (a two-element descending pair that reads
    // as a valid axis) and, on origin/main before this PR, `[]`. The reference swaps unconditionally
    // and documents it as deliberate; expected values taken from running it.
    expect(ticks(10, 0)).toEqual(ticks(0, 10))
    expect(ticks(10, 0)).toEqual([0, 2, 4, 6, 8, 10])
    expect(ticks(1, -1)).toEqual([-1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2])
  })

  it("terminates on a span narrower than the float precision of its bounds, instead of looping forever", () => {
    // Before the fix, a cursor advanced by `value += step` never moved once the step (20) was
    // finer than one ulp at 1e18 (128), so the loop that read `value <= end + step / 2` never
    // returned. Expected values taken from `preact-components/charts/scales.ts`, the reference
    // this package is now the single home for (see `platform/universal/axis.ts`'s JSDoc).
    expect(ticks(1e18, 1e18 + 100)).toEqual([1e18, 1e18 + 100])
  })

  it("keeps six distinct ticks for a span far below one unit, instead of collapsing to a single 0", () => {
    // Before the fix, `niceStep` floored its result at 1e-9 — coarser than the whole 1e-12 span —
    // so every tick but the first rounded away and `ticks(0, 1e-12)` returned `[0]`. Expected
    // values taken from `preact-components/charts/scales.ts`.
    expect(ticks(0, 1e-12)).toEqual([0, 2e-13, 4e-13, 6e-13, 8e-13, 1e-12])
  })
})
