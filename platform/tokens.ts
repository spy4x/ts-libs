// Token primitives: monotonic ULIDs, opaque tokens, constant-time compare.
//
// Ported from `mig/lib/tokens.ts` (62 LOC). Two behaviour changes at extraction time, plus a third
// once `@std/ulid` joined the root import map:
//
// 1. The secret is validated. The source hashed `raw + secret` with no check
//    (`tokens.ts:42`), so a missing secret silently hashed against the string
//    `"undefined"` — a fail-open. See `newOpaqueToken`.
// 2. Callers must never compare signatures with `!==`. The source's compare was
//    constant-time already (`tokens.ts:55-62`), but the equivalent in
//    `offer-lens/libs/auth/mod.ts:115` is a plain `sigB64 !== expectedSig`.
//    `verifyOpaqueToken` therefore routes through `constantTimeEquals`, and
//    `tokens.test.ts` asserts that call site so the mistake cannot come back.
// 3. ULID generation is `@std/ulid`'s `monotonicUlid`, not a hand-written encoder. The encoder
//    existed only because `@std/ulid` was missing from the root import map; issue #70 added the
//    pin, and "own the small, keep the huge" means a hand-rolled ULID stops being the right call
//    once the stdlib package is pinned.

import { encodeBase64Url } from "@std/encoding/base64url"
import { timingSafeEqual } from "@std/crypto/timing-safe-equal"

/**
 * Monotonic ULID generator, re-exported from `@std/ulid`.
 *
 * Shares its monotonic state with every other caller in the process — that is what makes ids
 * process-wide monotonic — and accepts an optional seed time for a caller that wants a
 * deterministic timestamp component.
 */
export { monotonicUlid } from "@std/ulid"

/** Length of a ULID string: 26 Crockford base32 characters. */
export const ULID_LENGTH = 26

/** Default raw-token width: 128 bits, which base64url renders as 22 characters. */
export const DEFAULT_TOKEN_BYTES = 16

/**
 * Smallest accepted secret length, in characters, measured on the trimmed value.
 *
 * An opaque-token hash is a plain `sha256Hex(raw + secret)` and the digest is stored, so the
 * secret is not protected by any rate limit: an attacker holding a stored digest can search the
 * whole keyspace offline. 32 characters removes a dictionary-sized search; it does not replace
 * real entropy, which the caller must inject. A short secret is brute-forceable offline, so this
 * fails closed at that floor rather than silently accepting `"a"`.
 */
export const MIN_SECRET_LENGTH = 32

/** Widest buffer `crypto.getRandomValues` accepts in one call (65536 bytes). */
const MAX_RANDOM_BYTES = 65_536

/**
 * Failure kind of a `TokenError`. Callers branch on the code, never on the
 * message — message text is not an API.
 */
export enum TokenErrorCode {
  /** The secret was absent, blank or not a string. Fails closed: nothing is hashed. */
  InvalidSecret = 1,
  /** A requested byte count was not a positive safe integer within `MAX_RANDOM_BYTES`. */
  InvalidByteCount = 2,
}

/**
 * Typed error for token primitives. Messages are constants, so no error path can
 * echo secret material or a hash preimage into a log or a stack trace.
 */
export class TokenError extends Error {
  readonly code: TokenErrorCode

  constructor(code: TokenErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TokenError"
    this.code = code
  }
}

/**
 * Decodes an even-length lower-case hex string to bytes, or `null` when it is not
 * exactly that.
 *
 * Odd length is rejected rather than left-padded: `"0"` and `"00"` describe the
 * same byte but are different stored values. Upper case is rejected too: a
 * digest is a lower-case string, so `ABC` and `abc` are not the same stored
 * value, and accepting both would make two distinct records compare equal.
 * `parseInt` also accepts a leading `+`, a space and `0x`, so the character
 * pattern decides, not `parseInt`.
 */
function decodeDigestHex(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < value.length; i += 2) {
    const pair = value.slice(i, i + 2)
    if (!/^[0-9a-f]{2}$/.test(pair)) return null
    bytes[i / 2] = Number.parseInt(pair, 16)
  }
  return bytes
}

/**
 * Compares two hex digests in constant time.
 *
 * Both sides are SHA-256'd first (the length check on the digests, never on the
 * arguments) so a truncated or non-hex stored hash cannot steer the comparison
 * into an early exit or change how many bytes `timingSafeEqual` touches. Both
 * arguments are always digested to 32 bytes before a single decision is made.
 *
 * @param a A hex digest, or any string.
 * @param b A hex digest, or any string.
 * @returns `true` only on identical digests. Never throws.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  if (typeof a !== "string" || typeof b !== "string") return false
  // An empty string decodes to zero bytes and would otherwise be "equal" to any
  // other empty string; a digest is never empty.
  if (a === "" || b === "") return false
  const left = decodeDigestHex(a)
  const right = decodeDigestHex(b)
  if (left === null || right === null) return false
  if (left.length !== right.length) return false
  const [leftDigest, rightDigest] = await Promise.all([sha256Bytes(left), sha256Bytes(right)])
  return timingSafeEqual(leftDigest, rightDigest)
}

/** SHA-256 as bytes. Internal: callers get hex. */
async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)))
}

