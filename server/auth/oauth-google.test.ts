// Google's provider config: its endpoints, how its user-info answer is read, and one sign-in through
// `createOAuthSignIn` with the fake provider answering at Google's own URLs.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SessionManager } from "../sign-in/mod.ts"

import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"
import { createOAuthSignIn, OAuthOutcome } from "./oauth.ts"
import {
  createGoogleOAuthProvider,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_DEFAULT_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  readGoogleProfile,
} from "./oauth-google.ts"
import {
  createFakeProvider,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  fixedClock,
  PEPPER,
  REDIRECT_URI,
  signInAs,
} from "./oauth-scenarios.test.ts"
import { emailKey, NOW } from "./store-contract.test.ts"

describe("createGoogleOAuthProvider", () => {
  it("points at the endpoints of Google's OpenID Connect discovery document", () => {
    // https://accounts.google.com/.well-known/openid-configuration, read on 2026-09-23.
    expect(GOOGLE_AUTHORIZATION_ENDPOINT).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(GOOGLE_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token")
    expect(GOOGLE_USERINFO_ENDPOINT).toBe("https://openidconnect.googleapis.com/v1/userinfo")
  })

  it("builds a config with id google, the client's credentials and the default scopes", () => {
    const config = createGoogleOAuthProvider({ clientId: "id", clientSecret: "secret" })
    expect(config).toMatchObject({
      id: "google",
      clientId: "id",
      clientSecret: "secret",
      authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
      userInfoEndpoint: GOOGLE_USERINFO_ENDPOINT,
      scopes: ["openid", "email"],
    })
    expect(GOOGLE_DEFAULT_SCOPES).toEqual(["openid", "email"])
  })

  it("passes the app's scopes and extra authorization parameters through", () => {
    const config = createGoogleOAuthProvider({
      clientId: "id",
      clientSecret: "secret",
      scopes: ["openid", "email", "profile"],
      authorizationParams: { prompt: "select_account" },
    })
    expect(config.scopes).toEqual(["openid", "email", "profile"])
    expect(config.authorizationParams).toEqual({ prompt: "select_account" })
  })
})

describe("readGoogleProfile", () => {
  it("reads sub, email and email_verified: true", () => {
    expect(readGoogleProfile({ sub: "1", email: "Ann@gmail.com", email_verified: true })).toEqual({
      subject: "1",
      email: "Ann@gmail.com",
      emailVerified: true,
    })
  })

  it("treats email_verified: false as not vouched for", () => {
    expect(readGoogleProfile({ sub: "1", email: "a@x.com", email_verified: false })?.emailVerified)
      .toBe(false)
  })

  it("treats a missing email_verified as not vouched for", () => {
    expect(readGoogleProfile({ sub: "1", email: "a@x.com" })?.emailVerified).toBe(false)
  })

  it("treats a string email_verified as not vouched for", () => {
    expect(readGoogleProfile({ sub: "1", email: "a@x.com", email_verified: "true" })).toEqual({
      subject: "1",
      email: "a@x.com",
      emailVerified: false,
    })
  })

  it("reports no address and nothing vouched for when email is missing", () => {
    expect(readGoogleProfile({ sub: "1", email_verified: true })).toEqual({
      subject: "1",
      email: null,
      emailVerified: false,
    })
  })

  it("ignores the other fields Google sends, such as name and picture", () => {
    const body = { sub: "1", email: "a@x.com", email_verified: true, name: "Ann", picture: "p" }
    expect(readGoogleProfile(body)).toEqual({ subject: "1", email: "a@x.com", emailVerified: true })
  })

  for (
    const [name, body] of [
      ["a body without sub", { email: "a@x.com", email_verified: true }],
      ["a numeric sub", { sub: 1 }],
      ["a body that is not an object", "sub"],
      ["null", null],
    ] as const
  ) {
    it(`answers null for ${name}`, () => {
      expect(readGoogleProfile(body)).toBeNull()
    })
  }
})

describe("createOAuthSignIn with Google's config", () => {
  function google() {
    const store = new MemoryAuthStore()
    const sessions = new SessionManager<AuthSessionRecord>({
      store: createFakeStore<AuthSessionRecord>().store,
      pepper: PEPPER,
      durationMinutes: 60,
    })
    const provider = createFakeProvider({
      authorization: GOOGLE_AUTHORIZATION_ENDPOINT,
      token: GOOGLE_TOKEN_ENDPOINT,
      userInfo: GOOGLE_USERINFO_ENDPOINT,
    })
    const oauth = createOAuthSignIn({
      store,
      sessions,
      clock: fixedClock(),
      provider: createGoogleOAuthProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
      }),
      redirectUri: REDIRECT_URI,
      fetch: provider.fetch,
    })
    return { store, provider, oauth }
  }

  it("sends the browser to Google's authorization endpoint", async () => {
    const { oauth } = google()
    const { url } = await oauth.authorizationUrl()
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT)
  })

  it("keys the person by Google's sub under method oauth:google", async () => {
    const { oauth, provider } = google()
    const result = await signInAs(oauth, provider, {
      sub: "109876543210",
      email: "Ann@Gmail.com",
      email_verified: true,
    })
    expect(result.key).toMatchObject({
      method: "oauth:google",
      subject: "109876543210",
      email: "ann@gmail.com",
      provenAt: NOW,
    })
  })

  it("gives a pre-registered address back to the person Google vouches for", async () => {
    const { store, provider, oauth } = google()
    const attacker = await store.createUserWithKey(emailKey("password", "vic@gmail.com"))
    const victim = await signInAs(oauth, provider, {
      sub: "victim",
      email: "vic@gmail.com",
      email_verified: true,
    })
    expect(victim.outcome).toBe(OAuthOutcome.SignedUp)
    expect(victim.user.id).not.toBe(attacker.user.id)
    expect(await store.listKeys(attacker.user.id)).toEqual([])
    expect(await store.findUserIdByProvenEmail("vic@gmail.com")).toBe(victim.user.id)
  })
})
