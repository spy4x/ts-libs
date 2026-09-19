/**
 * The account-linking model driven through the OAuth2 provider — the named
 * requirement of this port: "an OAuth signup for an email that already has a
 * magic-link key produces two linked keys; the anonymous key is dropped; a
 * disconnect does not delete the user or the sibling keys".
 *
 * `account-linking.test.ts` covers the same model for the non-OAuth kinds;
 * `providers/oauth2.test.ts` covers the OAuth2 flow's own contract.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { KeyKind, OAuth2Provider as OAuth2Kind } from "../types.ts"
import { createTestAuth, FakeCookieJar, type TestAuth } from "../testing/harness.ts"
import type { OAuth2InstanceOptions } from "../lib.ts"

const STATE_COOKIE = "google_state"

/** A Google-shaped instance whose HTTP client is a fake. */
function googleInstance(profile: Record<string, unknown>): OAuth2InstanceOptions {
  return {
    provider: OAuth2Kind.Google,
    label: "google",
    authorizeUrl: "https://accounts.example.test/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.example.test/token",
    userInfoUrl: "https://userinfo.example.test/v3/userinfo",
    scope: "email profile",
    clientId: "test-client-id-not-real",
    clientSecret: "test-client-secret-not-real",
    redirectUri: "https://app.example.test/api/keys/google/callback",
    stateCookieName: STATE_COOKIE,
    subjectField: "sub",
    emailField: "email",
    firstNameField: "given_name",
    lastNameField: "family_name",
    pictureField: "picture",
    fetch: (input) => {
      const url = String(input)
      if (url.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "test-access-token-not-real" }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(new Response(JSON.stringify(profile), { status: 200 }))
    },
  }
}

/** Complete a Google callback against a fresh jar, returning the result. */
async function googleSignIn(auth: TestAuth, state?: string) {
  const jar = new FakeCookieJar()
  const redirect = new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const actualState = state ?? jar.get(STATE_COOKIE) ?? ""
  assert(redirect.searchParams.get("state") === actualState)
  return await auth.auth.oauth2.google.check("auth-code", actualState, jar)
}

function kindsOf(auth: TestAuth, userId: number): KeyKind[] {
  return auth.adapter
    .allKeys()
    .filter((key) => key.userId === userId)
    .map((key) => key.kind)
    .sort((left, right) => left - right)
}

/** Sorted kinds, written the way `kindsOf` returns them. */
function sorted(kinds: KeyKind[]): KeyKind[] {
  return [...kinds].sort((left, right) => left - right)
}

Deno.test("an OAuth signup for an address with a magic-link key produces two linked keys", async () => {
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-1", email: "user@example.com" }) },
  })

  // The address already holds a magic-link key.
  await auth.auth.magicLink.signUp("user@example.com")
  const userId = auth.adapter.allKeys().find((key) => key.kind === KeyKind.MagicLink)?.userId ?? 0
  assert(userId > 0)
  const usersBefore = auth.adapter.allUsers().length

  const everything = await googleSignIn(auth)

  assertEquals(everything.user.id, userId, "the OAuth signup must reuse the account")
  // Two keys on one account: the OAuth credential joined the existing magic-link
  // one, and the linking handler also attached OTP for the same address.
  assertEquals(
    kindsOf(auth, userId),
    sorted([KeyKind.MagicLink, KeyKind.Otp, KeyKind.OAuth2]),
    "the OAuth credential must join the existing magic-link account",
  )
  assertEquals(auth.adapter.allUsers().length, usersBefore, "no second account may be created")

  const oauthKey = auth.adapter.allKeys().find((key) => key.kind === KeyKind.OAuth2)
  assertEquals(oauthKey?.userId, userId)
  assertEquals(oauthKey?.identification, "google:google-subject-1")
  assertEquals(oauthKey?.email, "user@example.com")
})

