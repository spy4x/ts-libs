/**
 * Unique names, so two integration runs never collide.
 *
 * Several worktrees run `deno task test:integration` against the same containers —
 * that is the point of having one set of containers on the machine. Two runs of the
 * same test therefore exist at the same time, and anything either of them names
 * globally (a schema, an object key, a mail recipient) has to be unique per run.
 *
 * The rule for every integration test: take a fresh suffix, build every global name
 * from it, and remove what you created at the end, in a `finally`. A test that
 * truncates a shared table or deletes every message instead is a test that fails the
 * other run.
 */

/** Reserved domain for recipients. `.test` is reserved by RFC 2606 and resolves nowhere. */
export const RESERVED_EMAIL_DOMAIN = "ts-libs.test"

const SUFFIX_BYTES = 6
const IDENTIFIER_PREFIX = /^[a-z][a-z0-9_]*$/

/**
 * A fresh lowercase-hex suffix, 12 characters from the platform's CSPRNG.
 *
 * Long enough that two concurrent runs colliding is not a thing that happens, short
 * enough to stay inside Postgres's 63-byte identifier limit with room for a prefix.
 */
export function uniqueSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_BYTES))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * A unique SQL identifier, e.g. `it_storage_9f2c1a0b7d34`.
 *
 * Lowercase letters, digits and underscores only, so it needs no quoting and cannot
 * carry an injection. The prefix is validated rather than escaped: a caller passing
 * something else has a bug, and hiding it behind an escape would hide the bug too.
 */
export function uniqueIdentifier(prefix: string): string {
  if (!IDENTIFIER_PREFIX.test(prefix)) {
    throw new TypeError(
      `Identifier prefix must match ${IDENTIFIER_PREFIX.source}, got ${JSON.stringify(prefix)}`,
    )
  }
  return `${prefix}_${uniqueSuffix()}`
}

/**
 * A unique object-key prefix, e.g. `integration/9f2c1a0b7d34`, with no leading or
 * trailing slash. Every object a test writes goes under it, and cleanup deletes
 * exactly the keys the test created.
 */
export function uniqueKeyPrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "")
  if (trimmed === "" || trimmed.includes("..")) {
    throw new TypeError(`Key prefix must be a relative path segment, got ${JSON.stringify(prefix)}`)
  }
  return `${trimmed}/${uniqueSuffix()}`
}

/**
 * A unique recipient in the reserved `.test` domain, e.g.
 * `smtp-9f2c1a0b7d34@ts-libs.test`. Searching Mailpit for this address returns this
 * run's mail and nobody else's.
 */
export function uniqueRecipient(prefix: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(prefix)) {
    throw new TypeError(
      `Recipient prefix must be a mailbox-safe label, got ${JSON.stringify(prefix)}`,
    )
  }
  return `${prefix}-${uniqueSuffix()}@${RESERVED_EMAIL_DOMAIN}`
}
