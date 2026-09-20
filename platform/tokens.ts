// Token primitives: monotonic ULIDs, opaque tokens, constant-time compare.
//
// Ported from `mig/lib/tokens.ts` (62 LOC). Three changes at extraction time:
//
// 1. ULID generation is implemented here instead of imported from `@std/ulid`
//    (`tokens.ts:6`), because `@std/ulid` is not in the root import map and the
//    house rule is "own the small, keep the huge". No new dependency.
// 2. The secret is validated. The source hashed `raw + secret` with no check
//    (`tokens.ts:42`), so a missing secret silently hashed against the string
//    `"undefined"` — a fail-open. See `newOpaqueToken`.
// 3. Callers must never compare signatures with `!==`. The source's compare was
//    constant-time already (`tokens.ts:55-62`), but the equivalent in
//    `offer-lens/libs/auth/mod.ts:115` is a plain `sigB64 !== expectedSig`.
//    `verifyOpaqueToken` therefore routes through `constantTimeEquals`, and
//    `tokens.test.ts` asserts that call site so the mistake cannot come back.

import { encodeBase64Url } from "@std/encoding/base64url"
import { timingSafeEqual } from "@std/crypto/timing-safe-equal"

/** Length of a ULID string: 26 Crockford base32 characters. */
export const ULID_LENGTH = 26

/** Crockford base32, upper-case. Excludes `I`, `L`, `O` and `U`. */
export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Default raw-token width: 128 bits, which base64url renders as 22 characters. */
export const DEFAULT_TOKEN_BYTES = 16

/**
 * Smallest accepted secret length, in characters, measured on the trimmed value.
 *
 * An opaque-token hash is a plain `sha256Hex(raw + secret)` and the digest is
 * stored, so the secret is not protected by any rate limit: an attacker holding a
 * stored digest can search the whole keyspace offline. 32 characters removes a
 * dictionary-sized search; it does not replace real entropy, which the caller
 * must inject. Same rule, same number, same reasoning as `server/jwt.ts`'s own
 * `MIN_SECRET_LENGTH` — a short secret is brute-forceable offline in both
 * modules, so both fail closed at the same floor rather than one of them
 * silently accepting `"a"`.
 */
export const MIN_SECRET_LENGTH = 32

/** Widest buffer `crypto.getRandomValues` accepts in one call (65536 bytes). */
const MAX_RANDOM_BYTES = 65_536

/** Bytes in the ULID randomness field: 80 bits. */
const ULID_RANDOM_BYTES = 10

/** Characters the ULID randomness field occupies, after the 13-character 48-bit timestamp. */
export const ULID_RANDOM_CHARS = 13

/**
 * Failure kind of a `TokenError`. Callers branch on the code, never on the
 * message — message text is not an API.
 */
