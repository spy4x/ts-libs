/**
 * UUID version 7 ids and UUID validators.
 *
 * A version 7 id starts with the millisecond it was made in, so new rows land next to each other in
 * a database index and ids sort by age. Use it for the id of a stored record, on the server or in a
 * browser that creates records offline.
 *
 * **When not to use version 7.** Anyone who sees the id can read when it was made, and can guess
 * the ids made around the same time more easily than random ones. Two kinds of value are therefore
 * never a UUID: one that works as a secret (a session id, a CSRF, lock or claim token, a reset or
 * invitation token), and an id that other people see and that must not show when it was made (a
 * share link, a public profile or order number). Both are `randomBase64Url()` from
 * `@spy4x/platform/tokens`.
 *
 * @example An id for a new record, and a schema that accepts one
 * ```ts
 * import { type } from "arktype"
 *
 * const note = { id: uuidV7(), text: "milk" }
 * const noteSchema = type({ id: UUID_V7_PATTERN, text: "string" })
 * isUuid(note.id, 7) // true
 * ```
 *
 * @module
 */

import { generate } from "@std/uuid/v7"

/**
 * A lower-case UUID of any version, the form Postgres and the browser's own generator print. It checks the
 * shape only, so the nil UUID and ids with no valid version digit match too. arktype takes it as a
 * schema: `type({ id: UUID_PATTERN })`.
 */
export const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A lower-case UUID of version 7, as {@link uuidV7} makes it: version digit `7` and the standard
 * variant (`8`, `9`, `a` or `b`). arktype takes it as a schema: `type({ id: UUID_V7_PATTERN })`.
 */
export const UUID_V7_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The version digit of a UUID: `4` is the random one, `7` the time-ordered one. */
export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** Position of the version digit in the printed form. */
const VERSION_INDEX = 14

/** Position of the variant digit in the printed form. */
const VARIANT_INDEX = 19

/** Variant digits of the standard layout, the only one that has a version. */
const VARIANT_DIGITS = "89ab"

/**
 * True for a lower-case UUID string. Without `version` it accepts any UUID shape, as
 * {@link UUID_PATTERN} does. With `version` it accepts only that version in the standard variant,
 * so `isUuid(value, 7)` refuses a version 4 id. Upper-case input is refused in both
 * forms: lower-case it first if the source prints it otherwise.
 */
export function isUuid(value: unknown, version?: UuidVersion): value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return false
  if (version === undefined) return true
  return value[VERSION_INDEX] === String(version) && VARIANT_DIGITS.includes(value[VARIANT_INDEX]!)
}

/** Where the 12-bit counter sits in the printed form: the three digits after the version digit. */
const COUNTER_START = 15
const COUNTER_END = 18

/** Largest value the 12-bit counter holds. */
const COUNTER_MAX = 0xfff

/** A fresh millisecond starts its counter in the lower half, so 2 048 more ids always fit. */
const COUNTER_SEED_MASK = 0x7ff

/** Millisecond written into the last id, and that id's counter. */
let lastMs = -1
let counter = 0

/**
 * Returns a new lower-case UUID version 7.
 *
 * The first 48 bits are the Unix time in milliseconds and the rest is random, from `@std/uuid`.
 * Ids made by one process always sort in the order they were made, as strings and as Postgres
 * `uuid` values, also inside one millisecond: the 12 bits after the version digit hold a counter
 * that starts at a random value each millisecond and goes up by one per id. When the counter is
 * full, or the clock steps back, the id takes the last used millisecond (plus one when full)
 * instead of the clock's, so its time can run slightly ahead of the clock. Two processes, or two
 * browser tabs, do not share the counter: their ids sort by millisecond only.
 *
 * Do not use it for a value that works as a secret, or for an id that other people see and that
 * must not show when it was made: those are `randomBase64Url()` from `@spy4x/platform/tokens`.
 */
export function uuidV7(): string {
  const now = Date.now()
  // A new millisecond, or a full counter that moves the id one millisecond ahead of the clock.
  let reseed = true
  if (now > lastMs) {
    lastMs = now
  } else if (counter === COUNTER_MAX) {
    lastMs += 1
  } else {
    counter += 1
    reseed = false
  }
  const id = generate(lastMs)
  if (reseed) counter = parseInt(id.slice(COUNTER_START, COUNTER_END), 16) & COUNTER_SEED_MASK
  return id.slice(0, COUNTER_START) + counter.toString(16).padStart(3, "0") + id.slice(COUNTER_END)
}
