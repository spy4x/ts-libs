/**
 * The file-name rule shared by `CalDavClient.createObject` and the write transport. Private: not
 * in the package's exports.
 *
 * @module
 */

/**
 * Whether an entity id can name an object: letters, digits, `.`, `_`, `~` and `-`, and not `.` or
 * `..`. The same rule as the `name` of `CalDavClient.createObject`.
 */
export function isSafeEntityId(entityId: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(entityId) && entityId !== "." && entityId !== ".."
}
