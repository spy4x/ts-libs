/**
 * Security fix 6: two pepper sources of truth, neither of them required.
 *
 * The source read `import.meta.env.PASSWORD_PEPPER` at module scope
 * (`roley/helpers.ts:7`) *and* defaulted a session pepper to the literal
 * `'custom-auth'` (`roley/misc/constants.ts:4`, used at `lib.ts:58,64,67`). A
 * deployment that forgot the variable hashed every password with a public string.
 *
 * The port has one pepper, injected, and its absence is fatal:
 *
 *  - `createAuth` with no pepper throws; with a blank pepper throws; with a
 *    whitespace-only pepper throws;
 *  - two instances with different peppers cannot verify each other's hashes;
 *  - the package never reads the environment and never mentions the old literal —
 *    asserted by grepping its own sources, which is the check a reviewer would
 *    otherwise have to do by eye.
 */

import { assert, assertEquals, assertFalse, assertNotEquals, assertThrows } from "@std/assert"
import { timingSafeEqual } from "@std/crypto/timing-safe-equal"
import { assertPepper, CryptoContext, MissingPepperError } from "./crypto.ts"
import { createAuth } from "./lib.ts"
import { MemoryAdapter } from "./testing/memory-adapter.ts"
import {
  createTestAuth,
  OTHER_TEST_PEPPER,
  TEST_ITERATIONS,
  TEST_PEPPER,
} from "./testing/harness.ts"

/**
 * True when `body` contains `===`, `==`, `!==` or `!=`.
 *
 * The operators are written as escapes so this helper is not itself a match for the
 * assertion it serves. Everything else `=` takes part in — assignment, `=>`, `>=`,
 * `<=` — is deliberately not a hit.
 *
 * This function has its own tests below. Its first version had none and was, in the
 * reviewer's words, unreachable-true for exactly the operators it named, which made
 * a source-level assertion look like proof when it proved nothing.
 */
function hasEqualityOperator(body: string): boolean {
  return ["\u003D\u003D\u003D", "\u003D\u003D", "\u0021\u003D\u003D", "\u0021\u003D"].some((
    operator,
  ) => body.includes(operator))
}

/**
 * True when `body` compares two *whole* identifiers with an equality operator.
 *
 * The narrowest form that is still sound for this file. Both sides must be a plain
 * identifier that is not a property access: `separator === stored.length - 1` and
 * `expected.length !== this.keyBytes` are guards over the *shape* of a stored value
 * and are ordinary code, so a rule that flagged them would redden on correct code.
 * What remains is the shape a substitution takes when a comparison is lifted out of
 * the seam and written as two named values compared directly.
 */
function comparesTwoBareIdentifiers(body: string): boolean {
  const operators = ["\u003D\u003D\u003D", "\u003D\u003D", "\u0021\u003D\u003D", "\u0021\u003D"]
  const literals = new Set(["null", "undefined", "true", "false", "NaN"])
  const identifier = "(?:^|[^.])\\b([A-Za-z_$][\\w$]*)\\b(?!\\.)"
  const other = "\\b([A-Za-z_$][\\w$]*)\\b(?!\\.)"
  for (const operator of operators) {
    const pattern = new RegExp(`${identifier}\\s*${operator}\\s*${other}`, "g")
    for (const match of body.matchAll(pattern)) {
      if (match[1] !== match[2] && !literals.has(match[1]) && !literals.has(match[2])) {
        return true
      }
    }
  }
  return false
}

