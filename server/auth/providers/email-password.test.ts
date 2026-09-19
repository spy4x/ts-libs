/**
 * Email + password provider.
 *
 * The suite covers the reset-token flow against the store contract that made it
 * fail: `findKeyByKindAndIdentification` returns one row, and a store that returns
 * the oldest match hands back a superseded token. `MemoryAdapter` models that with
 * an insertion-ordered map, and the Postgres adapter's `ORDER BY id LIMIT 1` is
 * the same behaviour.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { KeyKind } from "../types.ts"
import { createTestAuth, type TestAuth } from "../testing/harness.ts"

const PASSWORD = "hunter2-hunter2"
const NEW_PASSWORD = "correct-horse-battery"

function auth(): TestAuth {
  // A sibling link fails by design in this suite — reset keys and password
  // credentials are attached outside the linking handlers — so the bus reports it.
  // Silence the reporter: the failure is expected here, and a noisy suite hides a
  // real one.
  return createTestAuth({ onEventError: () => {} })
}

/** Reset keys stored for an address, oldest first. */
function resetKeys(test: TestAuth, email: string) {
  return test.adapter
    .allKeys()
    .filter((key) => key.kind === KeyKind.EmailPasswordReset && key.identification === email)
}

Deno.test("a second reset request replaces the outstanding token", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)

  const first = await test.auth.emailPassword.createPasswordResetToken("user@example.com")
  assert(first, "the first request must mint a token")

  test.clock.advance(1_000)
  const second = await test.auth.emailPassword.createPasswordResetToken("user@example.com")
  assert(second, "the second request must mint a token")
  assertFalse(first === second, "the tokens must differ")

  // One row, not two. Two rows would make the lookup ambiguous, and a store
  // returning the oldest match would hand back the superseded token.
  assertEquals(resetKeys(test, "user@example.com").length, 1, "there must be one reset key")

  // The freshest token is the one that works.
  assert(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      second,
      NEW_PASSWORD,
    ),
    "the token from the latest request must work",
  )
  // And the superseded one is gone, not merely shadowed.
  assertEquals(resetKeys(test, "user@example.com").length, 0, "consuming must clear the key")
})

Deno.test("the superseded reset token stops working the moment a new one is minted", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const first = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""
  test.clock.advance(1_000)
  const second = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""

  assertEquals(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      first,
      NEW_PASSWORD,
    ),
    null,
    "a superseded token must not reset the password",
  )
  // The password is untouched, and the live token still works.
  assert(await test.auth.emailPassword.signIn("user@example.com", PASSWORD))
  assert(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      second,
      NEW_PASSWORD,
    ),
  )
})

Deno.test("rotation resets the attempt counter and the deadline", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const first = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""

  // Burn the lockout on the first token.
  for (let attempt = 0; attempt < 4; attempt++) {
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      `guess-${attempt}`,
      NEW_PASSWORD,
    )
  }
  const locked = resetKeys(test, "user@example.com")[0]
  assert((locked.attempts ?? 0) >= 3, "guesses must be counted")

  test.clock.advance(5_000)
  const second = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""
  const rotated = resetKeys(test, "user@example.com")[0]
  assertEquals(rotated.attempts, 0, "a fresh token restarts the counter")
  assert(
    rotated.expiresAt && rotated.expiresAt.getTime() > test.clock.now(),
    "and gets a new deadline",
  )
  assertFalse(first === second)
  assert(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      second,
      NEW_PASSWORD,
    ),
    "the fresh token must work despite the earlier lockout",
  )
})

Deno.test("a reset token is single-use", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const token = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""

  assert(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      token,
      NEW_PASSWORD,
    ),
  )
  assertEquals(
    await test.auth.emailPassword.validatePasswordResetToken("user@example.com", token, "third"),
    null,
    "a consumed token must not be reusable",
  )
  assert(await test.auth.emailPassword.signIn("user@example.com", NEW_PASSWORD))
})

Deno.test("an expired reset token is refused", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const token = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""
  test.clock.advance(60 * 60 * 1000 + 1)
  assertEquals(
    await test.auth.emailPassword.validatePasswordResetToken(
      "user@example.com",
      token,
      NEW_PASSWORD,
    ),
    null,
  )
  assert(await test.auth.emailPassword.signIn("user@example.com", PASSWORD), "password unchanged")
})

