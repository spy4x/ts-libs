// Behaviour tests for `platform/tokens.ts`.
//
// Every test injects the clock and the randomness: no `Date.now()` in an
// assertion path, no sleeps, no network, no writes, no env reads. The suite
// needs `--allow-read` only because two cases read this module's own source to
// pin the constant-time primitive and its call site.

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert"
import {
  constantTimeEquals,
  createUlidFactory,
  DEFAULT_TOKEN_BYTES,
  MIN_SECRET_LENGTH,
  monotonicUlid,
  newCancelToken,
  randomBase64Url,
  sha256Hex,
  type TokenError,
  TokenErrorCode,
  ULID_ALPHABET,
  ULID_LENGTH,
  ULID_RANDOM_CHARS,
  verifyCancelToken,
} from "./tokens.ts"

/** Frozen clock used by every ULID test: 2023-11-14T22:13:20.000Z. */
const FIXED_MS = 1_700_000_000_000

/** The first id a frozen-clock, all-zero-randomness factory must produce. Computed once, pinned forever. */
const FIRST_FIXED_ULID = "065WZSB8000000000000000000"

/** Obviously fake secret fixtures. Long enough for `MIN_SECRET_LENGTH`, never a realistic key shape. */
const SECRET = "test-secret-not-real-0123456789abcdef"
const OTHER_SECRET = "another-test-secret-0123456789abcdef"

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Randomness source that always returns zeroed bytes of the requested length, and counts its calls. */
function zeroRandom(counter?: { calls: number }): (length: number) => Uint8Array {
  return (length) => {
    if (counter) counter.calls += 1
    return new Uint8Array(length)
  }
}

/** Flips one hex character of a digest so the result is guaranteed to differ. */
function flipHex(digest: string, index = 0): string {
  const original = digest[index]
  return digest.slice(0, index) + (original === "0" ? "1" : "0") + digest.slice(index + 1)
}

/** Frozen-clock factory whose randomness is a constant byte, so only the timestamp and the increment can order ids. */
function fixedFactory(byte = 0, counter?: { calls: number }) {
  return createUlidFactory({
    now: () => FIXED_MS,
    randomBytes: (length) => {
      if (counter) counter.calls += 1
      return new Uint8Array(length).fill(byte)
    },
  })
}

/**
 * Reference Crockford base32 encoder, written from the ULID arithmetic itself
 * rather than copied from `tokens.ts`, so a bug in the module cannot agree with
 * it. It is pinned by the `FIRST_FIXED_ULID` assertion below.
 */
function base32(value: bigint): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  let out = ""
  for (let i = 0; i < 26; i++) {
    const shift = 128 - 5 * i - 5
    out += alphabet[shift < 0 ? Number(value % 32n) : Number((value >> BigInt(shift)) & 31n)]
  }
  return out
}

/** The largest id a millisecond can express: 48-bit big-endian ms plus an all-ones randomness field. */
function largestIdForMs(ms: number): string {
  return base32((BigInt(ms) << 80n) | ((1n << 80n) - 1n))
}

/**
 * Strips block and line comments from source text.
 *
 * Source-reading assertions must never be satisfiable by a comment: a reviewer
 * can add `// timingSafeEqual(leftDigest, rightDigest)` or comment out a
 * hand-rolled loop, and a naive `includes()` would stay green while the
 * implementation got weaker. String and template literals are preserved.
 */
function stripComments(source: string): string {
  let out = ""
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1
    } else if (char === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1
      i += 2
    } else if (char === '"' || char === "'" || char === "`") {
      const quote = char
      out += char
      i += 1
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "")
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
    } else {
      out += char
      i += 1
    }
  }
  return out
}

/** Reads `./tokens.ts` next to this test file with its comments removed. */
async function readModuleSourceWithoutComments(): Promise<string> {
  const source = await Deno.readTextFile(new URL("./tokens.ts", import.meta.url))
  return stripComments(source)
}

/**
 * Slices a function declaration's body out of source text by brace matching.
 *
 * @param source Source text, expected comment-free.
 * @param signature The declaration line prefix, e.g. `export async function x(`.
 * @returns The text from the opening brace to its matching close.
 */
function sliceFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert(start >= 0, `${signature} is no longer declared`)
  const bodyStart = source.indexOf("{", start)
  assert(bodyStart >= 0, `${signature} has no body`)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${signature}`)
}

/** Every line of a code snippet that uses `===` or `!==` (not `==`/`!=`, which are separate faults). */
function strictComparisons(code: string): string[] {
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("===") || line.includes("!=="))
}

Deno.test("monotonicUlid — id is 26 Crockford base32 characters", () => {
  const id = fixedFactory().monotonicUlid()
  assertEquals(id.length, ULID_LENGTH)
  assertEquals(ULID_PATTERN.test(id), true)
  for (const excluded of ["I", "L", "O", "U"]) {
    assertFalse(id.includes(excluded), `excluded character ${excluded} appeared in ${id}`)
  }
  assertEquals(ULID_ALPHABET.length, 32)
})

Deno.test("monotonicUlid — the module-level source yields ordered distinct 26-character ids", () => {
  const first = monotonicUlid()
  const second = monotonicUlid()
  for (const id of [first, second]) {
    assertEquals(id.length, ULID_LENGTH)
    assertEquals(ULID_PATTERN.test(id), true)
  }
  // The default clock and randomness are real, so assert the ordering property
  // rather than a value. `>=` is the contract: strictly increasing in practice,
  // never decreasing.
  assert(first !== second, `two module-level ids were identical: ${first}`)
  assert(second >= first, `${second} sorted below ${first}`)
})

Deno.test("monotonicUlid — 100 ids in one frozen millisecond are strictly increasing and distinct", () => {
  const factory = fixedFactory()
  const ids: string[] = []
  for (let i = 0; i < 100; i++) ids.push(factory.monotonicUlid())
  assertEquals(ids[0], FIRST_FIXED_ULID)
  assertEquals(new Set(ids).size, 100)
  for (let i = 1; i < ids.length; i++) {
    assert(ids[i] > ids[i - 1], `id ${i} (${ids[i]}) did not sort after ${ids[i - 1]}`)
    assertEquals(ULID_PATTERN.test(ids[i]), true)
  }
})

Deno.test("monotonicUlid — an exhausted randomness field carries into the timestamp", () => {
  const clock = FIXED_MS
  let call = 0
  const factory = createUlidFactory({
    now: () => clock,
    randomBytes: (length) => new Uint8Array(length).fill(call++ === 0 ? 0xff : 0x00),
  })
  const topOfMillisecond = factory.monotonicUlid()
  assertEquals(topOfMillisecond, largestIdForMs(FIXED_MS))
  // The field cannot be incremented any further, so the carry has to move the
  // timestamp instead of the randomness wrapping to all zeros and sorting
  // backwards. The values below are the exact ids the increment produces.
  const carried = factory.monotonicUlid()
  assert(carried > topOfMillisecond, `${carried} did not sort after ${topOfMillisecond}`)
  assertEquals(carried, base32(BigInt(FIXED_MS + 1) << 80n))
  assertEquals(carried.slice(0, ULID_LENGTH - ULID_RANDOM_CHARS), "065WZSB804000")
  assertEquals(carried.slice(ULID_LENGTH - ULID_RANDOM_CHARS), "0000000000000")

  // Timestamp dominance: an id of t+1 sorts after every id of t, including the
  // largest one t can express, and the clock never moved.
  const afterCarry = factory.monotonicUlid()
  assert(afterCarry > largestIdForMs(FIXED_MS), `${afterCarry} sorted below t=${FIXED_MS}`)
  assert(afterCarry > carried, `${afterCarry} did not sort after ${carried}`)
  assertEquals(afterCarry, base32((BigInt(FIXED_MS + 1) << 80n) | 1n))
  assertEquals(clock, FIXED_MS)
  // The carry path, not a clock step, advanced the monotonic millisecond.
  assertEquals(factory.lastMonotonicMs(), FIXED_MS + 1)
})

Deno.test("monotonicUlid — the increment, not the randomness, orders ids in a millisecond", () => {
  let draw = 0
  const factory = createUlidFactory({
    now: () => FIXED_MS,
    // Deliberately anti-correlated randomness: a re-roll would sort below the previous id.
    randomBytes: (length) => new Uint8Array(length).fill(draw++ === 0 ? 0xff : 0x00),
  })
  const first = factory.monotonicUlid()
  const second = factory.monotonicUlid()
  assert(second > first, `${second} did not sort after ${first} despite the same millisecond`)
  assertEquals(draw, 1)
})

Deno.test("monotonicUlid — two factories do not share monotonic state", () => {
  const left = fixedFactory()
  const right = fixedFactory()
  const leftIds = [left.monotonicUlid(), left.monotonicUlid()]
  const rightIds = [right.monotonicUlid(), right.monotonicUlid()]
  assertEquals(leftIds, rightIds)
  assertEquals(leftIds, [FIRST_FIXED_ULID, "065WZSB8000000000000000001"])
})

Deno.test("monotonicUlid — randomness is drawn once per millisecond on the increment path", () => {
  const counter = { calls: 0 }
  const factory = fixedFactory(0, counter)
  for (let i = 0; i < 100; i++) factory.monotonicUlid()
  assertEquals(counter.calls, 1)
  assertEquals(factory.lastMonotonicMs(), FIXED_MS)
})

Deno.test("monotonicUlid — a fresh millisecond draws randomness again", () => {
  const counter = { calls: 0 }
  let clock = FIXED_MS
  const factory = createUlidFactory({ now: () => clock, randomBytes: zeroRandom(counter) })
  factory.monotonicUlid()
  clock = FIXED_MS + 1
  factory.monotonicUlid()
  assertEquals(counter.calls, 2)
})

Deno.test("monotonicUlid — an injected randomness source of the wrong length is rejected", () => {
  const factory = createUlidFactory({ now: () => FIXED_MS, randomBytes: () => new Uint8Array(4) })
  const error = assertThrows(() => factory.monotonicUlid(), Error)
  assertInstanceOf(error, Error)
  assertEquals((error as TokenError).code, TokenErrorCode.RandomBytesLength)
  assertEquals(error.message, "randomBytes must return exactly 10 bytes for a ulid")
})

Deno.test("randomBase64Url — 16 bytes is 22 unpadded url-safe characters", () => {
  const token = randomBase64Url()
  assertEquals(token.length, 22)
  assertEquals(DEFAULT_TOKEN_BYTES, 16)
  assert(/^[A-Za-z0-9_-]+$/.test(token))
  for (const excluded of ["+", "/", "="]) {
    assertFalse(token.includes(excluded), `base64url output must not contain ${excluded}`)
  }
  assertEquals(new Set(Array.from({ length: 100 }, () => randomBase64Url())).size, 100)
})

Deno.test("randomBase64Url — 1 and 32 bytes stay unpadded and fully random", () => {
  const one = randomBase64Url(1)
  assertEquals(one.length, 2)
  assertFalse(one.includes("="))
  const wide = randomBase64Url(32)
  assertEquals(wide.length, 43)
  assert(/^[A-Za-z0-9_-]+$/.test(wide))
  assertFalse(wide.includes("="))
})

Deno.test("randomBase64Url — rejects a zero, negative, fractional or absurd byte count", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, 65_537]) {
    const error = assertThrows(() => randomBase64Url(bad), Error)
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidByteCount)
  }
})

Deno.test("sha256Hex — matches the published digest of the empty string", async () => {
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
})

Deno.test("sha256Hex — matches the published digest of a known ASCII input", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
  assertEquals((await sha256Hex("abc")).length, 64)
})

Deno.test("newCancelToken — raw is base64url and hash is 64 lower-case hex characters", async () => {
  const { raw, hash } = await newCancelToken(SECRET)
  assert(/^[A-Za-z0-9_-]+$/.test(raw))
  assertEquals(raw.length, 22)
  assertFalse(raw.includes("="))
  assert(/^[0-9a-f]{64}$/.test(hash))
})

Deno.test("newCancelToken — two calls differ and the hash is sha256Hex(raw + secret)", async () => {
  const first = await newCancelToken(SECRET)
  const second = await newCancelToken(SECRET)
  assert(first.raw !== second.raw)
  assert(first.hash !== second.hash)
  assertEquals(first.hash, await sha256Hex(first.raw + SECRET))
  assertEquals(second.hash, await sha256Hex(second.raw + SECRET))
})

Deno.test("newCancelToken — a blank secret fails closed", async () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const error = await assertRejects(() => newCancelToken(blank), Error)
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidSecret)
    assertEquals(error.message, "secret must be a non-empty string")
  }
})

Deno.test("newCancelToken — a secret below the 32-character floor fails closed", async () => {
  assertEquals(MIN_SECRET_LENGTH, 32)
  const tooShort = ["a", "a".repeat(MIN_SECRET_LENGTH - 1)]
  for (const secret of tooShort) {
    const error = await assertRejects(() => newCancelToken(secret), Error)
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidSecret)
    assertEquals(error.message, "secret must be at least 32 characters")
  }
  // Length is measured on the trimmed value, so padding cannot smuggle a short
  // secret past the floor.
  const padded = " ".repeat(40) + "a".repeat(MIN_SECRET_LENGTH - 1)
  const paddedError = await assertRejects(() => newCancelToken(padded), Error)
  assertEquals((paddedError as TokenError).code, TokenErrorCode.InvalidSecret)

  const accepted = await newCancelToken("a".repeat(MIN_SECRET_LENGTH))
  assert(/^[0-9a-f]{64}$/.test(accepted.hash))
})

Deno.test("newCancelToken — a NUL or control-character secret fails closed whatever its length", async () => {
  for (
    const secret of ["\u0000", "\u0000".repeat(64), `test-secret-not-real${"\u0007"}0123456789`]
  ) {
    const error = await assertRejects(() => newCancelToken(secret), Error)
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidSecret)
    assertEquals(error.message, "secret must be a non-empty string")
  }
})

Deno.test("verifyCancelToken — accepts a round-tripped token", async () => {
  const { raw, hash } = await newCancelToken(SECRET)
  assertEquals(await verifyCancelToken(raw, hash, SECRET), true)
})

Deno.test("verifyCancelToken — rejects a wrong secret, a wrong raw token and a tampered hash", async () => {
  const { raw, hash } = await newCancelToken(SECRET)
  assertEquals(await verifyCancelToken(raw, hash, OTHER_SECRET), false)
  assertEquals(await verifyCancelToken("test-secret-not-real-raw-0123456789", hash, SECRET), false)
  const tampered = flipHex(hash)
  assertEquals(await verifyCancelToken(raw, tampered, SECRET), false)
  assertEquals(await verifyCancelToken(raw, hash.toUpperCase(), SECRET), false)
})

Deno.test("verifyCancelToken — rejects a truncated, prefixed, empty or non-hex hash without throwing", async () => {
  const { raw, hash } = await newCancelToken(SECRET)
  assertEquals(hash.length, 64)
  for (const malformed of [hash.slice(0, 32), hash.slice(0, 63), "", "0", "abc", "zz".repeat(32)]) {
    assertEquals(await verifyCancelToken(raw, malformed, SECRET), false)
  }
})

Deno.test("verifyCancelToken — a blank secret fails closed", async () => {
  for (const blank of ["", "  ", "\n"]) {
    const error = await assertRejects(
      () => verifyCancelToken("any-raw", "a".repeat(64), blank),
      Error,
    )
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidSecret)
  }
})

Deno.test("verifyCancelToken — a secret below the 32-character floor fails closed", async () => {
  for (const secret of ["a", "a".repeat(MIN_SECRET_LENGTH - 1)]) {
    const error = await assertRejects(
      () => verifyCancelToken("any-raw", "a".repeat(64), secret),
      Error,
    )
    assertEquals((error as TokenError).code, TokenErrorCode.InvalidSecret)
    assertEquals(error.message, "secret must be at least 32 characters")
  }
  const nulError = await assertRejects(
    () => verifyCancelToken("any-raw", "a".repeat(64), "\u0000"),
    Error,
  )
  assertEquals((nulError as TokenError).code, TokenErrorCode.InvalidSecret)
  // Exactly the floor is accepted, so the rule is a floor and not an off-by-one.
  assertEquals(
    await verifyCancelToken("any-raw", "a".repeat(64), "a".repeat(MIN_SECRET_LENGTH)),
    false,
  )
})

Deno.test("constantTimeEquals — true for equal digests, false for one differing character", async () => {
  const digest = await sha256Hex("abc")
  assertEquals(await constantTimeEquals(digest, digest), true)
  const flipped = flipHex(digest)
  assertEquals(await constantTimeEquals(digest, flipped), false)
  assertEquals(await constantTimeEquals(digest, flipHex(digest, 63)), false)
})

Deno.test("constantTimeEquals — false for unusual lengths instead of throwing", async () => {
  const digest = await sha256Hex("abc")
  const cases: Array<[string, string]> = [
    ["", ""],
    ["", digest],
    [digest, ""],
    ["abc", digest],
    ["abc", "abd"],
    ["0", "0"],
    ["0", "00"],
    [digest, digest.slice(0, 32)],
    [digest + "a", digest],
    ["zz".repeat(32), digest],
  ]
  for (const [a, b] of cases) {
    const result = await constantTimeEquals(a, b)
    assertEquals(result, false, `expected false for ${JSON.stringify([a.length, b.length])}`)
  }
})

Deno.test("constantTimeEquals — delegates the comparison to timingSafeEqual and hand-rolls nothing", async () => {
  const module = await readModuleSourceWithoutComments()
  const body = sliceFunctionBody(module, "export async function constantTimeEquals(")

  // The one and only comparison primitive.
  assert(
    body.includes("timingSafeEqual("),
    "constantTimeEquals must call timingSafeEqual",
  )
  assert(
    module.includes('import { timingSafeEqual } from "@std/crypto/timing-safe-equal"'),
    "timingSafeEqual must be imported from @std/crypto/timing-safe-equal",
  )

  // No manual comparison anywhere in the primitive. `===`/`!==` are covered by
  // the allowance list below instead, because four of them are legitimate.
  for (const forbidden of ["charCodeAt", "codePointAt", "^=", "|="]) {
    assertFalse(
      body.includes(forbidden),
      `constantTimeEquals must not compare bytes by hand: found ${forbidden}`,
    )
  }

  // `===` and `!==` are allowed only where the decision cannot depend on digest
  // content: the input type checks, the input emptiness checks, the decoded-digest
  // length check, and the `null` results of the hex decode. Every other strict
  // comparison — in particular any comparison of `leftDigest`/`rightDigest`, the
  // values the constant-time call is supposed to own — is a leak.
  const allowed = [
    'typeof a !== "string"',
    'typeof b !== "string"',
    'a === ""',
    'b === ""',
    "left === null",
    "right === null",
    "left.length !== right.length",
  ]
  const comparisons = strictComparisons(body)
  assertEquals(comparisons.length, 4, `unexpected strict comparisons: ${comparisons.join(" | ")}`)
  for (const comparison of comparisons) {
    assert(
      allowed.some((permitted) => comparison.includes(permitted)),
      `constantTimeEquals has a strict comparison that is not a type, emptiness, length or decode check: ${comparison}`,
    )
  }
  for (const digest of ["leftDigest", "rightDigest"]) {
    for (const operator of ["===", "!==", "==", "!="]) {
      assertFalse(
        body.includes(`${digest} ${operator}`) || body.includes(`${operator} ${digest}`),
        `constantTimeEquals must not compare ${digest} with ${operator}`,
      )
    }
  }
})

Deno.test("verifyCancelToken — the production call site goes through the constant-time primitive", async () => {
  const module = await readModuleSourceWithoutComments()
  const body = sliceFunctionBody(module, "export async function verifyCancelToken(")
  assert(
    body.includes("constantTimeEquals("),
    "verifyCancelToken must compare through constantTimeEquals",
  )
  assertFalse(body.includes("computed === hash"), "verifyCancelToken must not compare with ===")
  assertFalse(body.includes("computed !== hash"), "verifyCancelToken must not compare with !==")
})
