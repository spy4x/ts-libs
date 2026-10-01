// GitHub's provider config: its endpoints, how `/user` and `/user/emails` are read, and sign-ins
// through `createOAuthSignIn` with the fake provider answering at GitHub's own URLs and a fake
// `/user/emails` beside it.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SessionManager } from "../sign-in/mod.ts"

import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"
import { createOAuthSignIn, OAuthOutcome, OAuthSignInError } from "./oauth.ts"
import {
  createGitHubOAuthProvider,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_DEFAULT_SCOPES,
  GITHUB_EMAILS_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_ENDPOINT,
  readGitHubPrimaryEmail,
  readGitHubUser,
} from "./oauth-github.ts"
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

describe("createGitHubOAuthProvider", () => {
  it("points at GitHub's OAuth and REST endpoints", () => {
    expect(GITHUB_AUTHORIZATION_ENDPOINT).toBe("https://github.com/login/oauth/authorize")
    expect(GITHUB_TOKEN_ENDPOINT).toBe("https://github.com/login/oauth/access_token")
    expect(GITHUB_USER_ENDPOINT).toBe("https://api.github.com/user")
    expect(GITHUB_EMAILS_ENDPOINT).toBe("https://api.github.com/user/emails")
  })

  it("builds a config with id github, the client's credentials and the default scopes", () => {
    const config = createGitHubOAuthProvider({ clientId: "id", clientSecret: "secret" })
    expect(config).toMatchObject({
      id: "github",
      clientId: "id",
      clientSecret: "secret",
      authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      userInfoEndpoint: GITHUB_USER_ENDPOINT,
      scopes: ["read:user", "user:email"],
    })
    expect(GITHUB_DEFAULT_SCOPES).toEqual(["read:user", "user:email"])
  })

  it("passes the app's scopes and extra authorization parameters through", () => {
    const config = createGitHubOAuthProvider({
      clientId: "id",
      clientSecret: "secret",
      scopes: ["user:email"],
      authorizationParams: { allow_signup: "false" },
    })
    expect(config.scopes).toEqual(["user:email"])
    expect(config.authorizationParams).toEqual({ allow_signup: "false" })
  })
})

describe("readGitHubUser", () => {
  it("turns the numeric id into a decimal string subject, with no address", () => {
    expect(readGitHubUser({ id: 1234567, login: "ann", email: "ann@example.com" })).toEqual({
      subject: "1234567",
      email: null,
      emailVerified: false,
    })
  })

  for (
    const [name, body] of [
      ["a body without id", { login: "ann" }],
      ["a string id", { id: "1234567" }],
      ["a fractional id", { id: 1.5 }],
      ["a zero id", { id: 0 }],
      ["an id beyond the safe integers", { id: 2 ** 53 }],
      ["null", null],
    ] as const
  ) {
    it(`answers null for ${name}`, () => {
      expect(readGitHubUser(body)).toBeNull()
    })
  }
})

describe("readGitHubPrimaryEmail", () => {
  it("takes the address that is both primary and verified", () => {
    expect(readGitHubPrimaryEmail([
      { email: "old@example.com", primary: false, verified: true },
      { email: "ann@example.com", primary: true, verified: true, visibility: "private" },
    ])).toBe("ann@example.com")
  })

  it("ignores a primary address that is not verified", () => {
    expect(readGitHubPrimaryEmail([
      { email: "ann@example.com", primary: true, verified: false },
    ])).toBeNull()
  })

  it("ignores a verified address that is not primary", () => {
    expect(readGitHubPrimaryEmail([
      { email: "ann@example.com", primary: true, verified: false },
      { email: "work@example.com", primary: false, verified: true },
    ])).toBeNull()
  })

  it("counts only the boolean true as primary and verified", () => {
    expect(readGitHubPrimaryEmail([
      { email: "ann@example.com", primary: "true", verified: "true" },
    ])).toBeNull()
  })

  for (
    const [name, body] of [
      ["an empty list", []],
      ["an object instead of a list", { email: "ann@example.com", primary: true, verified: true }],
      ["null", null],
    ] as const
  ) {
    it(`answers null for ${name}`, () => {
      expect(readGitHubPrimaryEmail(body)).toBeNull()
    })
  }
})

