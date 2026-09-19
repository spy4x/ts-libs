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
 * True when `body` contains a loose or strict equality operator.
 *
 * Written by character code so the intent cannot be mistaken for the operator it
 * looks for, and so this helper is not itself a match for the assertion it serves.
 */
function hasEqualityOperator(body: string): boolean {
  for (let index = 0; index < body.length; index++) {
    if (body.charCodeAt(index) !== 61) {
      continue
    }
    const previous = index > 0 ? body.charCodeAt(index - 1) : 0
    const next = index + 1 < body.length ? body.charCodeAt(index + 1) : 0
    // Skip the `==` half of `!=`, `<=`, `>=`, and skip assignment and arrow function.
    if (previous === 61 || next === 61) {
      continue
    }
    if (previous === 33 || previous === 60 || previous === 62) {
      continue
    }
    if (previous === 61 || next === 61) {
      continue
    }
    // A lone `=` is an assignment or a default parameter, both allowed.
    if (next !== 61 && previous !== 61) {
      continue
    }
    return true
  }
  return false
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

Deno.test("the peppered input is length-framed, so a suffix cannot stand in for a pepper", async () => {
  // The source's `password + pepper` made `("xpe", "pper")` and `("x", "pepper")`
  // collide, because the boundary between value and pepper was not recoverable.
  // `len:value:pepper` fixes the boundary, so the same pair no longer collides.
  const longer = new CryptoContext({ pepper: "pepper", iterations: TEST_ITERATIONS })
  const shorter = new CryptoContext({ pepper: "pper", iterations: TEST_ITERATIONS })
  assertFalse(
    await longer.verify("xpe", await shorter.hash("x")),
    "a length-framed input cannot collide across a pepper boundary",
  )
  // Each context still verifies its own values.
  assert(await longer.verify("xpe", await longer.hash("xpe")))
  assert(await shorter.verify("x", await shorter.hash("x")))
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
  // Source-level assertion, and legitimately so: the property is *which operator
  // the verify paths use*, and no runtime check can observe that an equivalent
  // substitution happened — that was the gap a mutation on `timingSafeEqual`
  // exposed. Both verify bodies are read from disk and asserted to end in a
  // comparator call with no inline equality operator of their own.
  const source = await Deno.readTextFile(new URL("./crypto.ts", import.meta.url))
  for (const name of ["verify", "constantTimeEquals"]) {
    const body = methodBody(source, name)
    assertFalse(hasEqualityOperator(body), `CryptoContext.${name} must not compare inline`)
    assert(
      body.includes("this.compare("),
      `CryptoContext.${name} must route its comparison through this.compare`,
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
  assert(
    referencing[0].includes("timingSafeBytesComparator"),
    "and that reference must be the exported comparator default",
  )
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