Deno.test("the equality scanner detects every operator it claims to", () => {
  // The scanner's own tests, without which a broken scanner silently weakens the
  // source-level assertion below and nothing reports it.
  assert(hasEqualityOperator("a === b"))
  assert(hasEqualityOperator("a == b"))
  assert(hasEqualityOperator("a !== b"))
  assert(hasEqualityOperator("a != b"))
  assert(hasEqualityOperator("const ok = a === b"))
  assertFalse(hasEqualityOperator("const x = 1"))
  assertFalse(hasEqualityOperator("(a) => a"))
  assertFalse(hasEqualityOperator("a >= b"))
  assertFalse(hasEqualityOperator(""))
  assertFalse(hasEqualityOperator("this.compare(actual, expected)"))

  assert(comparesTwoBareIdentifiers("return actual === expected"))
  assert(comparesTwoBareIdentifiers("if (expected == actual) return false"))
  assert(comparesTwoBareIdentifiers("const same = leftDigest !== rightDigest"))
  assertFalse(comparesTwoBareIdentifiers("if (expected === null) return false"))
  assertFalse(comparesTwoBareIdentifiers("if (actual !== undefined) return false"))
  assertFalse(comparesTwoBareIdentifiers("if (expected.length !== this.keyBytes) return false"))
  assertFalse(comparesTwoBareIdentifiers("if (separator === stored.length - 1) return false"))
  assertFalse(comparesTwoBareIdentifiers("if (salt.length === 0) return false"))
  assertFalse(comparesTwoBareIdentifiers("return this.compare(actual, expected)"))
  assertFalse(comparesTwoBareIdentifiers("const actual = await this.derive(value, salt)"))

  // And the argument splitter, which the operand count depends on.
  assertEquals(splitTopLevelArguments("actual, expected"), ["actual", "expected"])
  assertEquals(
    splitTopLevelArguments("new Uint8Array(leftDigest), new Uint8Array(rightDigest)"),
    ["new Uint8Array(leftDigest)", "new Uint8Array(rightDigest)"],
  )
  assertEquals(splitTopLevelArguments("a"), ["a"])
  assertEquals(splitTopLevelArguments(""), [])

  // And the call reader, which has to see through nested calls.
  assertEquals(compareArguments("return this.compare(actual, expected)"), ["actual", "expected"])
  assertEquals(
    compareArguments("return this.compare(new Uint8Array(l), new Uint8Array(r))"),
    ["new Uint8Array(l)", "new Uint8Array(r)"],
  )
  assertEquals(compareArguments("if (a === b) {}"), null)
})

/**
 * The argument list of `this.compare(...)`, with nesting respected.
 *
 * A regex stopped at the first `)`, so
 * `this.compare(new Uint8Array(leftDigest), new Uint8Array(rightDigest))` yielded one
 * argument and the assertion below failed on correct code. Scanning with a depth
 * counter is the only reliable way to read a call whose arguments contain calls.
 */
function compareArguments(body: string): string[] | null {
  const marker = "this.compare("
  const start = body.indexOf(marker)
  if (start < 0) {
    return null
  }
  let depth = 0
  for (let index = start + marker.length - 1; index < body.length; index++) {
    const character = body[index]
    if (character === "(") {
      depth++
    } else if (character === ")") {
      depth--
      if (depth === 0) {
        return splitTopLevelArguments(body.slice(start + marker.length, index))
      }
    }
  }
  return null
}

/**
 * Split a call's argument list on top-level commas only.
 *
 * `this.compare(new Uint8Array(leftDigest), new Uint8Array(rightDigest))` has two
 * arguments, and a plain `split(",")` also splits the ones inside the wrappers — so
 * a naive count reported one operand and the assertion below failed on correct code.
 */
