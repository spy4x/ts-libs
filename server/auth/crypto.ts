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
 *  2. Both verify paths compare through one seam, `CryptoContext.compare`
 *     (default `timingSafeEqual`), so a substitute comparison cannot be inserted
 *     without a test noticing. `verify` compares two derived keys;
 *     `constantTimeEquals` first digests each side to a fixed 32 bytes, so neither
 *     the content nor the length of a value that is *not* hashed at rest is
 *     observable from timing. Its production call site is the OAuth2 `state`
 *     check, not the magic-link token.
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

/** Hex digits only, and an even number of them. */
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/i

/**
 * Decode a hex string to bytes, or `null` if it is not valid hex.
 *
 * The previous form was `new Uint8Array(hex.match(/../g)!.map((pair) =>
 * Number.parseInt(pair, 16)))`, which had two acceptance defects:
 *
 *  - `Number.parseInt("zz", 16)` is `NaN`, and `Uint8Array` **coerces `NaN` to
 *    `0x00`**. A stored hash of `<salt>:zz` therefore decoded to a one-byte zero key,
 *    and `verify` accepted any credential whose one-byte PBKDF2 output was `0x00` —
 *    roughly one credential in 256. That is an authentication bypass reachable from a
 *    single corrupt or adversarially inserted row, since `postgres-adapter.ts` maps
 *    `secret` through `toNullableString` with no format check.
 *  - `hex.match(/../g)` silently truncates an odd-length string (`"abc"` → `"AB"`),
 *    so a truncated or malformed digest could still compare equal.
 *
 * Returning `null` rather than throwing keeps the caller's contract: a corrupt row
 * fails the login, it does not 500 the endpoint.
 */
function fromHex(hex: string): Uint8Array | null {
  if (!HEX_PATTERN.test(hex)) {
    return null
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Compares two byte arrays of equal length and returns whether they match.
 *
 * The default is `timingSafeEqual` from `@std/crypto`. The seam exists so the
 * comparison on the verify path is *observable by a test*: a test injects a
 * recording comparator and thereby proves that the production path routed through
 * this one function with fixed-width digests, which is the property that a
 * constant-time comparison actually rests on. Measuring wall-clock latency would
 * be flaky on shared CI, so the property is proven structurally instead — see
 * `crypto.test.ts`, "the verify path compares through the injected comparator".
 */
export type BytesComparator = (left: Uint8Array, right: Uint8Array) => boolean

/** Every digest and every derived key in this package is compared through this. */
export const timingSafeBytesComparator: BytesComparator = timingSafeEqual

/**
 * Pepper-bound key derivation. Every caller that stores a secret at rest —
 * passwords, OTPs and magic-link tokens alike — goes through this one class, so
 * a change of algorithm is a change of one file.
 *
 * Both comparison sites call `this.compare` and nothing else. There is exactly
 * one `timingSafeEqual` reference in the package (the default above) and no direct
 * byte or string comparison of a secret anywhere on a verify path; a mutation that
 * substitutes one is caught behaviourally, because the injected comparator stops
 * being called.
 */
export class CryptoContext {
  readonly pepper: string
  readonly iterations: number
  readonly keyBytes: number
  private readonly compare: BytesComparator

  constructor(options: {
    pepper: string
    iterations?: number
    keyBytes?: number
    /** Comparison implementation. Injected by tests; production uses `timingSafeEqual`. */
    comparator?: BytesComparator
  }) {
    this.pepper = assertPepper(options.pepper)
    this.iterations = options.iterations ?? DEFAULT_HASH_ITERATIONS
    this.keyBytes = options.keyBytes ?? DEFAULT_HASH_KEY_BYTES
    this.compare = options.comparator ?? timingSafeBytesComparator
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
   * Every malformed input returns `false` rather than throwing or reaching the
   * comparison: a corrupt row must fail the login, not 500 the endpoint and not
   * authenticate. The format is enforced before decoding — a non-hex or
   * odd-length salt or key is rejected outright, because a decoder that coerces
   * its input is an acceptance path (see `fromHex`).
   *
   * The comparison is the last statement and runs on the raw derived bytes —
   * never on the hex strings, which would compare byte by byte and exit at the
   * first difference.
   */
  async verify(value: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) {
      return false
    }
    const separator = stored.indexOf(":")
    if (separator <= 0 || separator === stored.length - 1) {
      return false
    }
    const salt = fromHex(stored.slice(0, separator))
    const expected = fromHex(stored.slice(separator + 1))
    if (salt === null || expected === null) {
      return false
    }
    // The stored key must be exactly the length this context derives. Both sites
    // that write a hash use `keyBytes` or the stored length, so anything else is a
    // corrupt or forged row. Accepting a short one costs security: a one-byte key
    // has a 1-in-256 chance of matching *any* credential, so a truncated row is a
    // bypass with better odds than guessing.
    if (expected.length !== this.keyBytes) {
      return false
    }
    const actual = await this.derive(value, salt, expected.length)
    return this.compare(actual, expected)
  }

  /**
   * Constant-time equality for two caller-supplied strings of any length.
   *
   * Both sides are digested to a fixed 32 bytes under one `Promise.all`, before
   * any comparison and before any branch that observes the inputs, and only then
   * handed to `this.compare`. A length-dependent early return is therefore
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
    return this.compare(new Uint8Array(leftDigest), new Uint8Array(rightDigest))
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
