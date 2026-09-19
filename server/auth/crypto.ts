/**
 * Hashing and comparison.
 *
 * The house mechanism is unchanged from the source: PBKDF2-SHA-256 with a
 * per-value random salt and a deployment pepper appended to the input. Three
 * things are different, and each is a security fix:
 *
 *  1. The pepper is a required constructor argument of `CryptoContext`. The
 *     source read it two ways — a module-level `import.meta.env.PASSWORD_PEPPER`
 *     in `helpers.ts:7` and a `'custom-auth'` literal default in
 *     `misc/constants.ts:4`. A missing pepper now throws at construction instead
 *     of silently hashing with a string an attacker has read in this file.
 *  2. `constantTimeEquals` compares a SHA-256 digest of each side, so neither the
 *     content nor the length of a secret is observable from timing.
 *  3. Nothing is logged. No path here can put a password, an OTP, a magic-link
 *     token, a session token or the pepper into a message.
 *
 * The stored format is `hexSalt:hexKey`, which is the format the source produced
 * and what existing rows would hold. It is not marked with an algorithm id, so a
 * future parameter change needs an explicit version column — recorded as a
 * tradeoff in the PR body rather than fixed speculatively here. The *peppered
 * input* is length-framed, which is a deliberate change from the source's
 * concatenation; see `frame`.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal"
import { DEFAULT_HASH_ITERATIONS, DEFAULT_HASH_KEY_BYTES } from "./constants.ts"

/** Raised when the injected pepper is absent or blank. */
export class MissingPepperError extends Error {
  constructor() {
    super("auth pepper is required: pass a non-empty `passwordPepper` to createAuth")
    this.name = "MissingPepperError"
  }
}

/**
 * Assert a pepper was supplied. Exported so a caller that builds its own
 * `CryptoContext` gets the same fail-closed check, and so the rule is testable
 * on its own.
 */
export function assertPepper(pepper: string | undefined | null): string {
  if (typeof pepper !== "string" || pepper.trim().length === 0) {
    throw new MissingPepperError()
  }
  return pepper
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? []
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)))
}

/**
 * Pepper-bound key derivation. Every caller that stores a secret at rest —
 * passwords, OTPs and magic-link tokens alike — goes through this one class, so
 * a change of algorithm is a change of one file.
 */
export class CryptoContext {
  readonly pepper: string
  readonly iterations: number
  readonly keyBytes: number

  constructor(options: { pepper: string; iterations?: number; keyBytes?: number }) {
    this.pepper = assertPepper(options.pepper)
    this.iterations = options.iterations ?? DEFAULT_HASH_ITERATIONS
    this.keyBytes = options.keyBytes ?? DEFAULT_HASH_KEY_BYTES
  }

  /** Derive `hexSalt:hexKey` for `value`. A fresh salt per call, never reused. */
  async hash(value: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await this.derive(value, salt)
    return `${toHex(salt)}:${toHex(key)}`
  }

  /**
   * Verify `value` against a stored `hexSalt:hexKey`.
   *
   * A malformed stored hash returns `false` rather than throwing: a corrupted
   * row must fail the login, not 500 the endpoint. The comparison runs on the
   * raw derived bytes, so there is no hex-encoded early exit.
   */
  async verify(value: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) {
      return false
    }
    const separator = stored.indexOf(":")
    if (separator <= 0) {
      return false
    }
    const salt = fromHex(stored.slice(0, separator))
    const expected = fromHex(stored.slice(separator + 1))
    if (salt.length === 0 || expected.length === 0) {
      return false
    }
    const actual = await this.derive(value, salt, expected.length)
    if (actual.length !== expected.length) {
      return false
    }
    return timingSafeEqual(actual, expected)
  }

  /**
   * Constant-time equality for two caller-supplied strings of any length.
   *
   * Both sides are digested to a fixed 32 bytes under one `Promise.all`, before
   * any comparison and before any branch that observes the inputs, and only then
   * compared with `timingSafeEqual`. A length-dependent early return is therefore
   * impossible: the function has no branch over the inputs at all, only over
   * their fixed-width digests. The digest step is not decoration — without it
   * `timingSafeEqual` throws on unequal lengths, and a thrown-and-caught
   * comparison is itself a length oracle.
   */
  async constantTimeEquals(left: string, right: string): Promise<boolean> {
    const encoder = new TextEncoder()
    const [leftDigest, rightDigest] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(left)),
      crypto.subtle.digest("SHA-256", encoder.encode(right)),
    ])
    return timingSafeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest))
  }

  private async derive(
    value: string,
    salt: Uint8Array,
    keyBytes = this.keyBytes,
  ): Promise<Uint8Array> {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(frame(value, this.pepper)),
      "PBKDF2",
      false,
      ["deriveBits"],
    )
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: this.iterations,
        hash: "SHA-256",
      },
      key,
      keyBytes * 8,
    )
    return new Uint8Array(bits)
  }
}

/**
 * Build the PBKDF2 input as `<valueLength>:<value>:<pepper>`.
 *
 * The source concatenated the two (`password + pepper`), which is only
 * unambiguous while no pepper is a suffix of another pepper: `("xpe", "pper")`
 * and `("x", "pepper")` produce the same input bytes, so a credential hashed
 * under one pepper verifies under the other. Framing the value with its length
 * fixes the boundary.
 *
 * This changes the derived bytes for an existing row, which is a migration and not
 * a compatibility shim. There is no production data for this package — it is being
 * extracted — so the stance in the PR body is "no migration", and the stored
 * `hexSalt:hexKey` format is unchanged so a future migration can key off the
 * version column that does not exist yet.
 */
function frame(value: string, pepper: string): string {
  return `${value.length}:${value}:${pepper}`
}