function splitTopLevelArguments(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const character of list) {
    if (character === "(" || character === "[" || character === "{") {
      depth++
    } else if (character === ")" || character === "]" || character === "}") {
      depth--
    }
    if (character === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  if (current.trim().length > 0) {
    parts.push(current.trim())
  }
  return parts
}

/** Derived-key length the tests assert on, matching `DEFAULT_HASH_KEY_BYTES`. */
const TEST_KEY_BYTES = 32

/**
 * Extract a method body from a source file by brace matching.
 *
 * Brace matching rather than a regex, so a nested block cannot truncate the body
 * and hide a comparison from the assertion that reads it.
 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`\n  async ${name}(`)
  assert(start >= 0, `method ${name} not found in the source`)
  const open = source.indexOf("{", start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const character = source[index]
    if (character === "{") {
      depth++
    } else if (character === "}") {
      depth--
      if (depth === 0) {
        return source.slice(open, index + 1)
      }
    }
  }
  throw new Error(`unterminated body for ${name}`)
}

/** Assembled rather than written out, so these sources do not match their own grep. */
const FORBIDDEN = {
  envRead: ["import.meta", "env"].join("."),
  denoEnv: ["Deno", "env"].join("."),
  oldDefault: ["custom", "auth"].join("-"),
}

/** Every source file of the package, so a grep test covers all of it. */
async function packageSources(): Promise<string[]> {
  const sources: string[] = []
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      sources.push(await Deno.readTextFile(new URL(entry.name, import.meta.url)))
    }
  }
  for await (const entry of Deno.readDir(new URL("./providers", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      sources.push(await Deno.readTextFile(new URL(`./providers/${entry.name}`, import.meta.url)))
    }
  }
  for await (const entry of Deno.readDir(new URL("./managers", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      sources.push(await Deno.readTextFile(new URL(`./managers/${entry.name}`, import.meta.url)))
    }
  }
  return sources
}

Deno.test("assertPepper rejects an absent, empty or blank pepper", () => {
  for (const pepper of [undefined, null, "", "   ", "\t\n"]) {
    assertThrows(() => assertPepper(pepper), MissingPepperError)
  }
  assertEquals(assertPepper(TEST_PEPPER), TEST_PEPPER)
})

Deno.test("createAuth throws when no pepper is supplied", () => {
  // The call shape a deployment gets wrong. Under the source this silently hashed
  // with the literal default.
  const adapter = new MemoryAdapter()
  assertThrows(
    () => createAuth({ adapter, passwordPepper: "" }),
    MissingPepperError,
  )
  assertThrows(
    // @ts-expect-error deliberately omitting a required option, as a JS caller would
    () => createAuth({ adapter }),
    MissingPepperError,
  )
})

Deno.test("createAuth throws on a whitespace-only pepper", () => {
  const adapter = new MemoryAdapter()
  assertThrows(() => createAuth({ adapter, passwordPepper: "  " }), MissingPepperError)
})

Deno.test("two instances with different peppers cannot verify each other's hashes", async () => {
  const first = createTestAuth()
  const second = createTestAuth({ passwordPepper: OTHER_TEST_PEPPER })

  const hash = await first.auth.emailPassword.hashPassword("correct horse battery staple")

  assert(await first.auth.emailPassword.checkPassword("correct horse battery staple", hash))
  assertFalse(
    await second.auth.emailPassword.checkPassword("correct horse battery staple", hash),
    "a hash from another pepper must not verify",
  )

  const registration = await first.auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  assertFalse(
    await second.auth.emailPassword.checkPassword("hunter2-hunter2", registration.key.secret ?? ""),
    "a stored credential must not verify under another pepper",
  )
})

/**
 * Strip comments before grepping for a forbidden construct.
 *
 * A doc comment that *names* the bug it fixes is documentation; only an actual
 * code reference is a regression. Stripping `//` and `/*` bodies keeps that
 * distinction, and a reviewer can see the two files where each banned string used
 * to be read.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

Deno.test("the package never reads the environment and carries no pepper default", async () => {
  for (const text of await packageSources()) {
    const code = codeOnly(text)
    assertFalse(code.includes(FORBIDDEN.envRead), `code must not read ${FORBIDDEN.envRead}`)
    assertFalse(code.includes(FORBIDDEN.denoEnv), `code must not read ${FORBIDDEN.denoEnv}`)
    assertFalse(code.includes(FORBIDDEN.oldDefault), `code must not carry ${FORBIDDEN.oldDefault}`)
  }
})

Deno.test("importing the package with no environment set does not throw", async () => {
  // The module is already imported by this file, so the import itself is proven to
  // have succeeded; what remains is construction, which the grep above establishes
  // touches no environment and which is exercised here from explicit options only.
  const { auth } = createTestAuth()
  assertEquals(typeof auth.emailPassword.signUp, "function")
  // A dynamic import after the grep, so the "does not throw at module scope" claim
  // is asserted rather than assumed.
  const module = await import("./lib.ts")
  assertEquals(typeof module.createAuth, "function")
})

Deno.test("a hash is salted, so the same value hashes differently every time", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const first = await crypto.hash("same")
  const second = await crypto.hash("same")
  assertFalse(first === second)
  assert(await crypto.verify("same", first))
  assert(await crypto.verify("same", second))
})

Deno.test("verify rejects a malformed stored hash instead of throwing", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  for (const stored of [null, undefined, "", "no-separator", ":missing-salt", "deadbeef:"]) {
    assertFalse(await crypto.verify("value", stored), `stored ${String(stored)} must not verify`)
  }
})

Deno.test("verify is not fooled by a truncated stored hash", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const hash = await crypto.hash("value")
  const [salt] = hash.split(":")
  assertFalse(await crypto.verify("value", `${salt}:00`), "a one-byte digest must not verify")
})

Deno.test("constantTimeEquals compares digested values of any length", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  assert(await crypto.constantTimeEquals("", ""))
  assert(await crypto.constantTimeEquals("a".repeat(64), "a".repeat(64)))
  assertFalse(await crypto.constantTimeEquals("a", "b"))
  // A different length must be a plain `false`, not a throw: `timingSafeEqual`
  // throws on unequal byte lengths, and a caught throw is itself a length oracle.
  assertFalse(await crypto.constantTimeEquals("short", "a-much-longer-value"))
  assertFalse(await crypto.constantTimeEquals("", "token"))
})

Deno.test("constantTimeEquals digests both sides before it compares anything", async () => {
  // Structural proof, not a timing measurement. `constantTimeEquals` builds both
  // digests inside one `Promise.all`, so neither side is observed — and no length
  // branch is possible — before the fixed-width comparison. A poisoned `toString`
  // shows the encoding of *both* arguments happening regardless of their lengths.
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const encoded: string[] = []
  const spy = (value: string, label: string): string => {
    encoded.push(label)
    return value
  }
  // Both arguments are encoded synchronously by the two `encoder.encode` calls
  // inside `Promise.all`, in argument order, before either digest is awaited and
  // before any comparison. A length-dependent early return would drop one of the
  // two encodes here.
  await crypto.constantTimeEquals(spy("aaaa", "left-equal"), spy("bbbb", "right-equal"))
  assertEquals(encoded, ["left-equal", "right-equal"])
  encoded.length = 0
  await crypto.constantTimeEquals(spy("a", "left-short"), spy("b".repeat(4096), "right-long"))
  assertEquals(
    encoded,
    ["left-short", "right-long"],
    "unequal lengths must still digest both sides",
  )
})

/**
 * PBKDF2 over an explicit input, with the production parameters.
 *
 * Used to show what the *old* framing hashed, so the collision is demonstrated
 * rather than asserted via a context pair that cannot collide either way.
 */
async function deriveWithSalt(value: string, salt: Uint8Array, keyBytes: number): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(value),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: TEST_ITERATIONS, hash: "SHA-256" },
    key,
    keyBytes * 8,
  )
  return Array.from(new Uint8Array(bits)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

Deno.test("pepper framing cannot be dropped without a collision", async () => {
  // The pair that actually collides. The old input was `value + pepper`, so
  // `("", "abc")` and `("a", "bc")` both hashed the bytes `abc` — one credential,
  // verifiable under two different peppers. A context pair like
  // `("xpe", "pepper")` versus `("x", "pper")` proves nothing: those two
  // concatenations differ whether or not the framing exists, so the earlier revision
  // of this test was vacuous.
  const salt = new Uint8Array(16).fill(7)
  const keyBytes = 16

  assertEquals(
    await deriveWithSalt(`${""}${"abc"}`, salt, keyBytes),
    await deriveWithSalt(`${"a"}${"bc"}`, salt, keyBytes),
    "the old concatenation collides on this pair",
  )
  assertNotEquals(
    await deriveWithSalt(`${"".length}:${""}:${"abc"}`, salt, keyBytes),
    await deriveWithSalt(`${"a".length}:${"a"}:${"bc"}`, salt, keyBytes),
    "length framing separates the same two boundary cases",
  )

  // End to end: a credential hashed under one pepper does not verify under another,
  // and each context still accepts its own.
  const emptyValue = new CryptoContext({ pepper: "abc", iterations: TEST_ITERATIONS })
  const shifted = new CryptoContext({ pepper: "bc", iterations: TEST_ITERATIONS })
  assertFalse(
    await shifted.verify("a", await emptyValue.hash("")),
    "a hash from another pepper must not verify",
  )
  assert(await emptyValue.verify("", await emptyValue.hash("")))
  assert(await shifted.verify("a", await shifted.hash("a")))

  // A value whose own text contains the separator still round-trips, so the framing
  // is unambiguous rather than merely different.
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const awkward = "8:8:test-pepper-not-real"
  assert(await crypto.verify(awkward, await crypto.hash(awkward)))
})

Deno.test("every failure path is silent about the secret", async () => {
  const { auth, adapter, clock } = createTestAuth()
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "))
  }
  try {
    await auth.otp.signUp("user@example.com")
    await auth.otp.check("user@example.com", "000000")
    await auth.magicLink.signUp("user@example.com")
    await auth.magicLink.check("user@example.com", "wrong-token")
    await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
    await auth.emailPassword.signIn("user@example.com", "wrong-password")
    clock.advance(1000)
    const keys = adapter.allKeys()
    assertEquals(keys.length > 0, true)
  } finally {
    console.error = original
  }
  const joined = errors.join("\n")
  assertFalse(joined.includes("hunter2"), `a password reached the log: ${joined}`)
  assertFalse(joined.includes("wrong-token"), `a token reached the log: ${joined}`)
  assertFalse(joined.includes("user@example.com"), `an address reached the log: ${joined}`)
  assertFalse(joined.includes(TEST_PEPPER), `the pepper reached the log: ${joined}`)
})

