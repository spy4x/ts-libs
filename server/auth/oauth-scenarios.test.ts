// The OAuth sign-in scenarios, written once and run against both stores: `oauth.test.ts` runs them
// on `MemoryAuthStore` in the unit tier, `oauth.integration.test.ts` on the Postgres store. Also the
// fake provider every OAuth test drives.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeOAuthScenarios`.
//
// The fake provider is an in-process Hono app answering the three OAuth2 endpoints the way a real
// provider does: `/authorize` redirects with a single-use code bound to the PKCE challenge, `/token`
// redeems it only with the matching `code_verifier`, client secret and redirect URI, and `/userinfo`
// answers the person for the access token. No socket is bound: `fetch` hands the request to the
// app's own `fetch`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { encodeBase64Url } from "@std/encoding/base64url"
import { Hono } from "hono"
import { SessionManager } from "@spy4x/server/sign-in"

import type { AuthSessionRecord } from "./model.ts"
import {
  createOAuthSignIn,
  OAuthOutcome,
  type OAuthProfile,
  type OAuthProviderConfig,
  type OAuthSignIn,
  type OAuthSignInOptions,
  type OAuthSignInResult,
} from "./oauth.ts"
import type { AuthStore } from "./store.ts"
import { emailKey, NOW } from "./store-contract.test.ts"

/** The person the fake provider signs in, in the shape an OIDC user-info endpoint answers. */
export interface FakeIdentity {
  sub: string
  email?: string
  email_verified?: boolean
}

/** Where the fake provider pretends to live. */
export interface FakeEndpoints {
  authorization: string
  token: string
  userInfo: string
}

/** A fake provider plus the handles a test steers and inspects it through. */
export interface FakeProvider {
  /** Sends a request to the fake as the network would. Pass it as the `fetch` option. */
  fetch(request: Request): Promise<Response>
  /**
   * Plays the person approving the sign-in at `url`, as `identity`. Returns the query the provider
   * redirects the browser back to the app with.
   */
  approve(url: URL, identity: FakeIdentity): Promise<URLSearchParams>
  /** How `/userinfo` fails: `"status"` answers 500, `"throw"` makes the request reject. */
  userInfoFailure: "status" | "throw" | null
  /** How `/token` fails: `"status"` answers 400, `"throw"` makes the request reject. */
  tokenFailure: "status" | "throw" | null
  /** Replaces the user-info answer for every token, when set. */
  userInfoBody: unknown
  /** Every `/token` answer's status, in order. */
  tokenStatuses: number[]
}

export const FAKE_CLIENT_ID = "fake-client-id"
/** Obviously fake. */
export const FAKE_CLIENT_SECRET = "fake-client-secret-not-a-real-secret"
export const REDIRECT_URI = "https://app.test/auth/callback"
export const FAKE_ENDPOINTS: FakeEndpoints = {
  authorization: "https://provider.test/authorize",
  token: "https://provider.test/token",
  userInfo: "https://provider.test/userinfo",
}
/** Obviously fake, long enough for `SessionManager`'s 32-character floor. */
export const PEPPER = "test-pepper-not-a-real-secret-0123456789"
export const MINUTE = 60_000

/** Reads an OIDC user-info body the way a provider config does. Google's has its own. */
export function readFakeProfile(body: unknown): OAuthProfile | null {
  if (typeof body !== "object" || body === null) return null
  const { sub, email, email_verified } = body as Record<string, unknown>
  if (typeof sub !== "string") return null
  return {
    subject: sub,
    email: typeof email === "string" ? email : null,
    emailVerified: email_verified === true,
  }
}

/** A provider config for the fake, with id `id`. */
export function fakeProviderConfig(id = "fake"): OAuthProviderConfig {
  return {
    id,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    authorizationEndpoint: FAKE_ENDPOINTS.authorization,
    tokenEndpoint: FAKE_ENDPOINTS.token,
    userInfoEndpoint: FAKE_ENDPOINTS.userInfo,
    scopes: ["openid", "email"],
    profile: readFakeProfile,
  }
}

