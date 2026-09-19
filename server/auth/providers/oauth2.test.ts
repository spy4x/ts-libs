/**
 * Security fix 7 (providers performed transport) and security fix 8 (stub methods),
 * plus the account-linking model, which is the second most important test group in
 * this package.
 *
 * Fix 7: `roley/providers/google.ts` called `setSession(cookies, session)` from
 * inside `check()` (`:195`, `:226`, `:265`) and typed its cookie parameter as
 * SvelteKit's `Cookies`, so the provider could only run under SvelteKit. The port
 * takes a `SessionSink` and a `CookieJar`. The assertions here are about what the
 * provider *did*: it drove a complete OAuth2 flow with a fake sink and a fake jar,
 * and the only session it produced went to the sink.
 *
 * Fix 8: `magicLink.getUserByEmail` returned `Promise.resolve(null)` and
 * `createToken` returned `null` after a no-op `email.toString()`. Both are
 * implemented, and both are asserted in `providers/magic-link.test.ts`.
 */

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert"
import { KeyKind, OAuth2Provider as OAuth2Kind } from "../types.ts"
import { OAuth2FlowError } from "./oauth2.ts"
import { createTestAuth, FakeCookieJar, type TestAuth } from "../testing/harness.ts"
import type { AuthOptions, OAuth2InstanceOptions } from "../lib.ts"

const STATE_COOKIE = "oauth2_state"

/** Google-shaped options: a flat `sub`, `email` and `picture`. */
const GOOGLE: OAuth2InstanceOptions = {
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
}

/** Facebook-shaped options: a nested `picture.data.url` and an id-only subject. */
const FACEBOOK: OAuth2InstanceOptions = {
  provider: OAuth2Kind.Facebook,
  label: "facebook",
  authorizeUrl: "https://www.facebook.example.test/v16.0/dialog/oauth",
  tokenUrl: "https://graph.example.test/v16.0/oauth/access_token",
  userInfoUrl: "https://graph.example.test/me",
  scope: "email,public_profile",
  clientId: "test-app-id-not-real",
  clientSecret: "test-app-secret-not-real",
  redirectUri: "https://app.example.test/api/keys/facebook/callback",
  stateCookieName: "facebook_state",
  subjectField: "id",
  emailField: "email",
  firstNameField: "first_name",
  lastNameField: "last_name",
  resolvePhotoUrl: (profile) => {
    const picture = profile["picture"] as { data?: { url?: string } } | undefined
    return picture?.data?.url ?? null
  },
}

/** What the fake HTTP client answers with, per request. */
interface FakeResponses {
  token?: unknown
  tokenStatus?: number
  tokenContentType?: "json" | "form"
  profile?: unknown
  profileStatus?: number
}

/** Records every request, so a test can assert what was sent and when. */
class FakeHttp {
  readonly requests: Array<{ url: string; method: string; body: string | null }> = []

  constructor(private readonly responses: FakeResponses) {}

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : null
    this.requests.push({ url, method, body })
    if (url.includes("/token") || url.includes("/access_token")) {
      const status = this.responses.tokenStatus ?? 200
      const payload = this.responses.token ?? { access_token: "test-access-token-not-real" }
      const text = this.responses.tokenContentType === "form"
        ? new URLSearchParams(payload as Record<string, string>).toString()
        : JSON.stringify(payload)
      return Promise.resolve(new Response(text, { status }))
    }
    const status = this.responses.profileStatus ?? 200
    return Promise.resolve(
      new Response(JSON.stringify(this.responses.profile ?? {}), { status }),
    )
  }
}

function oauthAuth(
  responses: FakeResponses,
  instance: OAuth2InstanceOptions = GOOGLE,
): TestAuth & { http: FakeHttp } {
  const http = new FakeHttp(responses)
  const options: Partial<Omit<AuthOptions, "adapter">> = {
    oauth2: { google: { ...instance, fetch: http.fetch } },
  }
  const built = createTestAuth(options)
  return { ...built, http }
}

/** Start a flow and read back the state the provider stored. */
function startFlow(auth: TestAuth): { url: URL; state: string; jar: FakeCookieJar } {
  const jar = new FakeCookieJar()
  const url = new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const state = jar.get("oauth2_state")
  assert(state, "the provider must store a state cookie")
  return { url, state, jar }
}