Deno.test("no reset token is minted for an address with no password credential", async () => {
  const test = auth()
  assertEquals(await test.auth.emailPassword.createPasswordResetToken("nobody@example.com"), null)
  assertEquals(resetKeys(test, "nobody@example.com").length, 0)
})

Deno.test("a reset revokes every existing session", async () => {
  const test = auth()
  const registered = await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const before = test.adapter.allSessions().length
  assert(before >= 1)
  const token = (await test.auth.emailPassword.createPasswordResetToken("user@example.com")) ?? ""

  const session = await test.auth.emailPassword.validatePasswordResetToken(
    "user@example.com",
    token,
    NEW_PASSWORD,
  )
  assert(session)
  // The signup session is gone; the only live session is the replacement.
  const remaining = test.adapter.allSessions().filter((entry) =>
    entry.userId === registered.user.id
  )
  assertEquals(remaining.length, 1, "a password reset must leave exactly the new session")
  assertEquals(remaining[0].id, session.id)
})

Deno.test("isEmailTaken and getUserByEmail agree with the stored credential", async () => {
  const test = auth()
  const registered = await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  assertEquals(await test.auth.emailPassword.isEmailTaken("user@example.com"), true)
  assertEquals(await test.auth.emailPassword.isEmailTaken("other@example.com"), false)
  assertEquals(
    (await test.auth.emailPassword.getUserByEmail("user@example.com"))?.id,
    registered.user.id,
  )
  assertEquals(await test.auth.emailPassword.getUserByEmail("other@example.com"), null)
})

Deno.test("signIn rejects a wrong password and a wrong address alike", async () => {
  const test = auth()
  await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  assertEquals(await test.auth.emailPassword.signIn("user@example.com", "wrong"), null)
  assertEquals(await test.auth.emailPassword.signIn("nobody@example.com", PASSWORD), null)
  assert(await test.auth.emailPassword.signIn("user@example.com", PASSWORD))
})

Deno.test("connect attaches a password and refuses an address another account owns", async () => {
  const test = auth()
  const first = await test.auth.emailPassword.signUp("one@example.com", PASSWORD)
  const guest = await test.auth.anonymous.signUp()

  const linkedFree = await test.auth.emailPassword.connect(
    guest.user.id,
    "free@example.com",
    PASSWORD,
  )
  assert(linkedFree, "connect must succeed for an address nobody owns")
  assertEquals(linkedFree.user.id, guest.user.id, "it must attach to the named account")
  assertEquals(
    await test.auth.emailPassword.connect(guest.user.id, "one@example.com", PASSWORD),
    null,
    "an address another account owns must be refused",
  )
  const second = await test.auth.emailPassword.connect(guest.user.id, "two@example.com", PASSWORD)
  assert(second, "a second free address must also link, as a second credential")
  assertEquals(second.user.id, guest.user.id)
  assert(first.user.id !== guest.user.id)
  assert(await test.auth.emailPassword.signIn("two@example.com", PASSWORD))
  assert(await test.auth.emailPassword.signIn("free@example.com", PASSWORD))
})

Deno.test("changePassword revokes the other sessions and returns a working one", async () => {
  const test = auth()
  const registered = await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  const session = await test.auth.emailPassword.changePassword(
    registered.user.id,
    PASSWORD,
    NEW_PASSWORD,
  )
  assert(session)
  assertEquals(
    await test.auth.emailPassword.changePassword(registered.user.id, "wrong", "third"),
    null,
    "the old password must be required",
  )
  assertEquals(
    test.adapter.allSessions().filter((entry) => entry.userId === registered.user.id).length,
    1,
  )
  assert(await test.auth.emailPassword.signIn("user@example.com", NEW_PASSWORD))
})

Deno.test("changeEmail requires the password and refuses a taken address", async () => {
  const test = auth()
  const registered = await test.auth.emailPassword.signUp("user@example.com", PASSWORD)
  await test.auth.emailPassword.signUp("other@example.com", PASSWORD)

  assertFalse(
    await test.auth.emailPassword.changeEmail(registered.user.id, "moved@example.com", "wrong"),
  )
  assertFalse(
    await test.auth.emailPassword.changeEmail(registered.user.id, "other@example.com", PASSWORD),
  )
  assert(
    await test.auth.emailPassword.changeEmail(registered.user.id, "moved@example.com", PASSWORD),
  )
  assert(await test.auth.emailPassword.signIn("moved@example.com", PASSWORD))
  assertEquals(await test.auth.emailPassword.signIn("user@example.com", PASSWORD), null)
})
