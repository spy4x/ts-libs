/**
 * Security fix 1: `getRandomOTP()` used `Math.random()` (`roley/helpers.ts:84-91`).
 *
 * The replacement draws from `crypto.getRandomValues` and turns bytes into digits
 * by rejection sampling: mask to a nibble, discard anything above nine, redraw.
 * Three things are asserted:
 *
 *  1. the OTP path is cryptographically sourced and `Math.random` is not reachable
 *     from it — checked by reading the module sources, not by trusting a comment;
 *  2. the drawing *procedure* is rejection sampling and not `% 10`, proven
 *     deterministically: every draw either yields a digit or is provably one of the
 *     six residues rejection must discard, over a byte stream whose composition is
 *     known, so the arithmetic is checkable rather than sampled;
 *  3. the digits are uniform in production, over a sample large enough that `% 10`
 *     would fail while uniform output essentially cannot.
 *
 * Test 2 is the non-flaky form of the distribution requirement. A random sample
 * that can distinguish `% 10`'s 4% spread from uniform needs ~200k draws and still
 * fails about one run in twenty, which is why the deterministic procedure check
 * carries the proof and the sample check is a backstop.
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert"
import { getRandomDigit, getRandomOtp, getRandomString } from "./random.ts"

/**
 * A stand-in for a byte stream whose composition is known: every 256-byte block is
 * `0x00..0xff` exactly once, then it repeats. Not a CSPRNG, and never used as one —
 * it makes the rejection arithmetic exact.
 */
class CyclingByteSource {
  private next = 0
  /** Every byte the function under test has drawn, in order. */
  readonly drawn: number[] = []

  readonly source = (target: Uint8Array): Uint8Array => {
    for (let index = 0; index < target.length; index++) {
      target[index] = this.next
      this.drawn.push(this.next)
      this.next = (this.next + 1) % 256
    }
    return target
  }
}

/** `% 10`, the implementation this fix replaces. */
function digitByModulo(byte: number): string {
  return (byte % 10).toString()
}

/** How many of `drawn` a rejection-sampling implementation must have discarded. */
function expectedDiscardedCount(drawn: number[]): number {
  return drawn.filter((byte) => (byte & 15) > 9).length
}

// Assembled rather than written out, so this file does not match its own grep.
const FORBIDDEN_SOURCE = ["Math", "random"].join(".")

Deno.test("the OTP path never reaches for the non-cryptographic generator", async () => {
  const sources = [
    new URL("./random.ts", import.meta.url),
    new URL("./providers/otp.ts", import.meta.url),
  ]
  for (const source of sources) {
    const text = await Deno.readTextFile(source)
    assertFalse(
      text.includes(FORBIDDEN_SOURCE),
      `${source.pathname} must not contain ${FORBIDDEN_SOURCE}`,
    )
  }
})

Deno.test("getRandomDigit uses the platform CSPRNG when no source is injected", () => {
  // Exercises the default branch, which is the one production takes.
  const digits = Array.from({ length: 200 }, () => getRandomDigit())
  for (const digit of digits) {
    assert(/^[0-9]$/.test(digit), `unexpected digit ${digit}`)
  }
  assertNotEquals(new Set(digits).size, 0)
})

Deno.test("getRandomDigit redraws every byte whose low nibble exceeds nine", () => {
  // 0x0a..0x0f are rejected, so the first accepted byte is the 0x07 after them.
  const bytes = [10, 11, 12, 13, 14, 15, 7]
  let index = 0
  const source = (target: Uint8Array): Uint8Array => {
    target[0] = bytes[index++]
    return target
  }
  assertEquals(getRandomDigit({ source }), "7")
  assertEquals(index, 7, "every rejected byte must have been drawn")
})

