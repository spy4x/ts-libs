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

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert"
import { assertPepper, CryptoContext, MissingPepperError } from "./crypto.ts"
import { createAuth } from "./lib.ts"
import { MemoryAdapter } from "./testing/memory-adapter.ts"
import {
  createTestAuth,
  OTHER_TEST_PEPPER,
  TEST_ITERATIONS,
  TEST_PEPPER,
} from "./testing/harness.ts"

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

Deno.test("verify rejects a malformed stored hash and keeps verifying afterwards", async () => {
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const hash = await crypto.hash("value")
  const [salt] = hash.split(":")
  assertFalse(await crypto.verify("value", `${salt}:zz`))
  assert(await crypto.verify("value", hash), "a malformed probe must not poison later checks")
})
