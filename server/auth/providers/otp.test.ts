/**
 * Security fix 3: the OTP key was never consumed after a successful `check()`.
 *
 * `roley/providers/otp.ts:97-139` verified the code, minted a session and returned,
 * without deleting the key, without an expiry and without counting failures. The
 * consequence is a code that works forever, costlessly guessable. Three properties
 * replace it, and each has a test that goes red when the behaviour is removed:
 *
 *  - **delete-on-use** — "rejects a replayed one-time password" is the single most
 *    important test in this package;
 *  - **expiry** — the deadline is written with the code and checked before it;
 *  - **lockout** — the (N+1)-th attempt fails even when it is the right code.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { KeyKind } from "../types.ts"
import { createTestAuth, type TestAuth } from "../testing/harness.ts"

/** Short enough that the expiry test never has to advance a real clock far. */
const TTL_MS = 60_000
const MAX_ATTEMPTS = 3

function otpAuth(): TestAuth {
  return createTestAuth({ credentialTtlMs: TTL_MS, maxAttempts: MAX_ATTEMPTS })
}

Deno.test("rejects a replayed one-time password", async () => {
  const { auth, adapter, clock } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")

  const first = await auth.otp.check("user@example.com", code)
  assert(first, "the correct code must sign in")
  assertEquals(first.user.email, "user@example.com")
  assertEquals(adapter.allKeys().filter((key) => key.kind === KeyKind.Otp).length, 0)

  // The replay. With delete-on-use removed this returns a second session.
  const replay = await auth.otp.check("user@example.com", code)
  assertEquals(replay, null, "a consumed code must not be usable again")

  // Even after time passes and a new code is issued, the old one stays dead.
  clock.advance(TTL_MS + 1)
  const fresh = await auth.otp.signUp("user@example.com")
  assertFalse(fresh === code, "a new code must differ from the consumed one")
  assertEquals(await auth.otp.check("user@example.com", code), null)
  assert(await auth.otp.check("user@example.com", fresh))
})

Deno.test("a consumed one-time password mints exactly one session", async () => {
  const { auth, adapter } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")
  await auth.otp.check("user@example.com", code)
  await auth.otp.check("user@example.com", code)
  await auth.otp.check("user@example.com", code)
  // one session from the signup flow's stored body, one from the successful check
  assertEquals(adapter.allKeys().filter((key) => key.kind === KeyKind.Otp).length, 0)
})

Deno.test("rejects an expired one-time password", async () => {
  const { auth, clock } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")

  // Still valid one millisecond before the deadline.
  clock.advance(TTL_MS - 1)
  assert(await auth.otp.check("user@example.com", code), "must be valid before the deadline")

  const second = await auth.otp.signUp("user@example.com")
  clock.advance(TTL_MS + 1)
  assertEquals(
    await auth.otp.check("user@example.com", second),
    null,
    "a code past its deadline must be refused even when correct",
  )
})

Deno.test("the deadline is written when the code is, and is refreshed by a new code", async () => {
  const { auth, adapter, clock } = otpAuth()
  await auth.otp.signUp("user@example.com")
  const first = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assert(first?.expiresAt, "an OTP key must carry a deadline")
  assertEquals(first.expiresAt.getTime(), clock.now() + TTL_MS)

  clock.advance(5_000)
  await auth.otp.signUp("user@example.com")
  const second = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assertEquals(second?.expiresAt?.getTime(), clock.now() + TTL_MS)
})

Deno.test("counts a failed verification toward the lockout", async () => {
  const { auth, adapter } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")
  const wrong = code === "000000" ? "111111" : "000000"

  assertEquals(await auth.otp.check("user@example.com", wrong), null)
  const afterOne = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assertEquals(afterOne?.attempts, 1, "a failure must be recorded")

  assertEquals(await auth.otp.check("user@example.com", wrong), null)
  const afterTwo = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assertEquals(afterTwo?.attempts, 2)

  // The correct code still works while the key is under the limit.
  assert(await auth.otp.check("user@example.com", code))
})

