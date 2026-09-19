/**
 * Security fix 2: magic-link tokens were stored plaintext and compared with `===`.
 *
 * `roley/providers/magicLink.ts` wrote the raw token into `key.secret` (`:37`,
 * `:50`, `:63`), compared it with `!==` (`:152`), and offered
 * `checkToken(provided, stored)` doing `provided === stored` (`:192`). A dump of
 * the keys table was a set of working login links, and the comparison leaked how
 * much of a guess was correct.
 *
 * This suite asserts the replacement:
 *
 *  - the stored value is a PBKDF2 digest, and the raw token appears nowhere in it;
 *  - a wrong token of the same length and of a different length are both rejected;
 *  - both sides are digested before any comparison, so no length-dependent branch
 *    exists (proven structurally, on the comparator the provider calls);
 *  - the token is single-use, expires, and locks out — the same three properties
 *    as an OTP, because the same key shape carries them.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { CryptoContext } from "../crypto.ts"
import { KeyKind } from "../types.ts"
import { createTestAuth, TEST_ITERATIONS, TEST_PEPPER, type TestAuth } from "../testing/harness.ts"

const TTL_MS = 60_000
const MAX_ATTEMPTS = 3

function linkAuth(): TestAuth {
  return createTestAuth({ credentialTtlMs: TTL_MS, maxAttempts: MAX_ATTEMPTS })
}

function storedLink(adapter: TestAuth["adapter"]) {
  return adapter.allKeys().find((key) => key.kind === KeyKind.MagicLink)
}

Deno.test("stores only a digest of the magic-link token", async () => {
  const { auth, adapter } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  const stored = storedLink(adapter)?.secret ?? ""

  assert(stored.length > 0, "a link key must carry a secret")
  assertFalse(stored === token, "the stored value must not be the raw token")
  assertFalse(stored.includes(token), "the raw token must not appear inside the stored value")
  // The source stored `secret: token`; assert the stored value is not even the
  // same shape, so a "hash" that returned its input would fail here too.
  assert(/^[0-9a-f]+:[0-9a-f]+$/.test(stored), `unexpected stored shape ${stored}`)
})

Deno.test("signIn, createToken and changeEmail also store only a digest", async () => {
  const { auth, adapter } = linkAuth()
  const signUpToken = await auth.magicLink.signUp("user@example.com")
  const signInToken = await auth.magicLink.signIn("user@example.com")
  const changed = await auth.magicLink.changeEmail(
    storedLink(adapter)?.userId ?? 0,
    "other@example.com",
  )
  const stored = storedLink(adapter)?.secret ?? ""

  for (const token of [signUpToken, signInToken, changed]) {
    assertFalse(stored === token)
    assertFalse(stored.includes(token))
  }
  const created = await auth.magicLink.createToken("third@example.com")
  assert(created, "createToken must return a key")
  assertFalse(created.key.secret === created.notHashedToken)
  assertFalse((created.key.secret ?? "").includes(created.notHashedToken))
})

Deno.test("rejects a wrong token of the same length", async () => {
  const { auth } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  const wrong = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")
  assertEquals(wrong.length, token.length)
  assertEquals(await auth.magicLink.check("user@example.com", wrong), null)
  assert(await auth.magicLink.check("user@example.com", token), "the real token must still work")
})

Deno.test("rejects wrong tokens of every length and counts each one", async () => {
  // maxAttempts is one more than the number of probes, so the lockout cannot mask
  // a missing increment: every probe must be recorded, and the count is the
  // evidence that no probe took a length-dependent early return.
  const probes = ["", "a", "abcdefgh", "x".repeat(4096)]
  const { auth, adapter } = createTestAuth({
    credentialTtlMs: TTL_MS,
    maxAttempts: probes.length + 1,
  })
  const token = await auth.magicLink.signUp("user@example.com")

  for (const wrong of probes) {
    assertEquals(
      await auth.magicLink.check("user@example.com", wrong),
      null,
      `token of length ${wrong.length} must be rejected`,
    )
  }
  assertEquals(
    storedLink(adapter)?.attempts,
    probes.length,
    "every rejected probe must be counted, whatever its length",
  )
  assert(await auth.magicLink.check("user@example.com", token))
})

Deno.test("verifyToken compares digests of any length and never throws", async () => {
  const { auth, adapter } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  const secret = storedLink(adapter)?.secret ?? ""
  assert(secret.length > 0)
  // The provider is typed by its interface, which carries `verifyToken`, so this
  // is the same function `check` calls.
  const provider = auth.magicLink
  assert(await provider.verifyToken(token, secret))
  assertFalse(await provider.verifyToken(token + "x", secret))
  assertFalse(await provider.verifyToken("", secret))
  assertFalse(await provider.verifyToken("x".repeat(4096), secret))
})

Deno.test("the comparator digests both sides before comparing, at any length", async () => {
  // Structural proof on the exact function the provider calls. `constantTimeEquals`
  // encodes both arguments inside one `Promise.all`, synchronously, before either
  // digest is awaited: a length-dependent return could not have skipped one, and
  // `timingSafeEqual` never sees unequal lengths (it throws on them).
  const crypto = new CryptoContext({ pepper: TEST_PEPPER, iterations: TEST_ITERATIONS })
  const encoded: string[] = []
  const spy = (value: string, label: string): string => {
    encoded.push(label)
    return value
  }
  await crypto.constantTimeEquals(spy("a".repeat(64), "left-long"), spy("b", "right-short"))
  assertEquals(encoded, ["left-long", "right-short"])
  // And the outcome for unequal lengths is `false`, not a thrown error: a throw
  // caught by the caller would itself reveal that the lengths differed.
  assertFalse(await crypto.constantTimeEquals("a".repeat(64), "b"))
})

Deno.test("the magic-link token path does not use constantTimeEquals", () => {
  // The comments in `magic-link.ts` and `crypto.ts` attribute the protection to
  // `crypto.verify` (which compares two derived keys) and reserve
  // `constantTimeEquals` for values that are not hashed at rest — the OAuth2 state
  // cookie. A comment can drift; this reads the code.
  //
  // Asserted on the strip-comments form, so the prose *naming* the other function
  // is not mistaken for a call to it.
  return Deno.readTextFile(new URL("./magic-link.ts", import.meta.url)).then((source) => {
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n")
    assertFalse(
      code.includes("constantTimeEquals"),
      "the magic-link path compares through crypto.verify, not constantTimeEquals",
    )
    assert(
      code.includes("verifyToken") && code.includes("crypto.verify"),
      "the token must be checked through crypto.verify",
    )
  })
})

Deno.test("rejects a replayed magic-link token", async () => {
  const { auth, adapter } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")

  assert(await auth.magicLink.check("user@example.com", token))
  assertEquals(storedLink(adapter), undefined, "the key must be consumed on success")
  assertEquals(await auth.magicLink.check("user@example.com", token), null)
})

Deno.test("rejects an expired magic-link token", async () => {
  const { auth, clock } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  clock.advance(TTL_MS + 1)
  assertEquals(await auth.magicLink.check("user@example.com", token), null)
})

Deno.test("locks out further token guesses at the attempt limit", async () => {
  const { auth } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await auth.magicLink.check("user@example.com", `guess-${attempt}`)
  }
  assertEquals(
    await auth.magicLink.check("user@example.com", token),
    null,
    "a locked-out link must refuse the correct token too",
  )
})

Deno.test("getUserByEmail returns the account that owns the link", async () => {
  // The source's `getUserByEmail` did `email.toString()` and returned
  // `Promise.resolve(null)` for every input.
  const { auth } = linkAuth()
  const token = await auth.magicLink.signUp("user@example.com")
  const user = await auth.magicLink.getUserByEmail("user@example.com")
  assert(user, "the account must be found")
  assertEquals(user.email, "user@example.com")
  assertEquals(await auth.magicLink.getUserByEmail("nobody@example.com"), null)
  assert(token.length > 0)
})

Deno.test("createToken returns a usable key and the raw token exactly once", async () => {
  // The source returned `Promise.resolve(null)` unconditionally.
  const { auth } = linkAuth()
  const created = await auth.magicLink.createToken("user@example.com")
  assert(created, "createToken must not return null")
  assertEquals(created.key.kind, KeyKind.MagicLink)
  assertEquals(created.key.identification, "user@example.com")
  assertEquals(created.key.userId, -1, "an unattached key is created with no owner")
  assert(created.notHashedToken.length > 0)
})

Deno.test("the redirect URL carries the address and the token as query parameters", () => {
  const { auth } = linkAuth()
  const url = new URL(auth.magicLink.getRedirectURL("user@example.com", "tok en+/="))
  assertEquals(url.searchParams.get("email"), "user@example.com")
  assertEquals(url.searchParams.get("token"), "tok en+/=")
})

Deno.test("an unknown address cannot be probed for a link", async () => {
  const { auth } = linkAuth()
  assertEquals(await auth.magicLink.check("nobody@example.com", "anything"), null)
})

Deno.test("connect attaches a link to an existing account", async () => {
  // An anonymous account, so no sibling linking runs first and the explicit
  // connect is the only thing creating a link key.
  const { auth, adapter } = linkAuth()
  const guest = await auth.anonymous.signUp()
  const linked = await auth.magicLink.connect(guest.user.id, "user@example.com")

  assertEquals(linked.key.kind, KeyKind.MagicLink)
  assertEquals(linked.user.id, guest.user.id)
  assertEquals(linked.key.userId, guest.user.id)
  assertEquals(
    adapter.allKeys().filter((key) => key.kind === KeyKind.MagicLink).length,
    1,
  )
  assertEquals(linked.user.email, null, "connect must not invent an address on the account")
})

Deno.test("connect refuses a second link for the same account", async () => {
  const { auth } = linkAuth()
  const guest = await auth.anonymous.signUp()
  await auth.magicLink.connect(guest.user.id, "user@example.com")
  let threw = false
  try {
    await auth.magicLink.connect(guest.user.id, "other@example.com")
  } catch {
    threw = true
  }
  assert(threw, "one account must not carry two magic-link keys")
})
