// Password hashing with a pepper: PBKDF2-HMAC-SHA-256 through WebCrypto.
//
// Rewritten from `template/libs/platform/helpers/hash.ts`. The source compared the derived key to
// the stored one with `===` on hex strings, which leaks through timing how many leading characters
// match, and it threw on a stored value with no `:` or with odd-length hex instead of answering
// "no". Its stored value `<salt>:<key>` records no parameters, so the iteration count could never be
// raised without locking every user out. Here the stored value names its scheme and iteration count,
// the comparison is `constantTimeEquals`, and a malformed stored value is simply not a match. The
// source's format is still accepted by `verify` so an existing database keeps working; it always
// reports `needsRehash`.

import { decodeHex, encodeHex } from "@std/encoding/hex"
import { constantTimeEquals } from "@ts-libs/platform/tokens"
import { requireSecret } from "./secret.ts"

/** Scheme name written at the start of every hash this module produces. */
export const PASSWORD_HASH_SCHEME = "pbkdf2-sha256"

/**
 * Default PBKDF2-HMAC-SHA-256 iteration count: 600 000, the figure the OWASP Password Storage Cheat
 * Sheet gives for this function.
 */
export const DEFAULT_PASSWORD_ITERATIONS = 600_000

/** Lowest iteration count accepted, as an option or in a stored hash: the source's 100 000. */
export const MIN_PASSWORD_ITERATIONS = 100_000

/**
 * Highest iteration count accepted, as an option or in a stored hash. A stored value is data, and a
 * row claiming a billion iterations would otherwise tie up a CPU for minutes on every attempt.
 */
export const MAX_PASSWORD_ITERATIONS = 10_000_000

/**
 * Longest password accepted, in UTF-8 bytes. Longer input is refused before any key derivation, so
 * a request body cannot choose how much work one attempt costs.
 */
export const MAX_PASSWORD_BYTES = 1024

const SALT_BYTES = 16
const KEY_BYTES = 32
const LEGACY_ITERATIONS = 100_000

const CURRENT_FORMAT = /^pbkdf2-sha256\$([1-9][0-9]{5,7})\$([0-9a-f]{32})\$([0-9a-f]{64})$/
const LEGACY_FORMAT = /^([0-9a-f]{32}):([0-9a-f]{64})$/

/** Options for {@link createPasswordHasher}. */
export interface PasswordHasherOptions {
  /**
   * Server-side secret mixed into every hash, at least 32 printable characters. Kept out of the
   * database, so a leaked table alone cannot be searched offline. Changing it invalidates every
   * stored hash.
   */
  pepper: string
  /** PBKDF2 iterations for new hashes. Defaults to {@link DEFAULT_PASSWORD_ITERATIONS}. */
  iterations?: number
}

/** Outcome of {@link PasswordHasher.verify}. */
export interface PasswordCheck {
  /** True only when the password matches the stored hash. */
  valid: boolean
  /**
   * True when the password matched but the stored hash uses the source's format or fewer
   * iterations than configured. Hash the password again and store the new value.
   */
  needsRehash: boolean
}

/** Hashes and verifies passwords under one pepper and iteration count. */
export interface PasswordHasher {
  /**
   * Hashes a password with a fresh 16-byte random salt.
   *
   * @returns `pbkdf2-sha256$<iterations>$<salt hex>$<key hex>`.
   * @throws {TypeError} When the password is not a string.
   * @throws {RangeError} When the password is empty or longer than {@link MAX_PASSWORD_BYTES}.
   */
  hash(password: string): Promise<string>
  /**
   * Checks a password against a stored hash. Never throws on bad input: a password that is not a
   * string, is empty or too long, and a stored value that is not exactly one of the two formats,
   * are all `{ valid: false, needsRehash: false }`.
   */
  verify(password: string, stored: string): Promise<PasswordCheck>
}

const NO_MATCH: PasswordCheck = Object.freeze({ valid: false, needsRehash: false })

