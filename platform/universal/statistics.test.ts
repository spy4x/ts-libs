import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  bootstrap,
  bootstrapDifference,
  crossesZero,
  mean,
  median,
  quantileSorted,
  seededRandom,
} from "./statistics.ts"

describe("median and mean", () => {
  it("median averages the middle two of an even count and is undefined when empty", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeUndefined()
  })

  it("mean of an empty list is undefined", () => {
    expect(mean([1, 2, 6])).toBe(3)
    expect(mean([])).toBeUndefined()
  })

  it("median and mean reject a sample holding NaN", () => {
    expect(() => median([1, NaN, 3])).toThrow(RangeError)
    expect(() => mean([1, NaN, 3])).toThrow(RangeError)
  })
})

describe("quantileSorted", () => {
  it("interpolates linearly between the two nearest ranks", () => {
    expect(quantileSorted([10, 20, 30, 40], 0)).toBe(10)
    expect(quantileSorted([10, 20, 30, 40], 1)).toBe(40)
    expect(quantileSorted([10, 20, 30, 40], 0.5)).toBeCloseTo(25)
    expect(quantileSorted([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5)
  })

  it("throws on an empty list", () => {
    expect(() => quantileSorted([], 0.5)).toThrow("empty")
  })

  it("throws when p is NaN or outside 0 to 1", () => {
    expect(() => quantileSorted([1, 2], NaN)).toThrow(RangeError)
    expect(() => quantileSorted([1, 2], -0.1)).toThrow(RangeError)
    expect(() => quantileSorted([1, 2], 1.1)).toThrow(RangeError)
  })
})

describe("seededRandom", () => {
  it("repeats its sequence for one seed and differs for another", () => {
    const a = seededRandom(42)
    expect([a(), a(), a()]).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099])
    expect(seededRandom(42)()).toBe(0.6011037519201636)
    expect(seededRandom(43)()).not.toBe(0.6011037519201636)
  })
})

describe("bootstrap", () => {
  it("of a median on a fixed seed gives the pinned interval", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(bootstrap(data, median, { seed: 7, iterations: 1000 })).toEqual({
      value: 5.5,
      lo: 3,
      hi: 8,
    })
  })

  it("of a mean on a fixed seed gives the pinned interval", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const got = bootstrap(data, mean, { seed: 7, iterations: 1000 })!
    expect(got.value).toBe(5.5)
    expect(got.lo).toBeCloseTo(3.6975, 9)
    expect(got.hi).toBeCloseTo(7.2, 9)
  })

  it("gives the same interval on every run with one seed", () => {
    const data = [3, 1, 4, 1, 5, 9, 2, 6]
    expect(bootstrap(data, median, { seed: 5 })).toEqual(bootstrap(data, median, { seed: 5 }))
  })

  it("of identical values collapses to that value", () => {
    expect(bootstrap([4, 4, 4], median, { seed: 1, iterations: 200 })).toEqual({
      value: 4,
      lo: 4,
      hi: 4,
    })
  })

  it("of an empty sample is undefined", () => {
    expect(bootstrap([], median)).toBeUndefined()
  })

  it("rejects NaN in the sample and a level outside 0 to 1", () => {
    expect(() => bootstrap([1, NaN], (sample) => sample.length)).toThrow(RangeError)
    expect(() => bootstrap([1, 2], median, { level: 1 })).toThrow(RangeError)
    expect(() => bootstrap([1, 2], median, { level: 0 })).toThrow(RangeError)
  })

  it("rejects an iterations count that is not a positive integer", () => {
    for (const iterations of [0, -1, NaN, 1.5, Infinity]) {
      expect(() => bootstrap([1, 2, 3], mean, { iterations })).toThrow(RangeError)
      expect(() => bootstrapDifference([1, 2], [3, 4], mean, { iterations })).toThrow(RangeError)
    }
  })

  it("checks the options before resampling, even for an empty sample", () => {
    let calls = 0
    const counting = (sample: readonly number[]) => (calls++, sample.length)
    expect(() => bootstrap([], counting, { level: 5 })).toThrow(RangeError)
    expect(() => bootstrap([1, 2], counting, { level: 5 })).toThrow(RangeError)
    expect(() => bootstrapDifference([], [1], counting, { iterations: 0 })).toThrow(RangeError)
    expect(calls).toBe(0)
  })

  it("rejects an infinite value in the sample", () => {
    expect(() => bootstrap([1, Infinity], mean)).toThrow(RangeError)
    expect(() => bootstrap([-Infinity, 1], mean)).toThrow(RangeError)
    expect(() => bootstrapDifference([1, Infinity], [1], mean)).toThrow(RangeError)
    expect(() => bootstrapDifference([1], [1, -Infinity], mean)).toThrow(RangeError)
  })

  it("ignores resamples whose statistic is not finite", () => {
    // The first call is the point estimate; later calls alternate between Infinity and 3.
    let calls = 0
    const flaky = () => (calls++ === 0 ? 2 : calls % 2 === 0 ? Infinity : 3)
    expect(bootstrap([1, 2, 3], flaky, { iterations: 40 })).toEqual({ value: 2, lo: 3, hi: 3 })
  })

  it("throws when no resample gives a finite statistic", () => {
    let first = true
    const onlyFirst = () => (first ? (first = false, 1) : NaN)
    expect(() => bootstrap([1, 2, 3], onlyFirst, { iterations: 20 })).toThrow(RangeError)
  })

  it("throws when the statistic is not finite on the data itself", () => {
    expect(() => bootstrap([1, 2, 3], () => Infinity, { iterations: 5 })).toThrow(RangeError)
  })

  it("a wider level gives a wider interval", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const narrow = bootstrap(data, mean, { seed: 3, iterations: 500, level: 0.5 })!
    const wide = bootstrap(data, mean, { seed: 3, iterations: 500, level: 0.99 })!
    expect(wide.hi - wide.lo).toBeGreaterThan(narrow.hi - narrow.lo)
  })
})

describe("bootstrapDifference", () => {
  it("on a fixed seed gives the pinned interval for unequal groups", () => {
    expect(
      bootstrapDifference([1, 2, 3, 4, 5], [4, 5, 6, 7, 8, 9], median, {
        seed: 7,
        iterations: 1000,
      }),
    ).toEqual({ value: 3.5, lo: 0.5, hi: 6 })
  })

  it("is undefined when either group is empty", () => {
    expect(bootstrapDifference([], [1], median)).toBeUndefined()
    expect(bootstrapDifference([1], [], median)).toBeUndefined()
  })

  it("rejects NaN in either group", () => {
    const count = (sample: readonly number[]) => sample.length
    expect(() => bootstrapDifference([NaN], [1], count)).toThrow(RangeError)
    expect(() => bootstrapDifference([1], [NaN], count)).toThrow(RangeError)
  })
})

describe("crossesZero", () => {
  it("is true when zero lies inside the interval, ends included", () => {
    expect(crossesZero({ value: 1, lo: -0.5, hi: 2 })).toBe(true)
    expect(crossesZero({ value: 1, lo: 0, hi: 2 })).toBe(true)
    expect(crossesZero({ value: 1, lo: 0.1, hi: 2 })).toBe(false)
    expect(crossesZero({ value: -1, lo: -2, hi: -0.1 })).toBe(false)
  })
})