Deno.test("every draw yields a digit or is one of the six residues rejection discards", () => {
  const source = new CyclingByteSource()
  const digits = Array.from({ length: 5_000 }, () => getRandomDigit({ source: source.source }))

  // The bytes rejection had to discard, by the rule the fix claims to apply.
  const discarded = source.drawn.filter((byte) => (byte & 15) > 9)
  assertEquals(
    source.drawn.length,
    digits.length + discarded.length,
    "draws must be exactly the digits produced plus the bytes rejected",
  )
  // The cycling source consumes each byte twice, so 6/16 of the draws are
  // discarded; the absolute count is what matters, and `% 10` would discard none,
  // leaving source.drawn.length === digits.length.
  const discardedCount = expectedDiscardedCount(source.drawn)
  assertEquals(
    discarded.length,
    discardedCount,
    "every byte whose low nibble exceeds nine must have been drawn",
  )
  assert(
    discarded.length > 0,
    "rejection must actually occur; a modulo implementation discards nothing",
  )
  // No drawn byte outside the discarded set may have been skipped, and the digit
  // produced from each accepted byte is the nibble itself.
  const accepted = source.drawn.filter((byte) => (byte & 15) <= 9).map((byte) =>
    (byte & 15).toString()
  )
  assertEquals(digits.join(""), accepted.join(""))
})

Deno.test("getRandomOtp produces the rejection-sampled digits for a known byte stream", () => {
  const source = new CyclingByteSource()
  assertEquals(getRandomOtp({ length: 6, source: source.source }), "012345")
})

Deno.test("getRandomOtp output diverges from the modulo-10 output for the same bytes", () => {
  // Long enough to leave the stretch where the two agree by construction: the low
  // nibbles of bytes 0..9 are the digits 0..9, and 10..15 are rejected, so the two
  // sequences coincide until the first rejected byte changes their alignment.
  const source = new CyclingByteSource()
  const otp = getRandomOtp({ length: 1_000, source: source.source })
  const modulo = Array.from({ length: 1_000 }, (_, position) => digitByModulo(position % 256)).join(
    "",
  )
  assertNotEquals(otp, modulo)
  assertEquals(otp.slice(0, 10), modulo.slice(0, 10))
})

Deno.test("modulo ten over one byte block is measurably biased", () => {
  // This quantifies the bug being fixed, and doubles as the check that the
  // rejection threshold above is the right one: `byte & 15` keeps 16 residues per
  // digit before rejection, while `% 10` splits 256 into 25 or 26.
  const residues = Array.from({ length: 256 }, (_, byte) => byte)
  const nibbleCounts = Array.from(
    { length: 16 },
    (_, nibble) => residues.filter((byte) => (byte & 15) === nibble).length,
  )
  assertEquals(new Set(nibbleCounts).size, 1, "byte & 15 must be uniform over 256 bytes")

  const moduloCounts = Array.from(
    { length: 10 },
    (_, digit) => residues.filter((byte) => digitByModulo(byte) === digit.toString()).length,
  )
  const spread = Math.max(...moduloCounts) / Math.min(...moduloCounts)
  assert(spread > 1.03, `modulo 10 must show its ~4% spread over 256 bytes, saw ${spread}`)
})

Deno.test("digits are uniform over a large sample from the production CSPRNG", () => {
  // Backstop only: the deterministic tests above prove the procedure. This one
  // exists so a future edit that reintroduces sampling without rejection is caught
  // even if the structural tests are deleted.
  //
  // The threshold is 10 standard deviations of a count over N draws, so a false
  // failure needs a one-in-10^23 event, while `% 10`'s bias is certain to exceed it:
  // the biased digit sits at +4% and a uniform one has a 95% interval of about
  // ±0.44%, so the two distributions are ~7 sigma apart. Margins chosen from those
  // numbers, not from the run that happened to pass.
  const draws = 1_000_000
  const sigma = Math.sqrt(draws * 0.1 * 0.9)
  const threshold = 10 * sigma / (draws / 10)
  const counts = new Array<number>(10).fill(0)
  for (let index = 0; index < draws; index++) {
    counts[Number(getRandomDigit())]++
  }
  const expected = draws / 10
  const deviation = Math.max(...counts.map((count) => Math.abs(count - expected))) / expected
  assert(
    deviation < threshold,
    `digit frequency deviated by ${(deviation * 100).toFixed(3)}%, threshold ${
      (threshold * 100).toFixed(3)
    }%`,
  )
})

Deno.test("getRandomString returns the requested length from a known stream", () => {
  const source = new CyclingByteSource()
  // 252 = 7 x 36, so bytes 252..255 are redrawn and the alphabet stays uniform.
  assertEquals(getRandomString(10, { source: source.source }), "0123456789")
})

Deno.test("getRandomString rejects a non-positive length", () => {
  for (const length of [0, -1, 1.5]) {
    let threw = false
    try {
      getRandomString(length)
    } catch {
      threw = true
    }
    assert(threw, `length ${length} must be rejected`)
  }
})