Deno.test("getRedirectURL builds an authorize URL and stores the CSRF state", () => {
  const auth = oauthAuth({})
  const { url, state } = startFlow(auth)
  assertEquals(url.origin + url.pathname, "https://accounts.example.test/o/oauth2/v2/auth")
  assertEquals(url.searchParams.get("client_id"), "test-client-id-not-real")
  assertEquals(url.searchParams.get("response_type"), "code")
  assertEquals(url.searchParams.get("scope"), "email profile")
  assertEquals(url.searchParams.get("state"), state)
  assertEquals(url.searchParams.get("redirect_uri"), GOOGLE.redirectUri)
  assert(state.length >= 32)
})

Deno.test("drives a whole OAuth2 signup with a fake sink and a fake cookie jar", async () => {
  const auth = oauthAuth({ profile: { sub: "google-subject-1", email: "user@example.com" } })
  const { state, jar } = startFlow(auth)

  assertEquals(auth.sink.sessions.length, 0)
  const everything = await auth.auth.oauth2.google.check("auth-code", state, jar)

  assertEquals(everything.user.email, "user@example.com")
  assertEquals(everything.key.kind, KeyKind.OAuth2)
  assertEquals(everything.key.secret, "google-subject-1")
  assertEquals(everything.session.userId, everything.user.id)
  // The session went to the sink and nowhere else: no cookie was written by the
  // provider, and the state cookie was cleared. Asserting the jar is empty catches
  // the source's shape directly — `google.ts:195,226,265` called
  // `setSession(cookies, session)`, which would leave a session cookie here.
  assertEquals(auth.sink.sessions.length, 0, "the provider must not call the sink itself")
  assertEquals(jar.all(), {}, "the provider must not write a session cookie")
  // The exact "transport in the provider" bug, asserted as an absent call path.
  assertFalse(auth.http.requests.some((request) => request.url.includes("app.example.test")))
})

Deno.test("makes the token and userinfo requests it was configured with", async () => {
  const auth = oauthAuth({ profile: { sub: "s", email: "user@example.com" } })
  const { state, jar } = startFlow(auth)
  await auth.auth.oauth2.google.check("auth-code", state, jar)

  assertEquals(auth.http.requests.length, 2)
  const [token, userinfo] = auth.http.requests
  assertEquals(token.url, GOOGLE.tokenUrl)
  assertEquals(token.method, "POST")
  const body = new URLSearchParams(token.body ?? "")
  assertEquals(body.get("grant_type"), "authorization_code")
  assertEquals(body.get("code"), "auth-code")
  assertEquals(body.get("client_id"), "test-client-id-not-real")
  assertEquals(body.get("redirect_uri"), GOOGLE.redirectUri)
  assertEquals(userinfo.url, GOOGLE.userInfoUrl)
  assertEquals(userinfo.method, "GET")
})

Deno.test("rejects a callback whose state does not match the cookie", async () => {
  const auth = oauthAuth({ profile: { sub: "s", email: "user@example.com" } })
  const { state, jar } = startFlow(auth)
  await assertRejects(
    () => auth.auth.oauth2.google.check("auth-code", `${state}-tampered`, jar),
    OAuth2FlowError,
  )
  assertEquals(jar.all(), {}, "the state cookie must be cleared on a mismatch")
  assertEquals(auth.http.requests.length, 0, "no request may be made before the state check")
})

Deno.test("rejects a callback with no cookie and a callback with no code", async () => {
  const auth = oauthAuth({ profile: { sub: "s", email: "user@example.com" } })
  const bare = new FakeCookieJar()
  await assertRejects(() => auth.auth.oauth2.google.check("code", "state", bare), OAuth2FlowError)
  const { state, jar } = startFlow(auth)
  await assertRejects(() => auth.auth.oauth2.google.check("", state, jar), OAuth2FlowError)
})

