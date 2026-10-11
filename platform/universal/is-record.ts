/**
 * A type guard for a value of unknown shape read from JSON, such as an API answer.
 *
 * @module
 */

/**
 * True for a plain keyed object: not `null`, not an array. Class instances (a `Date`, a `Map`)
 * count too, because `typeof` cannot tell them apart; use this to read a parsed JSON body, not to
 * test for a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