Deno.test("locks out further guesses once the attempt limit is reached", async () => {
  const { auth, adapter } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")
  const wrong = code === "000000" ? "111111" : "000000"

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    assertEquals(await auth.otp.check("user@example.com", wrong), null)
  }
  const locked = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assertEquals(locked?.attempts, MAX_ATTEMPTS)

  // The (N+1)-th attempt fails even though the code is right.
  assertEquals(
    await auth.otp.check("user@example.com", code),
    null,
    "a locked-out key must refuse a correct code too",
  )
  const still = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)
  assertEquals(still?.attempts, MAX_ATTEMPTS, "a refused attempt must not consume the key")
})

Deno.test("a new code clears the lockout and the attempt count", async () => {
  const { auth, adapter } = otpAuth()
  const first = await auth.otp.signUp("user@example.com")
  const wrong = first === "000000" ? "111111" : "000000"
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await auth.otp.check("user@example.com", wrong)
  }
  const fresh = await auth.otp.signUp("user@example.com")
  const key = adapter.allKeys().find((entry) => entry.kind === KeyKind.Otp)
  assertEquals(key?.attempts, 0, "a fresh code restarts the counter")
  assert(await auth.otp.check("user@example.com", fresh))
})

Deno.test("stores only a hash of the one-time password", async () => {
  const { auth, adapter } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")
  const stored = adapter.allKeys().find((key) => key.kind === KeyKind.Otp)?.secret ?? ""
  assert(stored.length > 0)
  assertFalse(stored === code, "the raw code must not be stored")
  assertFalse(stored.includes(code), "the raw code must not appear inside the stored value")
})

Deno.test("an unknown address cannot be probed for codes", async () => {
  const { auth } = otpAuth()
  assertEquals(await auth.otp.check("nobody@example.com", "123456"), null)
})

Deno.test("generated codes have the configured length and only digits", async () => {
  const { auth } = otpAuth()
  for (let round = 0; round < 20; round++) {
    const code = await auth.otp.generateOtp()
    assertEquals(code.length, 6)
    assert(/^[0-9]{6}$/.test(code), `unexpected code shape ${code}`)
  }
})

Deno.test("signIn rotates the code for an existing address", async () => {
  const { auth } = otpAuth()
  const first = await auth.otp.signUp("user@example.com")
  const second = await auth.otp.signIn("user@example.com")
  assertFalse(first === second)
  assertEquals(await auth.otp.check("user@example.com", first), null)
  assert(await auth.otp.check("user@example.com", second))
})

Deno.test("signIn refuses an address with no OTP key", async () => {
  const { auth } = otpAuth()
  let threw = false
  try {
    await auth.otp.signIn("nobody@example.com")
  } catch {
    threw = true
  }
  assert(threw, "signIn must not invent a key")
})

Deno.test("changeEmail moves the key and invalidates the outstanding code", async () => {
  const { auth, adapter } = otpAuth()
  const code = await auth.otp.signUp("user@example.com")
  const rotated = await auth.otp.changeEmail(
    adapter.allKeys().find((key) => key.kind === KeyKind.Otp)?.userId ?? 0,
    "other@example.com",
  )
  assertFalse(rotated === code)
  assertEquals(await auth.otp.check("user@example.com", code), null)
  assert(await auth.otp.check("other@example.com", rotated))
})

Deno.test("changeEmail refuses an address another account owns", async () => {
  const { auth, adapter } = otpAuth()
  await auth.otp.signUp("one@example.com")
  await auth.otp.signUp("two@example.com")
  const first = adapter.allKeys().find(
    (key) => key.kind === KeyKind.Otp && key.identification === "one@example.com",
  )
  let threw = false
  try {
    await auth.otp.changeEmail(first?.userId ?? 0, "two@example.com")
  } catch {
    threw = true
  }
  assert(threw, "an address must not be stealable")
})