Deno.test("hashes carry no pepper material in the stored value", async () => {
  const { auth, adapter } = createTestAuth()
  await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  const stored = adapter.allKeys()[0].secret ?? ""
  assertFalse(stored.includes(TEST_PEPPER))
  assertFalse(stored.includes("hunter2"))
})

/**
 * A comparator that records what it was asked to compare.
 *
 * The point is not that it compares — it delegates to the real one, so every
 * existing behavioural test still holds — but that its *call* is observable. Any
 * mutation that replaces the comparison on a verify path with `===`, a hex-string
 * compare or an inline `timingSafeEqual` stops calling it, and a test asserting it
 * was called therefore goes red.
 */
class RecordingComparator {
  readonly calls: Array<{ left: number[]; right: number[] }> = []

  readonly compare = (left: Uint8Array, right: Uint8Array): boolean => {
    this.calls.push({ left: [...left], right: [...right] })
    return timingSafeEqual(left, right)
  }

  reset(): void {
    this.calls.length = 0
  }
}

Deno.test("the verify path compares through the injected comparator", async () => {
  const comparator = new RecordingComparator()
  const crypto = new CryptoContext({
    pepper: TEST_PEPPER,
    iterations: TEST_ITERATIONS,
    comparator: comparator.compare,
  })
  const hash = await crypto.hash("correct horse battery staple")

  comparator.reset()
  assert(await crypto.verify("correct horse battery staple", hash))
  assertEquals(comparator.calls.length, 1, "verify must compare exactly once")

  const [call] = comparator.calls
  // Both operands are the *derived* keys — not the hex strings, not the raw inputs.
  // A hex-string comparison would exit at the first differing byte; a comparison of
  // raw inputs would not be a credential check at all.
  assertEquals(call.left.length, TEST_KEY_BYTES)
  assertEquals(call.right.length, TEST_KEY_BYTES)
  assertEquals(call.left, call.right, "a matching credential derives equal keys")

  comparator.reset()
  assertFalse(await crypto.verify("wrong password", hash))
  assertEquals(comparator.calls.length, 1, "a wrong credential must still be compared")
  assertNotEquals(comparator.calls[0].left, comparator.calls[0].right)
})