/**
 * Creates a {@link PasswordHasher}.
 *
 * The construction for new hashes: the password's UTF-8 bytes are first run through HMAC-SHA-256
 * keyed by the pepper, and those 32 bytes are the PBKDF2 input, with a 16-byte random salt and a
 * 32-byte output. The pepper is therefore a key, not text appended to the password.
 *
 * Hashes in the source's format, `<32 hex salt>:<64 hex key>`, are verified the way the source made
 * them: PBKDF2 over `password + pepper` at 100 000 iterations. A match reports `needsRehash`.
 *
 * @throws {TypeError} When the pepper is missing or shorter than 32 characters.
 * @throws {RangeError} When `iterations` is not an integer from {@link MIN_PASSWORD_ITERATIONS} to
 *     {@link MAX_PASSWORD_ITERATIONS}.
 */
export function createPasswordHasher(options: PasswordHasherOptions): PasswordHasher {
  const pepper = requireSecret("pepper", options.pepper)
  const iterations = options.iterations ?? DEFAULT_PASSWORD_ITERATIONS
  if (!isIterationCount(iterations)) {
    throw new RangeError(
      `iterations must be an integer from ${MIN_PASSWORD_ITERATIONS} to ${MAX_PASSWORD_ITERATIONS}`,
    )
  }
  const encoder = new TextEncoder()
  const pepperKey = crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  async function derive(password: string, salt: Uint8Array, rounds: number): Promise<string> {
    const input = new Uint8Array(
      await crypto.subtle.sign("HMAC", await pepperKey, encoder.encode(password)),
    )
    return await pbkdf2(input, salt, rounds)
  }

  return {
    async hash(password: string): Promise<string> {
      if (typeof password !== "string") throw new TypeError("password must be a string")
      if (!isAcceptableLength(password)) {
        throw new RangeError(`password must be 1 to ${MAX_PASSWORD_BYTES} bytes`)
      }
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
      const key = await derive(password, salt, iterations)
      return `${PASSWORD_HASH_SCHEME}$${iterations}$${encodeHex(salt)}$${key}`
    },

    async verify(password: string, stored: string): Promise<PasswordCheck> {
      if (typeof password !== "string" || !isAcceptableLength(password)) return NO_MATCH
      if (typeof stored !== "string") return NO_MATCH

      const current = CURRENT_FORMAT.exec(stored)
      if (current) {
        const rounds = Number(current[1])
        if (!isIterationCount(rounds)) return NO_MATCH
        const derived = await derive(password, decodeHex(current[2]), rounds)
        const expected = current[3]
        if (!(await constantTimeEquals(derived, expected))) return NO_MATCH
        return { valid: true, needsRehash: rounds < iterations }
      }

      const legacy = LEGACY_FORMAT.exec(stored)
      if (legacy) {
        const input = encoder.encode(password + pepper)
        const derived = await pbkdf2(input, decodeHex(legacy[1]), LEGACY_ITERATIONS)
        const expected = legacy[2]
        if (!(await constantTimeEquals(derived, expected))) return NO_MATCH
        return { valid: true, needsRehash: true }
      }

      return NO_MATCH
    },
  }
}

/** PBKDF2-HMAC-SHA-256, {@link KEY_BYTES} bytes, as lower-case hex. */
async function pbkdf2(input: Uint8Array, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(input), "PBKDF2", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(salt), iterations, hash: "SHA-256" },
    key,
    KEY_BYTES * 8,
  )
  return encodeHex(new Uint8Array(bits))
}

function isIterationCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= MIN_PASSWORD_ITERATIONS &&
    (value as number) <= MAX_PASSWORD_ITERATIONS
}

function isAcceptableLength(password: string): boolean {
  if (password.length === 0) return false
  // Every UTF-16 code unit encodes to at least one UTF-8 byte, so this cheap check is exact for
  // input it refuses and spares encoding a very long string.
  if (password.length > MAX_PASSWORD_BYTES) return false
  return new TextEncoder().encode(password).byteLength <= MAX_PASSWORD_BYTES
}