/** RFC 7636's S256, computed here on its own so the fake does not trust the code under test. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return encodeBase64Url(new Uint8Array(digest))
}

interface IssuedCode {
  identity: FakeIdentity
  clientId: string
  redirectUri: string
  challenge: string
}

/** Creates a fake provider answering at `endpoints`. */
export function createFakeProvider(endpoints: FakeEndpoints = FAKE_ENDPOINTS): FakeProvider {
  const codes = new Map<string, IssuedCode>()
  const tokens = new Map<string, FakeIdentity>()
  let approving: FakeIdentity | null = null
  let counter = 0

  const app = new Hono()
  app.get("/authorize", (c) => {
    const q = new URL(c.req.url).searchParams
    const clientId = q.get("client_id")
    const redirectUri = q.get("redirect_uri")
    const challenge = q.get("code_challenge")
    if (
      q.get("response_type") !== "code" || clientId !== FAKE_CLIENT_ID || !redirectUri ||
      !challenge || q.get("code_challenge_method") !== "S256" || !q.get("state") || !approving
    ) {
      return c.json({ error: "invalid_request" }, 400)
    }
    const code = `code-${++counter}`
    codes.set(code, { identity: approving, clientId, redirectUri, challenge })
    const back = new URL(redirectUri)
    back.searchParams.set("code", code)
    back.searchParams.set("state", q.get("state") as string)
    return c.redirect(back.href, 302)
  })
  app.post("/token", async (c) => {
    if (fake.tokenFailure === "status") return c.json({ error: "server_error" }, 400)
    const form = await c.req.parseBody()
    const code = typeof form.code === "string" ? form.code : ""
    const issued = codes.get(code)
    // A code is single-use, whether or not the redemption succeeds.
    codes.delete(code)
    const verifier = typeof form.code_verifier === "string" ? form.code_verifier : ""
    if (
      !issued || form.grant_type !== "authorization_code" ||
      form.client_id !== issued.clientId || form.client_secret !== FAKE_CLIENT_SECRET ||
      form.redirect_uri !== issued.redirectUri || verifier === "" ||
      (await s256(verifier)) !== issued.challenge
    ) {
      return c.json({ error: "invalid_grant" }, 400)
    }
    const accessToken = `token-${++counter}`
    tokens.set(accessToken, issued.identity)
    return c.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3599 })
  })
  app.get("/userinfo", (c) => {
    if (fake.userInfoFailure === "status") return c.json({ error: "server_error" }, 500)
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")
    const identity = bearer ? tokens.get(bearer[1]) : undefined
    if (!identity) return c.json({ error: "invalid_token" }, 401)
    return c.json(fake.userInfoBody ?? identity)
  })

  /** Maps a request for one of `endpoints` onto the app's own path. */
  function route(request: Request): Request {
    const url = new URL(request.url)
    const target = `${url.origin}${url.pathname}`
    const path = target === endpoints.token
      ? "/token"
      : target === endpoints.userInfo
      ? "/userinfo"
      : target === endpoints.authorization
      ? "/authorize"
      : null
    if (path === null) throw new TypeError(`the fake provider does not answer ${target}`)
    return new Request(new URL(`${path}${url.search}`, "http://fake.internal"), request)
  }

  const fake: FakeProvider = {
    async fetch(request: Request): Promise<Response> {
      const routed = route(request)
      const path = new URL(routed.url).pathname
      if (path === "/token" && fake.tokenFailure === "throw") throw new TypeError("network down")
      if (path === "/userinfo" && fake.userInfoFailure === "throw") {
        throw new TypeError("network down")
      }
      const response = await app.fetch(routed)
      if (path === "/token") fake.tokenStatuses.push(response.status)
      return response
    },
    async approve(url: URL, identity: FakeIdentity): Promise<URLSearchParams> {
      approving = identity
      try {
        const response = await app.fetch(route(new Request(url)))
        const location = response.headers.get("location")
        if (response.status !== 302 || !location) {
          throw new Error(`the fake provider refused the authorization request: ${response.status}`)
        }
        return new URL(location).searchParams
      } finally {
        approving = null
      }
    },
    userInfoFailure: null,
    tokenFailure: null,
    userInfoBody: undefined,
    tokenStatuses: [],
  }
  return fake
}

