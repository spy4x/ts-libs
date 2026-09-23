// Configuration-secret check shared by the sign-in set. Internal: not exported from `mod.ts`.
//
// `platform/tokens.ts` has the same rule in `assertUsableSecret`, but does not export it. Only its
// floor, `MIN_SECRET_LENGTH`, is shared, so both modules reject the same secrets.

import { MIN_SECRET_LENGTH } from "@ts-libs/platform/tokens"

/**
 * Throws unless `value` is a printable-ASCII string of at least {@link MIN_SECRET_LENGTH}
 * characters after trimming.
 *
 * A pepper or cookie secret arrives from untyped configuration, so a missing variable must stop the
 * app at start-up instead of hashing against `"undefined"` or an empty key. The message names the
 * option and never echoes the rejected value.
 *
 * @param name The option name, used in the error message.
 * @param value The configured secret.
 * @throws {TypeError} When the secret is missing, not a string, blank, not printable ASCII, or too
 *     short.
 */
export function requireSecret(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string of at least ${MIN_SECRET_LENGTH} characters`)
  }
  const trimmed = value.trim()
  let printable = true
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) printable = false
  }
  if (!printable || trimmed.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`${name} must be a string of at least ${MIN_SECRET_LENGTH} characters`)
  }
  return value
}