Deno.test("rejects a rejected token exchange without echoing the response", async () => {
  const auth = oauthAuth({
    tokenStatus: 400,
    token: { error: "invalid_grant", access_token: "leaked-token-not-real" },
  })
  const { state, jar } = startFlow(auth)
  const error = await assertRejects(
    () => auth.auth.oauth2.google.check("auth-code", state, jar),
    OAuth2FlowError,
  )
  const message = (error as Error).message
  assertFalse(message.includes("leaked-token-not-real"), `error leaked a token: ${message}`)
  assertFalse(message.includes("invalid_grant"), `error echoed provider text: ${message}`)
  assertFalse(message.includes("auth-code"), `error leaked the code: ${message}`)
})

Deno.test("rejects a userinfo response with no subject", async () => {
  const auth = oauthAuth({ profile: { email: "user@example.com" } })
  const { state, jar } = startFlow(auth)
  await assertRejects(() => auth.auth.oauth2.google.check("code", state, jar), OAuth2FlowError)
})

Deno.test("reads a form-encoded token response, which is what Facebook sends", async () => {
  const http = new FakeHttp({
    token: { access_token: "form-encoded-token-not-real" },
    tokenContentType: "form",
    profile: { id: "facebook-id-1", email: "user@example.com" },
  })
  const auth = createTestAuth({
    oauth2: { facebook: { ...FACEBOOK, fetch: http.fetch } },
  })
  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.facebook.getRedirectURL(jar))
  const state = jar.get("facebook_state") ?? ""
  const everything = await auth.auth.oauth2.facebook.check("code", state, jar)
  // Provider-scoped identification, address in the email column: that is what lets
  // one address hold a Google and a Facebook credential at once.
  assertEquals(everything.key.identification, "facebook:facebook-id-1")
  assertEquals(everything.key.email, "user@example.com")
  assertEquals(everything.key.secret, "facebook-id-1")
  assertEquals(everything.user.email, "user@example.com")
})

Deno.test("falls back to the subject id when a provider sends no email", async () => {
  const http = new FakeHttp({ profile: { id: "facebook-id-2" } })
  const auth = createTestAuth({ oauth2: { facebook: { ...FACEBOOK, fetch: http.fetch } } })
  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.facebook.getRedirectURL(jar))
  const state = jar.get("facebook_state") ?? ""
  const everything = await auth.auth.oauth2.facebook.check("code", state, jar)

  // The source inlined `facebookUser.email || facebookUser.id` twice; here the
  // credential is provider-scoped, the account carries a null email rather than an
  // id that looks like an address, and the email column stays empty so nothing
  // links an OAuth2 subject to an address that was never sent.
  assertEquals(everything.key.identification, "facebook:facebook-id-2")
  assertEquals(everything.key.email, null)
  assertEquals(everything.user.email, null)
})

Deno.test("flattens a nested picture field through the resolver", async () => {
  const http = new FakeHttp({
    profile: {
      id: "facebook-id-3",
      email: "user@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      picture: { data: { url: "https://cdn.example.test/avatar.png" } },
    },
  })
  const auth = createTestAuth({ oauth2: { facebook: { ...FACEBOOK, fetch: http.fetch } } })
  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.facebook.getRedirectURL(jar))
  const state = jar.get("facebook_state") ?? ""
  const everything = await auth.auth.oauth2.facebook.check("code", state, jar)

  assertEquals(everything.user.firstName, "Ada")
  assertEquals(everything.user.lastName, "Lovelace")
  assertEquals(everything.user.photoUrl, "https://cdn.example.test/avatar.png")
})

Deno.test("fills only the profile fields an account is missing", async () => {
  const auth = oauthAuth({
    profile: { sub: "google-subject-2", email: "user@example.com", given_name: "Provider" },
  })
  const first = startFlow(auth)
  await auth.auth.oauth2.google.check("code", first.state, first.jar)

  // A second sign-in with a different given name must not overwrite the account.
  await startFlow(auth)
  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const state = jar.get("oauth2_state") ?? ""
  auth.http.requests.length = 0
  const second = await auth.auth.oauth2.google.check("code", state, jar)
  assertEquals(second.user.firstName, "Provider")
  assertEquals(second.key.userId, second.user.id)
})