/** A clock fixed at {@link NOW} unless a test moves it. */
export function fixedClock(): { now(): number; advance(ms: number): void } {
  let current = NOW.getTime()
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/** Starts a flow, approves it as `identity`, and completes the callback in the same browser. */
export async function signInAs(
  oauth: OAuthSignIn,
  provider: FakeProvider,
  identity: FakeIdentity,
): Promise<OAuthSignInResult> {
  const started = await oauth.authorizationUrl()
  const query = await provider.approve(started.url, identity)
  return await oauth.handleCallback({ query, browserState: started.state })
}

/** A fresh, empty store and session manager, and how to dispose of them. */
export interface OAuthFixture {
  store: AuthStore
  sessions: SessionManager<AuthSessionRecord>
  close(): Promise<void>
}

/** The options for a sign-in with the fake provider on `fixture`. */
export function fakeOptions(
  fixture: OAuthFixture,
  provider: FakeProvider,
  id = "fake",
): OAuthSignInOptions {
  return {
    store: fixture.store,
    sessions: fixture.sessions,
    clock: fixedClock(),
    provider: fakeProviderConfig(id),
    redirectUri: REDIRECT_URI,
    fetch: provider.fetch,
  }
}

/** Registers the account-resolution scenarios against the stores `open` returns. */
export function describeOAuthScenarios(name: string, open: () => Promise<OAuthFixture>): void {
  async function run(
    body: (fixture: OAuthFixture, provider: FakeProvider, oauth: OAuthSignIn) => Promise<void>,
  ): Promise<void> {
    const fixture = await open()
    try {
      const provider = createFakeProvider()
      await body(fixture, provider, createOAuthSignIn(fakeOptions(fixture, provider)))
    } finally {
      await fixture.close()
    }
  }

  describe(`${name}: OAuth sign-in scenarios`, () => {
    it("signs up a new sub with no email as a new user whose key carries no address", () =>
      run(async ({ store }, provider, oauth) => {
        const result = await signInAs(oauth, provider, { sub: "sub-1" })
        expect(result.outcome).toBe(OAuthOutcome.SignedUp)
        expect(result.key).toMatchObject({
          userId: result.user.id,
          method: "oauth:fake",
          subject: "sub-1",
          email: null,
          secret: null,
          provenAt: null,
        })
        expect(result.session.session).toMatchObject({
          userId: result.user.id,
          keyId: result.key.id,
        })
        expect(await store.findKey("oauth:fake", "sub-1")).toEqual(result.key)
      }))

    it("signs up a new sub with a verified email on a proven key carrying the normalised address", () =>
      run(async ({ store }, provider, oauth) => {
        const result = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: " Ann@Example.COM ",
          email_verified: true,
        })
        expect(result.outcome).toBe(OAuthOutcome.SignedUp)
        expect(result.key.email).toBe("ann@example.com")
        expect(result.key.provenAt).toEqual(NOW)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(result.user.id)
      }))

    it("signs the same sub in again to the same user and key, whatever the email says now", () =>
      run(async ({ store }, provider, oauth) => {
        const first = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: "ann@example.com",
          email_verified: true,
        })
        const again = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: "someone-else@example.com",
          email_verified: false,
        })
        expect(again.outcome).toBe(OAuthOutcome.SignedIn)
        expect(again.user.id).toBe(first.user.id)
        expect(again.key.id).toBe(first.key.id)
        expect(again.session.session.keyId).toBe(first.key.id)
        expect(await store.listKeys(first.user.id)).toHaveLength(1)
      }))

    it("matches by sub, not by email: a new sub never lands on a key another sub created", () =>
      run(async ({ store }, provider, oauth) => {
        const first = await signInAs(oauth, provider, { sub: "sub-1", email: "ann@example.com" })
        const second = await signInAs(oauth, provider, { sub: "sub-2", email: "ann@example.com" })
        expect(second.outcome).toBe(OAuthOutcome.SignedUp)
        expect(second.user.id).not.toBe(first.user.id)
        expect((await store.findKeyById(first.key.id))?.subject).toBe("sub-1")
      }))

    it("links a new sub with a verified email to the user who owns that address proven", () =>
      run(async ({ store }, provider, oauth) => {
        const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
        const result = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: "ANN@example.com",
          email_verified: true,
        })
        expect(result.outcome).toBe(OAuthOutcome.Linked)
        expect(result.user.id).toBe(owner.user.id)
        expect(result.key).toMatchObject({
          userId: owner.user.id,
          email: "ann@example.com",
          provenAt: NOW,
        })
        expect((await store.listKeys(owner.user.id)).map((key) => key.method)).toEqual([
          "password",
          "oauth:fake",
        ])
      }))

    it("never attaches a new sub with an unverified email to the owner of that address", () =>
      run(async ({ store }, provider, oauth) => {
        const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
        const result = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: "ann@example.com",
          email_verified: false,
        })
        expect(result.outcome).toBe(OAuthOutcome.SignedUp)
        expect(result.user.id).not.toBe(owner.user.id)
        expect(result.key.email).toBeNull()
        expect(result.key.provenAt).toBeNull()
        expect(await store.listKeys(owner.user.id)).toEqual([owner.key])
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(owner.user.id)
      }))

    it("never attaches a new sub whose email has no verified flag to the owner of that address", () =>
      run(async ({ store }, provider, oauth) => {
        const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
        const result = await signInAs(oauth, provider, { sub: "sub-1", email: "ann@example.com" })
        expect(result.user.id).not.toBe(owner.user.id)
        expect(result.key.email).toBeNull()
      }))

    it("gives a pre-registered address back to the person the provider vouches for", () =>
      run(async ({ store }, provider, oauth) => {
        // The attacker signs up first with the victim's address and never proves it.
        const attacker = await store.createUserWithKey(emailKey("password", "vic@example.com"))
        const victim = await signInAs(oauth, provider, {
          sub: "victim-sub",
          email: "vic@example.com",
          email_verified: true,
        })
        expect(victim.outcome).toBe(OAuthOutcome.SignedUp)
        expect(victim.user.id).not.toBe(attacker.user.id)
        expect(await store.findUserIdByProvenEmail("vic@example.com")).toBe(victim.user.id)
        expect(await store.findKeyById(attacker.key.id)).toBeNull()
        expect(await store.listKeys(attacker.user.id)).toEqual([])
      }))

    it("adds a second sub with the same verified email beside the first key, never over it", () =>
      run(async ({ store }, provider, oauth) => {
        const first = await signInAs(oauth, provider, {
          sub: "sub-1",
          email: "ann@example.com",
          email_verified: true,
        })
        const second = await signInAs(oauth, provider, {
          sub: "sub-2",
          email: "ann@example.com",
          email_verified: true,
        })
        expect(second.outcome).toBe(OAuthOutcome.Linked)
        expect(second.user.id).toBe(first.user.id)
        expect(second.key.id).not.toBe(first.key.id)
        const keys = await store.listKeys(first.user.id)
        expect(keys.map((key) => [key.subject, key.email])).toEqual([
          ["sub-1", "ann@example.com"],
          ["sub-2", "ann@example.com"],
        ])
      }))

    it("resolves two parallel first sign-ins of one sub to one user", () =>
      run(async ({ store }, provider, oauth) => {
        const identity = { sub: "sub-1", email: "ann@example.com", email_verified: true }
        const [a, b] = await Promise.all([
          oauth.authorizationUrl(),
          oauth.authorizationUrl(),
        ])
        const [qa, qb] = [
          await provider.approve(a.url, identity),
          await provider.approve(b.url, identity),
        ]
        const results = await Promise.all([
          oauth.handleCallback({ query: qa, browserState: a.state }),
          oauth.handleCallback({ query: qb, browserState: b.state }),
        ])
        expect(results.map((r) => r.outcome).sort()).toEqual([
          OAuthOutcome.SignedIn,
          OAuthOutcome.SignedUp,
        ])
        expect(results[0].user.id).toBe(results[1].user.id)
        expect(results[0].key.id).toBe(results[1].key.id)
        expect(await store.listKeys(results[0].user.id)).toHaveLength(1)
      }))

    it("disconnects only this provider's key and leaves the user's other provider key", () =>
      run(async (fixture, provider, oauth) => {
        const other = createOAuthSignIn(fakeOptions(fixture, provider, "other"))
        const identity = { sub: "sub-1", email: "ann@example.com", email_verified: true }
        const mine = await signInAs(oauth, provider, identity)
        const theirs = await signInAs(other, provider, identity)
        expect(theirs.outcome).toBe(OAuthOutcome.Linked)
        expect(theirs.user.id).toBe(mine.user.id)

        // The other provider's key id through this provider: refused, nothing deleted.
        expect(await oauth.disconnect(mine.user.id, theirs.key.id)).toBe(false)
        expect(await oauth.disconnect(mine.user.id, mine.key.id)).toBe(true)

        const left = await fixture.store.listKeys(mine.user.id)
        expect(left.map((key) => [key.method, key.subject])).toEqual([["oauth:other", "sub-1"]])
        expect(await oauth.disconnect(mine.user.id, mine.key.id)).toBe(false)
      }))

    it("does not disconnect another user's key of this provider", () =>
      run(async ({ store }, provider, oauth) => {
        const ann = await signInAs(oauth, provider, { sub: "sub-ann" })
        const bob = await signInAs(oauth, provider, { sub: "sub-bob" })
        expect(await oauth.disconnect(ann.user.id, bob.key.id)).toBe(false)
        expect(await store.findKeyById(bob.key.id)).toEqual(bob.key)
      }))
  })
}