/**
 * Compares two arbitrary strings in constant time.
 *
 * Both sides are SHA-256 digested first, so the comparison always runs over
 * two 32-byte digests regardless of input length — neither the length nor a
 * shared prefix of either argument can be probed by timing. An empty string
 * never verifies, even against another empty string, so a caller that forgot
 * to configure a secret cannot succeed by presenting nothing.
 *
 * This is the text-comparison counterpart to {@link constantTimeEquals} above,
 * which decodes both sides as hex digests first and rejects anything that is
 * not valid hex. Use this function for unstructured text — a bearer token, a
 * password-reset code, anything that is not already a digest.
 *
 * @param a Any string.
 * @param b Any string.
 * @returns `true` when both strings are non-empty and encode to the same UTF-8 bytes. Unpaired
 *     surrogates all encode as U+FFFD, so `"\uD800"` and `"\uDBFF"` compare equal.
 * @throws {TypeError} As a rejected promise, when an argument is `null` or `undefined`.
 */
export async function constantTimeEqualsText(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) return false
  const [digestA, digestB] = await Promise.all([
    sha256Bytes(new TextEncoder().encode(a)),
    sha256Bytes(new TextEncoder().encode(b)),
  ])
  // Digests are fixed width by construction, but keep the guard so a future
  // change cannot turn `timingSafeEqual` into a silent `false`.
  if (digestA.byteLength !== digestB.byteLength) return false
  return timingSafeEqual(digestA, digestB)
}

/**
 * Concatenated digest `sha256hex(raw + secret)`, lower-case, 64 characters.
 *
 * A caller-supplied hash is compared as-is, so an upper-case stored hash is a
 * mismatch — normalise at the storage boundary, not here.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await sha256Bytes(new TextEncoder().encode(input))
  let hex = ""
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/**
 * Cryptographically random bytes, base64url, unpadded.
 *
 * @param bytes Positive safe integer, at most 65536. Defaults to `DEFAULT_TOKEN_BYTES`.
 * @throws {TokenError} `InvalidByteCount` for a non-integer, non-positive or oversized count.
 */
export function randomBase64Url(bytes: number = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_RANDOM_BYTES) {
    throw new TokenError(TokenErrorCode.InvalidByteCount, "bytes must be a positive integer")
  }
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return encodeBase64Url(buffer)
}

/**
 * Rejects any secret that would make the digest meaningless or brute-forceable.
 *
 * The source did not check at all (`tokens.ts:38-44`), so `newOpaqueToken()` with
 * no argument hashed against the literal `"undefined"` and produced a token any
 * caller could forge. Fail closed instead: an unusable secret is a programming
 * error, not a warning.
 *
 * Two ways a secret is unusable, both checked on the trimmed value so a secret of
 * nothing but whitespace cannot pass on length alone: 1) absent, or not a
 * printable string — the value may arrive from untyped configuration, and a
 * secret made of NUL bytes or other control characters is a placeholder, not
 * entropy, so `"\u0000".repeat(64)` is rejected even though it is long enough;
 * 2) shorter than {@link MIN_SECRET_LENGTH}.
 *
 * @throws {TokenError} `InvalidSecret` when the secret is missing, blank, not a
 *         string, not printable, or below {@link MIN_SECRET_LENGTH} characters.
 *         Messages are constants — the rejected value is never echoed.
 */
function assertUsableSecret(secret: string): void {
  if (typeof secret !== "string") {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be a non-empty string")
  }
  const trimmed = secret.trim()
  if (trimmed === "" || !isPrintable(trimmed)) {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be a non-empty string")
  }
  if (trimmed.length < MIN_SECRET_LENGTH) {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be at least 32 characters")
  }
}

/** True when every character is printable ASCII (`0x20`-`0x7E`). */
function isPrintable(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) as number
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/**
 * Mints an opaque token: `raw` goes to the caller, `hash` is what the server
 * stores.
 *
 * The construction is the source's, unchanged: `hash = sha256Hex(raw + secret)`
 * (`tokens.ts:38-44`). Tradeoff, recorded deliberately: HMAC-SHA-256 with the
 * secret as key is the stronger construction, but the stored value carries no
 * algorithm or version marker, so switching it would silently invalidate every
 * hash already in the database — all links would stop working with no
 * diagnostic. Keeping the concatenated digest is safe *here* because the raw
 * token is 128 random bits and verification compares the full 64-character
 * digest, so the length-extension property a concatenated digest exposes cannot
 * forge a token: an attacker would still have to reproduce a digest they cannot
 * see. Revisit only with a versioned hash column and a migration.
 *
 * @param secret Server-side secret of at least {@link MIN_SECRET_LENGTH} characters. Never logged,
 *     never stored in the result.
 * @throws {TokenError} `InvalidSecret` when the secret is blank or too short.
 */
export async function newOpaqueToken(secret: string): Promise<{ raw: string; hash: string }> {
  assertUsableSecret(secret)
  const raw = randomBase64Url(DEFAULT_TOKEN_BYTES)
  const hash = await sha256Hex(raw + secret)
  return { raw, hash }
}

/**
 * Recomputes `sha256Hex(raw + secret)` and compares it to the stored hash via
 * `constantTimeEquals` — never `===`, never `!==` (the shape that made
 * `offer-lens/libs/auth/mod.ts:115` timing-unsafe).
 *
 * Returns `false` for every malformed input rather than throwing: a wrong raw
 * token, a wrong secret, an empty, truncated, upper-case, non-hex or unusual
 * length hash. A `TypeError` from a bad `hash` would be a second, observable
 * outcome for the same question, and its timing would leak the parse step.
 *
 * @param raw The token from the caller's link.
 * @param hash The stored digest.
 * @param secret Server-side secret of at least {@link MIN_SECRET_LENGTH} characters.
 * @throws {TokenError} `InvalidSecret` when the secret is blank or too short.
 */
export async function verifyOpaqueToken(
  raw: string,
  hash: string,
  secret: string,
): Promise<boolean> {
  assertUsableSecret(secret)
  const computed = await sha256Hex(raw + secret)
  return await constantTimeEquals(computed, hash)
}
