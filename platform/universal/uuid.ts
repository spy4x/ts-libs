/**
 * UUID version 7 ids and the checks for a UUID of any version.
 *
 * A version 7 id starts with its creation time in milliseconds, so ids of new rows land next to each
 * other in a database index and sort by age. It runs in a browser and on every server runtime,
 * because it only needs `crypto.getRandomValues`.
 *
 * @example Make an id and check one
 * ```ts
 * const id = uuidV7()
 * isUuid(id) // true
 * isUuid(id, 7) // true
 * isUuid(crypto.randomUUID(), 7) // false: that one is version 4
 * ```
 *
 * @example Say "a UUID" in an arktype schema
 * ```ts
 * import { type } from "arktype"
 * const Row = type({ id: type(UUID_PATTERN) })
 * ```
 *
 * @module
 */

import { generate } from "@std/uuid/v7"

/** A lower-case UUID of any version, the form Postgres and `crypto.randomUUID` print. */
export const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A lower-case UUID version 7 with the RFC 9562 variant bits. */
export const UUID_V7_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The UUID versions RFC 9562 defines. */
export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** Millisecond stamp of the last id made, so the next one never sorts before it. */
let lastTimestamp = 0

/**
 * A new lower-case UUID version 7, such as `019a2f4e-7c31-7b2d-9e4a-5c8f1d3b6a70`.
 *
 * Ids made by one process sort in creation order, also inside one millisecond: when the clock has
 * not moved past the last id (or went backwards), the stamp moves one millisecond past it. Under a
 * sustained burst above 1000 ids per second the stamp therefore runs slightly ahead of the clock.
 * Ids from different processes sort by their millisecond only.
 *
 * Do not use it where the value must not reveal when it was made, or where it works as a secret
 * (a session token, a password-reset link, an API key): the first 48 bits are the creation time and
 * the rest is guessable by anyone who knows the time. Use `crypto.randomUUID()` or a random token
 * there.
 */
export function uuidV7(): string {
  const now = Date.now()
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1
  return generate(lastTimestamp)
}

/**
 * True for a lower-case UUID. Without `version` any version passes; with it only that version
 * does, and the RFC 9562 variant bits must be set. Upper-case input is refused, so one id has one
 * spelling in a database and in a URL.
 */
export function isUuid(value: unknown, version?: UuidVersion): value is string {
  if (typeof value !== `string`) return false
  if (version === undefined) return UUID_PATTERN.test(value)
  if (version === 7) return UUID_V7_PATTERN.test(value)
  return UUID_PATTERN.test(value) && value[14] === String(version) && `89ab`.includes(value[19])
}
