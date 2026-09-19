/**
 * Random-value generation for login factors.
 *
 * `getRandomDigit` is the only place in this package that turns random bytes
 * into a digit, and it does so by **rejection sampling**, not by `% 10`:
 *
 *  - `byte & 15` maps a byte onto 0–15 with no bias (16 divides 256 evenly);
 *  - a value above 9 is *discarded and redrawn*.
 *
 * The obvious alternative — accept every byte and take `byte % 10` — is biased:
 * 256 = 25×10 + 6, so digits 0–5 come up 26 times per 256 bytes and 6–9 only 25
 * times, a 4% relative advantage on six of the ten digits. An attacker who knows
 * the bias guesses a login factor measurably more often than 1-in-10 per digit,
 * and with a lockout that still shortens the search. Rejecting the six remainders
 * costs 6/256 of the draws — about 2.3% more bytes — and buys exact uniformity.
 *
 * The source (`roley/helpers.ts:84-91`) drew its digits from the engine's
 * non-cryptographic generator, whose internal state is not a login-grade secret
 * and whose output is predictable from a modest number of observations. Nothing
 * in this file reads a randomness source other than `crypto.getRandomValues`, and
 * a test greps these sources to keep it that way.
 */

import { DEFAULT_OTP_LENGTH } from "./constants.ts"

/** Writes random bytes into `target`, the window to draw digits from. */
export type RandomByteSource = (target: Uint8Array) => Uint8Array

/** Bytes requested per `getRandomString` draw block. */
const DRAW_BLOCK = 64

/** The largest value `byte & 15` can take: rejection keeps only 0–9. */
const MAX_ACCEPTED_NIBBLE = 9

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
/** 252 = 7 × 36: the largest multiple of 36 that fits in a byte. */
const BASE36_RANGE = 252

/** Options for the generators. `source` is a test seam; production omits it. */
export interface RandomOptions {
  /** Bytes to draw from. Defaults to the platform CSPRNG. */
  source?: RandomByteSource
}

function draw(source: RandomByteSource | undefined, size: number): Uint8Array {
  const target = new Uint8Array(size)
  // Bound on purpose: `crypto.getRandomValues` throws "expected Crypto" when it is
  // called with anything other than `crypto` as the receiver, so it must not be
  // passed around as a bare function reference.
  return source ? source(target) : crypto.getRandomValues(target)
}

/**
 * A single uniform decimal digit.
 *
 * Exported because it is the unit the rejection-sampling property is proven on.
 * The optional source exists so a test can drive an adversarial byte stream
 * through the exact production path; production always uses the default.
 */
export function getRandomDigit(options: RandomOptions = {}): string {
  for (;;) {
    const drawn = draw(options.source, 1)[0]
    const nibble = drawn & 15
    if (nibble <= MAX_ACCEPTED_NIBBLE) {
      return nibble.toString()
    }
  }
}

/** A uniform one-time password of `length` decimal digits. */
export function getRandomOtp(
  options: RandomOptions & { length?: number } = {},
): string {
  const length = options.length ?? DEFAULT_OTP_LENGTH
  let otp = ""
  for (let index = 0; index < length; index++) {
    otp += getRandomDigit(options)
  }
  return otp
}

/**
 * A uniform alphanumeric string of `length` characters.
 *
 * Replaces the source's `randomBytes(length / 2).toString('hex')`, which for an
 * odd `length` produced a string of the wrong size and for the session-length
 * default derived half the requested bytes. Bytes at or above 252 are redrawn
 * (`252 = 7 × 36`), so all 36 characters are equally likely.
 */
export function getRandomString(
  length: number,
  options: RandomOptions = {},
): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError("length must be a positive integer")
  }
  let result = ""
  while (result.length < length) {
    const block = draw(options.source, DRAW_BLOCK)
    for (const byte of block) {
      if (byte >= BASE36_RANGE) {
        continue
      }
      result += BASE36[byte % BASE36.length]
      if (result.length === length) {
        break
      }
    }
  }
  return result
}