Deno.test("connecting OAuth to a guest account drops the anonymous key", async () => {
  // The realistic guest flow: the transport already holds the guest's session, so it
  // passes the guest's user id and the OAuth credential joins *that* account. The
  // anonymous key is then dropped by the linking handler and the account survives.
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-2", email: "user@example.com" }) },
  })
  const guest = await auth.auth.anonymous.signUp()
  assertEquals(kindsOf(auth, guest.user.id), [KeyKind.Anonymous])

  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const state = jar.get(STATE_COOKIE) ?? ""
  const key = await auth.auth.oauth2.google.connect("auth-code", state, jar, guest.user.id)

  assertEquals(key.userId, guest.user.id)
  assertEquals(
    kindsOf(auth, guest.user.id).includes(KeyKind.Anonymous),
    false,
    "the anonymous key must be dropped",
  )
  assertEquals(
    kindsOf(auth, guest.user.id),
    sorted([KeyKind.MagicLink, KeyKind.OAuth2, KeyKind.Otp]),
    "the account keeps the durable methods the link attached",
  )
  assertEquals(await auth.auth.anonymous.isAnonymous(guest.user.id), false)
  assertEquals(auth.adapter.allUsers().length, 1, "the guest account must not be replaced")
  assert(await auth.auth.user.get(guest.user.id))
})

Deno.test("connecting OAuth drops the anonymous key even when a link already exists", async () => {
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-2b", email: "user@example.com" }) },
  })
  const guest = await auth.auth.anonymous.signUp()
  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const state = jar.get(STATE_COOKIE) ?? ""
  await auth.auth.oauth2.google.connect("auth-code", state, jar, guest.user.id)

  // A second connect is a no-op for the credential but must not resurrect the
  // guest key.
  const secondJar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(secondJar))
  const secondState = secondJar.get(STATE_COOKIE) ?? ""
  await auth.auth.oauth2.google.connect("auth-code", secondState, secondJar, guest.user.id)

  assertEquals(kindsOf(auth, guest.user.id).includes(KeyKind.Anonymous), false)
  assertEquals(
    auth.adapter.allKeys().filter((key) => key.kind === KeyKind.OAuth2).length,
    1,
  )
})

Deno.test("a guest that signs in with OAuth without a session ends up with a new account", async () => {
  // Documented boundary, not a defect: an anonymous credential carries no address,
  // so nothing connects the guest account to the address Google returns. The guest
  // account stays (the linking handlers never delete a user) and is orphaned.
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-2c", email: "user@example.com" }) },
  })
  const guest = await auth.auth.anonymous.signUp()
  const everything = await googleSignIn(auth)

  assert(everything.user.id !== guest.user.id, "an anonymous key cannot link by address")
  assertEquals(kindsOf(auth, guest.user.id), [KeyKind.Anonymous])
  assert(await auth.auth.user.get(guest.user.id), "the guest account must not be deleted")
})

Deno.test("a disconnect removes one credential and neither the user nor the siblings", async () => {
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-3", email: "user@example.com" }) },
  })
  await auth.auth.magicLink.signUp("user@example.com")
  const userId = auth.adapter.allKeys().find((key) => key.kind === KeyKind.MagicLink)?.userId ?? 0
  await googleSignIn(auth)
  assertEquals(kindsOf(auth, userId), sorted([KeyKind.MagicLink, KeyKind.Otp, KeyKind.OAuth2]))

  assertEquals(await auth.auth.oauth2.google.disconnect(userId), true)

  assertEquals(
    kindsOf(auth, userId),
    sorted([KeyKind.MagicLink, KeyKind.Otp]),
    "the sibling credentials must survive",
  )
  assert(await auth.auth.user.get(userId), "the account must survive")
  assertFalse(await auth.auth.anonymous.isAnonymous(userId))
})

Deno.test("a second Google sign-in for one subject reuses the credential", async () => {
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-4", email: "user@example.com" }) },
  })
  const first = await googleSignIn(auth)
  const second = await googleSignIn(auth)

  assertEquals(second.user.id, first.user.id)
  assertEquals(second.key.id, first.key.id, "the credential must not be duplicated")
  assertEquals(
    auth.adapter.allKeys().filter((key) => key.kind === KeyKind.OAuth2).length,
    1,
  )
})

Deno.test("an OAuth signup for an address with an email-password key attaches to that account", async () => {
  const auth = createTestAuth({
    oauth2: { google: googleInstance({ sub: "google-subject-5", email: "user@example.com" }) },
  })
  const registered = await auth.auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  const before = auth.adapter.allUsers().length

  const everything = await googleSignIn(auth)

  assertEquals(everything.user.id, registered.user.id)
  assertEquals(auth.adapter.allUsers().length, before)
  assertEquals(
    kindsOf(auth, registered.user.id),
    sorted([KeyKind.EmailPassword, KeyKind.MagicLink, KeyKind.OAuth2, KeyKind.Otp]),
    "the OAuth credential joins the account and the siblings stay",
  )
  // The password still works after the link.
  assert(await auth.auth.emailPassword.signIn("user@example.com", "hunter2-hunter2"))
})