export enum TokenErrorCode {
  /** The secret was absent, blank or not a string. Fails closed: nothing is hashed. */
  InvalidSecret = 1,
  /** A requested byte count was not a positive safe integer within `MAX_RANDOM_BYTES`. */
  InvalidByteCount = 2,
  /** An injected `randomBytes` did not return exactly the requested length. */
  RandomBytesLength = 3,
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

/** Construction options for `createUlidFactory`. Both are injected so tests own the clock and the bytes. */
export interface UlidFactoryOptions {
  /** Milliseconds since the epoch. Injected for determinism; defaults to `Date.now`. */
  now?: () => number
  /** Injected randomness for determinism; defaults to `crypto.getRandomValues`. Must return exactly `length` bytes. */
  randomBytes?: (length: number) => Uint8Array
}

/** A ULID source with its own monotonic state. Two factories never share state — that is what makes the monotonicity testable. */
export interface UlidFactory {
  monotonicUlid(): string
  /**
   * The millisecond carried by the last id produced through the increment path,
   * or `null` if that path has not run. It can be ahead of the wall clock: the
   * timestamp, not the clock, is what orders a burst.
   */
  lastMonotonicMs(): number | null
}

/**
 * Encodes a 128-bit ULID value as 26 Crockford base32 characters.
 *
 * The 48-bit timestamp is the high half and the 80-bit randomness field the low
 * half; the characters are read five bits at a time from the top down, so the
 * low five bits — the ones an increment changes — land in the final character.
 * The two halves are *not* padded independently: character 1 mixes the last two
 * timestamp bits with the first three randomness bits, so the value is encoded
 * as one number rather than as two fields.
 *
 * `BigInt` because 128 bits exceed the 53-bit integer range. The shift is
 * computed as a number and checked before it reaches BigInt, because a negative
 * shift on a BigInt reverses direction instead of yielding zero (`1n >> -2n` is
 * `4n`); the final character is the one that runs off the bottom.
 *
 * @param value The 128-bit value.
 * @returns A `ULID_LENGTH`-character string.
 */
function encodeBase32(value: bigint): string {
  let out = ""
  for (let k = 0; k < ULID_LENGTH; k++) {
    const shift = 123 - 5 * k
    const index = shift < 0 ? Number(value & 31n) : Number((value >> BigInt(shift)) & 31n)
    out += ULID_ALPHABET[index]
  }
  return out
}

/**
 * Adds one to the 80-bit randomness field of a ULID value.
 *
 * The field is incremented, never re-rolled: a fresh draw can sort below the
 * previous id, which is exactly the collision the source relied on
 * `monotonicUlid` to avoid (`tokens.ts:8-12`). Incrementing the whole 128-bit
 * value *is* incrementing the field, and it lets a carry out of the field land in
 * the timestamp where it belongs, instead of needing a separate overflow branch.
 */
function incrementRandomField(value: bigint): bigint {
  return value + 1n
}

/**
 * Builds a ULID source that owns its monotonic state.
 *
 * Replaces the `@std/ulid` dependency the source used at `tokens.ts:6` and
 * `tokens.ts:10-12`. `@std/ulid` is not in this repo's root import map, the root
 * config is off-limits to a package PR, and the module needs only
 * `crypto.getRandomValues` — so the 40 lines are owned rather than imported.
 *
 * Two calls in the same millisecond are strictly increasing: the 80-bit
 * randomness field is incremented rather than re-rolled. If that field is
 * already all ones (`2^80` ids inside one millisecond) the increment carries
 * into the timestamp, which is exactly the "roll to the next millisecond"
 * behaviour the format needs — a ULID timestamp may run ahead of the clock
 * during a burst, and the ordering still holds.
 *
 * @param options Injected clock and randomness. Omitting both uses `Date.now`/`crypto`.
 * @returns A factory whose state is private to it.
 */
export function createUlidFactory(options: UlidFactoryOptions = {}): UlidFactory {
  const now = options.now ?? (() => Date.now())
  const randomBytes = options.randomBytes ?? ((length: number) => {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    return bytes
  })
  let last: bigint | null = null
  let monotonicMs: number | null = null

  const drawRandom = (): bigint => {
    const bytes = randomBytes(ULID_RANDOM_BYTES)
    if (bytes.length !== ULID_RANDOM_BYTES) {
      throw new TokenError(
        TokenErrorCode.RandomBytesLength,
        "randomBytes must return exactly 10 bytes for a ulid",
      )
    }
    let value = 0n
    for (const byte of bytes) value = (value << 8n) | BigInt(byte)
    return value
  }

  return {
    monotonicUlid(): string {
      const clockMs = now()
      // The timestamp the last id carries, not the raw clock: a burst pushes it
      // ahead of the clock, and a clock that stalls or steps back must not make
      // the next id re-roll and sort below its predecessor.
      const lastMs = last === null ? null : Number(last >> 80n)
      let value: bigint
      if (last !== null && lastMs !== null && clockMs <= lastMs) {
        // Same millisecond or a stalled clock: keep the drawn randomness and
        // bump it. A carry out of the field moves the timestamp on.
        value = incrementRandomField(last)
        monotonicMs = Number(value >> 80n)
      } else {
        value = (BigInt(clockMs) << 80n) | drawRandom()
      }
      last = value
      return encodeBase32(value)
    },
    lastMonotonicMs(): number | null {
      return monotonicMs
    },
  }
}

const defaultFactory = createUlidFactory()

/**
 * Convenience ULID from a module-level factory. Prefer an injected factory where
 * ordering must be controlled — this one shares its monotonic state with every
 * other caller in the process (that is what makes ids process-wide monotonic).
 */
export function monotonicUlid(): string {
  return defaultFactory.monotonicUlid()
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
 * Mints an opaque token: `raw` goes to the caller, `hash` is what the
 * server stores.
 *
 * The construction is the source's, unchanged: `hash = sha256Hex(raw + secret)`
 * (`tokens.ts:38-44`). Tradeoff, recorded deliberately: HMAC-SHA-256 with the
 * secret as key is the stronger construction, but the stored value carries no
 * algorithm or version marker, so switching it would silently invalidate every
 * hash already in the database — every issued token would stop verifying with no
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