Deno.test("constantTimeEquals compares through the same injected comparator", async () => {
  const comparator = new RecordingComparator()
  const crypto = new CryptoContext({
    pepper: TEST_PEPPER,
    iterations: TEST_ITERATIONS,
    comparator: comparator.compare,
  })

  assert(await crypto.constantTimeEquals("token", "token"))
  assertEquals(comparator.calls.length, 1)
  // 32 bytes on both sides whatever the inputs were: that is the digest step, and
  // it is what makes the comparison length-independent. A `===` on the inputs would
  // compare 0 times; a hex compare would hand over 64 characters.
  assertEquals(comparator.calls[0].left.length, 32)
  assertEquals(comparator.calls[0].right.length, 32)

  comparator.reset()
  assertFalse(await crypto.constantTimeEquals("a", "b".repeat(4096)))
  assertEquals(comparator.calls.length, 1, "unequal lengths must still reach the comparator")
  assertEquals(comparator.calls[0].left.length, 32)
  assertEquals(comparator.calls[0].right.length, 32)
})

Deno.test("the seam cannot be satisfied by calling the comparator and ignoring it", async () => {
  // The converse: if the comparison result were discarded and a hardcoded answer
  // returned, this fails.
  const permissive = new CryptoContext({
    pepper: TEST_PEPPER,
    iterations: TEST_ITERATIONS,
    comparator: () => true,
  })
  const hash = await permissive.hash("real password")
  assert(await permissive.verify("anything at all", hash))

  const real = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  assertFalse(await real.verify("anything at all", hash))
})

