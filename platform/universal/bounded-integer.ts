/**
 * Reading a whole number from a query string or another text, within bounds.
 *
 * @module
 */

/** Options of {@link parseBoundedInteger}. */
export interface BoundedIntegerOptions {
  /** What a missing value (`undefined`) gives. Must lie within `min` and `max`. */
  fallback: number
  /** The smallest accepted value. Defaults to 1, as for a page size. */
  min?: number
  /** The largest accepted value. */
  max: number
}

/**
 * The whole number `value` spells, or `options.fallback` when `value` is `undefined`, or `null`
 * when it is anything else that is not an integer in `min` to `max`.
 *
 * Only plain decimal digits count: a sign (`-3`), a fraction (`1.5`), an exponent (`1e2`), a space,
 * an empty string and any text give `null`, as does a number outside the bounds (`0` with the
 * default `min`). The caller decides what `null` means, such as a 400 response for a `?limit=`.
 *
 * @example
 * ```ts
 * const limit = parseBoundedInteger(url.searchParams.get(`limit`) ?? undefined, {
 *   fallback: 20,
 *   max: 50,
 * })
 * if (limit === null) return new Response(`Invalid limit`, { status: 400 })
 * ```
 *
 * @throws {RangeError} When the options are inconsistent: `min` above `max`, or `fallback`
 * outside them.
 */
export function parseBoundedInteger(
  value: string | undefined,
  options: BoundedIntegerOptions,
): number | null {
  const { fallback, min = 1, max } = options
  if (min > max || fallback < min || fallback > max) {
    throw new RangeError(`fallback ${fallback} must lie within min ${min} and max ${max}`)
  }
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}
