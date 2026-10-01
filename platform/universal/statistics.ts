/**
 * Small statistics helpers: median, mean, quantiles, a seeded random number generator and a
 * percentile bootstrap for confidence intervals.
 *
 * Plain functions on `number[]` with no dependencies, so a script comparing two groups of
 * measurements and a page charting them agree on the arithmetic. The bootstrap is deterministic:
 * the same seed and data always give the same interval.
 *
 * @module
 */

/** Throws when a sample holds `NaN`, which would silently poison every statistic. */
function assertNoNaN(values: readonly number[]): void {
  for (const v of values) {
    if (Number.isNaN(v)) throw new RangeError("sample contains NaN")
  }
}

/**
 * Median of `values`; `undefined` for an empty list. Even counts average the middle two.
 *
 * @throws {RangeError} when `values` contains `NaN`.
 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  assertNoNaN(values)
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Arithmetic mean; `undefined` for an empty list.
 *
 * @throws {RangeError} when `values` contains `NaN`.
 */
export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  assertNoNaN(values)
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * The `p`-th quantile (0 to 1) of an ascending-sorted list, by linear interpolation between the
 * two nearest ranks (the default of NumPy and R). The list is trusted to be sorted.
 *
 * @throws {Error} when `sorted` is empty.
 * @throws {RangeError} when `p` is `NaN` or outside 0 to 1.
 */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("quantile of an empty list")
  if (!(p >= 0 && p <= 1)) throw new RangeError("quantile p must be between 0 and 1")
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/**
 * A seeded random number generator returning floats in [0, 1): mulberry32. Not for security; it
 * exists so a resampling run can be repeated exactly.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A statistic's value on the data and its bootstrap interval. */
export interface Interval {
  readonly value: number
  readonly lo: number
  readonly hi: number
}

/** Bootstrap settings. The same seed and data always give the same interval. */
export interface BootstrapOptions {
  /** Seed of the resampling generator, default 1. */
  readonly seed?: number
  /** Number of resamples, default 10 000. */
  readonly iterations?: number
  /** Confidence level, default 0.95. */
  readonly level?: number
}

const DEFAULT_ITERATIONS = 10_000
const DEFAULT_SEED = 1

function resample(values: readonly number[], random: () => number): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[Math.floor(random() * values.length)]
  return out
}

function percentileInterval(value: number, draws: number[], level: number): Interval {
  if (!(level > 0 && level < 1)) throw new RangeError("level must be between 0 and 1, exclusive")
  const sorted = draws.filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
  if (sorted.length === 0) return { value, lo: NaN, hi: NaN }
  const tail = (1 - level) / 2
  return { value, lo: quantileSorted(sorted, tail), hi: quantileSorted(sorted, 1 - tail) }
}

/**
 * Percentile bootstrap interval of `statistic` over `values`. Returns `undefined` for an empty
 * sample, since there is nothing to resample.
 *
 * @throws {RangeError} when `values` contains `NaN` or `options.level` is outside 0 to 1.
 */
export function bootstrap(
  values: readonly number[],
  statistic: (sample: readonly number[]) => number | undefined,
  options: BootstrapOptions = {},
): Interval | undefined {
  assertNoNaN(values)
  const value = statistic(values)
  if (value === undefined) return undefined
  const random = seededRandom(options.seed ?? DEFAULT_SEED)
  const draws: number[] = []
  for (let i = 0; i < (options.iterations ?? DEFAULT_ITERATIONS); i++) {
    const d = statistic(resample(values, random))
    if (d !== undefined) draws.push(d)
  }
  return percentileInterval(value, draws, options.level ?? 0.95)
}

/**
 * Bootstrap interval of `statistic(b) - statistic(a)`, resampling each group on its own, so the
 * two groups may differ in size. Returns `undefined` when either group is empty.
 *
 * @throws {RangeError} when either group contains `NaN` or `options.level` is outside 0 to 1.
 */
export function bootstrapDifference(
  a: readonly number[],
  b: readonly number[],
  statistic: (sample: readonly number[]) => number | undefined,
  options: BootstrapOptions = {},
): Interval | undefined {
  assertNoNaN(a)
  assertNoNaN(b)
  const va = statistic(a)
  const vb = statistic(b)
  if (va === undefined || vb === undefined) return undefined
  const random = seededRandom(options.seed ?? DEFAULT_SEED)
  const draws: number[] = []
  for (let i = 0; i < (options.iterations ?? DEFAULT_ITERATIONS); i++) {
    const da = statistic(resample(a, random))
    const db = statistic(resample(b, random))
    if (da !== undefined && db !== undefined) draws.push(db - da)
  }
  return percentileInterval(vb - va, draws, options.level ?? 0.95)
}

/** True when the interval contains zero, so the data do not show a difference. */
export function crossesZero(interval: Interval): boolean {
  return interval.lo <= 0 && interval.hi >= 0
}