Deno.test("no secret is compared outside the one comparator", async () => {
  // The property is *which comparison the verify paths use*, and no runtime check can
  // observe that an equivalent substitution happened — that was the gap a mutation on
  // `timingSafeEqual` exposed. Asserted from the source, read off disk:
  //
  //  1. the comparison goes through `this.compare(`, and its result is returned, so
  //     a call whose answer is discarded is not mistaken for a comparison;
  //  2. it is called with exactly two operands, neither of them `undefined`, and no
  //     local captures the result of a `this.compare(` call for use elsewhere;
  //  3. no two *bare* identifiers are compared with an equality operator in the body.
  //
  // Assertion 3 is weaker than it reads, and an earlier revision of this test
  // overclaimed that it was "mutation-proven" for every operator shape. It cannot see
  // a comparison reached through an attribute (`actual[0] === expected[0]`) or against
  // a literal (`actual[0] === 0`), and it deliberately does not flag the shape guards
  // `verify` needs (`if (separator === stored.length - 1)`), because flagging those
  // reddens on correct code. It is not a proof that no comparison was substituted; it
  // narrows the one-line forms. The behavioural proof is the comparator seam above.
  const source = await Deno.readTextFile(new URL("./crypto.ts", import.meta.url))
  for (const name of ["verify", "constantTimeEquals"]) {
    const body = methodBody(source, name)
    const operands = compareArguments(body)
    assert(operands, `CryptoContext.${name} must compare through this.compare`)
    assert(
      /return\s+this\.compare\(/.test(body),
      `CryptoContext.${name} must return the comparison result, not discard it`,
    )
    assertEquals(operands.length, 2, `CryptoContext.${name} must compare exactly two operands`)
    assertFalse(
      operands.includes("undefined"),
      `CryptoContext.${name} must not compare a computed value against undefined`,
    )
    assertFalse(
      comparesTwoBareIdentifiers(body),
      `CryptoContext.${name} must not compare two identifiers with an equality operator`,
    )
    assertFalse(
      new RegExp(`const\\s+\\w+\\s*=\\s*(await\\s+)?this\\.compare\\(`).test(body),
      `CryptoContext.${name} must not stash the comparison result in a local`,
    )
  }

  // And the constant-time primitive is referenced from exactly one place in the
  // package: the comparator default. A second reference is a second compare path.
  const sources: string[] = []
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue
    }
    sources.push(await Deno.readTextFile(new URL(entry.name, import.meta.url)))
  }
  const referencing = sources.filter((text) => text.includes("timingSafeEqual"))
  assertEquals(
    referencing.length,
    1,
    "timingSafeEqual must be referenced from exactly one file, the comparator default",
  )
  assert(referencing[0].includes("timingSafeBytesComparator"))
})

/**
 * The credential whose **one-byte** PBKDF2 output is `0x00` under the salt below.
 *
 * Brute-forced once, offline, and hardcoded: `probe-4` is the 5th candidate. The
 * test is therefore deterministic — it does not depend on the sampler finding a
 * credential, which is how this defect hid behind a 0.39% chance for two review
 * rounds.
 */
const ONE_BYTE_ZERO_CREDENTIAL = "probe-4"

/** Sixteen bytes of salt, as the stored format hex-encodes them. */
const SALT_HEX = "802f0e69dbede4c961f06e7abef3395b"