describe("createOAuthSignIn with GitHub's config", () => {
  const ANN_ID = 583231

  function github(emails: unknown, emailsStatus = 200) {
    const store = new MemoryAuthStore()
    const sessions = new SessionManager<AuthSessionRecord>({
      store: createFakeStore<AuthSessionRecord>().store,
      pepper: PEPPER,
      durationMinutes: 60,
    })
    const provider = createFakeProvider({
      authorization: GITHUB_AUTHORIZATION_ENDPOINT,
      token: GITHUB_TOKEN_ENDPOINT,
      userInfo: GITHUB_USER_ENDPOINT,
    })
    provider.userInfoBody = { id: ANN_ID, login: "ann", email: null }
    const emailRequests: (string | null)[] = []
    const fetch = (request: Request): Promise<Response> => {
      if (request.url !== GITHUB_EMAILS_ENDPOINT) return provider.fetch(request)
      const authorization = request.headers.get("authorization")
      emailRequests.push(authorization)
      if (!/^Bearer token-\d+$/.test(authorization ?? "")) {
        return Promise.resolve(
          Response.json({ message: "Requires authentication" }, { status: 401 }),
        )
      }
      return Promise.resolve(Response.json(emails, { status: emailsStatus }))
    }
    const oauth = createOAuthSignIn({
      store,
      sessions,
      clock: fixedClock(),
      provider: createGitHubOAuthProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
      }),
      redirectUri: REDIRECT_URI,
      fetch,
    })
    return { store, provider, oauth, emailRequests }
  }

  it("keys the person by the numeric id as a string under method oauth:github", async () => {
    const { oauth, provider, emailRequests } = github([])
    const result = await signInAs(oauth, provider, { sub: "unused" })
    expect(result.key).toMatchObject({
      method: "oauth:github",
      subject: "583231",
      email: null,
      provenAt: null,
    })
    expect(emailRequests).toEqual([expect.stringMatching(/^Bearer token-\d+$/)])
  })

  it("puts the primary, verified address on a proven key", async () => {
    const { oauth, provider } = github([
      { email: "other@example.com", primary: false, verified: true },
      { email: "Ann@Example.com", primary: true, verified: true },
    ])
    const result = await signInAs(oauth, provider, { sub: "unused" })
    expect(result.profile).toEqual({
      subject: "583231",
      email: "Ann@Example.com",
      emailVerified: true,
    })
    expect(result.key).toMatchObject({ email: "ann@example.com", provenAt: NOW })
  })

  it("never links through an unverified primary address", async () => {
    const { store, oauth, provider } = github([
      { email: "ann@example.com", primary: true, verified: false },
    ])
    const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
    const result = await signInAs(oauth, provider, { sub: "unused" })
    expect(result.outcome).toBe(OAuthOutcome.SignedUp)
    expect(result.user.id).not.toBe(owner.user.id)
    expect(result.key.email).toBeNull()
  })

  it("never links through a verified address that is not primary", async () => {
    const { store, oauth, provider } = github([
      { email: "me@example.com", primary: true, verified: false },
      { email: "ann@example.com", primary: false, verified: true },
    ])
    const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
    const result = await signInAs(oauth, provider, { sub: "unused" })
    expect(result.outcome).toBe(OAuthOutcome.SignedUp)
    expect(result.user.id).not.toBe(owner.user.id)
    expect(result.key.email).toBeNull()
  })

  it("links through the primary, verified address to the user who owns it", async () => {
    const { store, oauth, provider } = github([
      { email: "ann@example.com", primary: true, verified: true },
    ])
    const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
    const result = await signInAs(oauth, provider, { sub: "unused" })
    expect(result.outcome).toBe(OAuthOutcome.Linked)
    expect(result.user.id).toBe(owner.user.id)
  })

  it("refuses the sign-in as profile-failed when /user/emails fails", async () => {
    const { store, oauth, provider } = github({ message: "Service unavailable" }, 503)
    const error = await signInAs(oauth, provider, { sub: "unused" }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OAuthSignInError)
    expect((error as OAuthSignInError).reason).toBe("profile-failed")
    expect(await store.findKey("oauth:github", "583231")).toBeNull()
  })
})