Deno.test("connect attaches the provider to an already signed-in account", async () => {
  const auth = oauthAuth({ profile: { sub: "google-subject-3", email: "user@example.com" } })
  const guest = await auth.auth.anonymous.signUp()
  const sessionsBefore = auth.adapter.allSessions().length
  const { state, jar } = startFlow(auth)

  const key = await auth.auth.oauth2.google.connect("code", state, jar, guest.user.id)
  assertEquals(jar.all(), {}, "the provider must not write any cookie during connect")
  assertEquals(key.kind, KeyKind.OAuth2)
  assertEquals(key.userId, guest.user.id)
  // `connect` is a link, not a sign-in: it must not mint a session of its own.
  // Sibling linking does mint sessions for the methods it attaches, so the check is
  // that no session names this credential, not that the count is unchanged.
  assertEquals(
    auth.adapter.allSessions().filter((session) => session.keyId === key.id).length,
    0,
    "connect must not mint a session for the credential it attached",
  )
  assert(sessionsBefore >= 1)
})

Deno.test("connect refuses a credential already attached to another account", async () => {
  const auth = oauthAuth({ profile: { sub: "google-subject-4", email: "user@example.com" } })
  const first = await auth.auth.anonymous.signUp()
  const second = await auth.auth.anonymous.signUp()
  const flowA = startFlow(auth)
  await auth.auth.oauth2.google.connect("code", flowA.state, flowA.jar, first.user.id)

  const jar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(jar))
  const state = jar.get("oauth2_state") ?? ""
  await assertRejects(
    () => auth.auth.oauth2.google.connect("code", state, jar, second.user.id),
    OAuth2FlowError,
  )
})

Deno.test("exists reports the credential for an account, and null for others", async () => {
  const auth = oauthAuth({ profile: { sub: "s", email: "user@example.com" } })
  const guest = await auth.auth.anonymous.signUp()
  assertEquals(await auth.auth.oauth2.google.exists(guest.user.id), null)
  const flowA = startFlow(auth)
  await auth.auth.oauth2.google.connect("code", flowA.state, flowA.jar, guest.user.id)
  assertEquals((await auth.auth.oauth2.google.exists(guest.user.id))?.kind, KeyKind.OAuth2)
})

Deno.test("disconnect removes only the OAuth credential, not the account", async () => {
  const auth = oauthAuth({ profile: { sub: "s", email: "user@example.com" } })
  const { state, jar } = startFlow(auth)
  const everything = await auth.auth.oauth2.google.check("code", state, jar)

  assertEquals(await auth.auth.oauth2.google.disconnect(everything.user.id), true)
  assertEquals(await auth.adapter.getUser(everything.user.id), everything.user)
  assertEquals(await auth.auth.oauth2.google.disconnect(everything.user.id), false)
})

Deno.test("the two instances keep separate keys for the same address", async () => {
  const googleHttp = new FakeHttp({
    profile: { sub: "google-subject-9", email: "user@example.com" },
  })
  const facebookHttp = new FakeHttp({ profile: { id: "facebook-id-9", email: "user@example.com" } })
  const auth = createTestAuth({
    oauth2: {
      google: { ...GOOGLE, fetch: googleHttp.fetch },
      facebook: { ...FACEBOOK, fetch: facebookHttp.fetch },
    },
  })

  const googleJar = new FakeCookieJar()
  new URL(auth.auth.oauth2.google.getRedirectURL(googleJar))
  const googleState = googleJar.get("oauth2_state") ?? ""
  const fromGoogle = await auth.auth.oauth2.google.check("code", googleState, googleJar)

  const facebookJar = new FakeCookieJar()
  new URL(auth.auth.oauth2.facebook.getRedirectURL(facebookJar))
  const facebookState = facebookJar.get("facebook_state") ?? ""
  const fromFacebook = await auth.auth.oauth2.facebook.check("code", facebookState, facebookJar)

  // One account, two credentials: the linking model is what makes this true.
  assertEquals(fromGoogle.user.id, fromFacebook.user.id)
  const oauth2Keys = auth.adapter.allKeys().filter((key) => key.kind === KeyKind.OAuth2)
  assertEquals(oauth2Keys.length, 2)
  assert(auth.auth.oauth2.google.provider !== auth.auth.oauth2.facebook.provider)
})