Deno.test("verify rejects a malformed key that decodes to a one-byte zero", async () => {
  // `802f…:zz` — the salt is valid hex, the key is not. The pre-fix decoder ran
  // `Number.parseInt("zz", 16)`, which is `NaN`, and `Uint8Array` coerced that to
  // `0x00`, so the stored key became a single zero byte while `expected.length`
  // stayed 1. Any credential whose one-byte PBKDF2 output is zero then verified.
  // That is an authentication bypass: roughly one credential in 256.
  //
  // Why the old suite missed it and why CI flaked. `verify is not fooled by a
  // truncated stored hash` asserted the *right* answer on `${salt}:00`, a one-byte
  // row whose hex is *valid*: its expected key decoded to exactly one zero byte.
  // That assertion therefore held only when `crypto.hash("value")` happened to
  // derive a first byte of `0x00`, i.e. about 1 run in 256. Measured with the
  // pre-fix decoder over 20,000 fresh credentials: 0.385% accepted the malformed
  // hash (theory 1/256 = 0.391%), matching the 0.27–0.475% flake observed in CI.
  // The credential below is brute-forced offline and hardcoded, so this test
  // fails deterministically rather than on the sampler's luck.
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const malformed = `${SALT_HEX}:zz`

  assertFalse(
    await crypto.verify(ONE_BYTE_ZERO_CREDENTIAL, malformed),
    "a malformed stored key must never verify",
  )
  // The whole shape, not one lucky credential: no value may verify against it.
  for (const credential of ["probe-4", "probe-79", "", "password", "a".repeat(64)]) {
    assertFalse(
      await crypto.verify(credential, malformed),
      `credential of length ${credential.length} must not verify against a malformed hash`,
    )
  }
  // And the same row with *valid* hex is refused too: a one-byte stored key is
  // refused by length, because a one-byte key matches any credential with 1-in-256
  // probability. Without this check the malformed decoder above is fixed but the
  // short-key bypass survives.
  assertFalse(
    await crypto.verify(ONE_BYTE_ZERO_CREDENTIAL, `${SALT_HEX}:00`),
    "a one-byte stored key must be refused even when its hex is valid",
  )
})

Deno.test("verify refuses a stored key that is not the derived length", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const valid = await crypto.hash("value")
  const [saltHex, keyHex] = valid.split(":")

  // Every truncation and every extension of a real key, all valid hex.
  for (let byteCount = 1; byteCount <= keyHex.length / 2; byteCount++) {
    const shorter = keyHex.slice(0, byteCount * 2)
    if (shorter === keyHex) {
      continue
    }
    assertFalse(
      await crypto.verify("value", `${saltHex}:${shorter}`),
      `a ${byteCount}-byte stored key must be refused`,
    )
  }
  assertFalse(await crypto.verify("value", `${saltHex}:${keyHex}00`))
  assert(await crypto.verify("value", valid), "the untruncated hash must still verify")
})

Deno.test("verify rejects every malformed stored hash without comparing", async () => {
  const comparator = new RecordingComparator()
  const crypto = new CryptoContext({
    pepper: TEST_PEPPER,
    iterations: TEST_ITERATIONS,
    comparator: comparator.compare,
  })
  const valid = await crypto.hash("value")
  const [saltHex, keyHex] = valid.split(":")

  const malformed = [
    "",
    "no-separator",
    ":only-key",
    `${saltHex}:`,
    "zz:deadbeef",
    `${saltHex}:zz`,
    `${saltHex}:zzzz`,
    `${saltHex}z:deadbeef`,
    "abc:deadbeef",
    `${saltHex}:abc`,
    `${saltHex}: deadbeef`,
    `${saltHex}:DEADBEEF-EXTRA`,
    `${saltHex}:0xdeadbeef`,
  ]
  for (const stored of malformed) {
    comparator.reset()
    assertFalse(
      await crypto.verify("value", stored),
      `stored ${JSON.stringify(stored)} must be refused`,
    )
    assertEquals(
      comparator.calls.length,
      0,
      `stored ${JSON.stringify(stored)} must be refused before any comparison`,
    )
  }

  // And the comparator is reached again for a well-formed hash, so the refusals
  // above are rejections rather than a broken seam.
  comparator.reset()
  assert(await crypto.verify("value", valid))
  assertEquals(comparator.calls.length, 1)
  assert(keyHex.length > 0)
})

Deno.test("a valid hash never decodes through a coercing decoder", async () => {
  // The complement: an odd-length or non-hex digest is refused outright rather
  // than silently truncated. `/../g` turned `"abc"` into `"AB"`, so a truncated
  // stored key could still have compared equal.
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const valid = await crypto.hash("value")
  const [saltHex, keyHex] = valid.split(":")
  assertEquals(saltHex.length % 2, 0)
  assertEquals(keyHex.length % 2, 0)

  for (const stored of [`${saltHex}:${keyHex.slice(0, -1)}`, `${saltHex.slice(0, -1)}:${keyHex}`]) {
    assertFalse(await crypto.verify("value", stored), "an odd-length half must be refused")
  }
  assert(await crypto.verify("value", valid))
})

Deno.test("verify rejects a malformed stored hash and keeps verifying afterwards", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const hash = await crypto.hash("value")
  const [salt] = hash.split(":")
  assertFalse(await crypto.verify("value", `${salt}:zz`))
  assert(await crypto.verify("value", hash), "a malformed probe must not poison later checks")
})
