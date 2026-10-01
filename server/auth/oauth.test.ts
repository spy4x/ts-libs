// `createOAuthSignIn` in the unit tier: the account scenarios on `MemoryAuthStore`, then what does not
// depend on the store — the authorization URL, PKCE, `state`, clearing the flow on every exit, the
// profile checks and the configuration checks. Every flow runs against the in-process fake provider
// from `oauth-scenarios.test.ts`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SecondFactorStatus, SessionManager } from "../sign-in/mod.ts"

import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord, AuthUser } from "./model.ts"
import { sha256Hex } from "@spy4x/platform/tokens"
import {
  type ConfirmableOAuthSignIn,
  createMemoryOAuthFlowStore,
  createOAuthSignIn,
  MAX_PENDING_OAUTH_FLOWS,
  type OAuthFailure,
  type OAuthFlowStore,
  OAuthOutcome,
  type OAuthPendingSignUp,
  type OAuthProviderConfig,
  type OAuthSignIn,
  OAuthSignInError,
  type OAuthSignInOptions,
  type OAuthTakenFlow,
  pkceChallenge,
} from "./oauth.ts"
import {
  createFakeProvider,
  describeOAuthScenarios,
  FAKE_CLIENT_ID,
  fakeOptions,
  type FakeProvider,
  fakeProviderConfig,
  fixedClock,
  type OAuthFixture,
  PEPPER,
  REDIRECT_URI,
  signInAs,
} from "./oauth-scenarios.test.ts"
import { emailKey, NOW } from "./store-contract.test.ts"

function memoryFixture(store: MemoryAuthStore = new MemoryAuthStore()): OAuthFixture {
  const sessions = new SessionManager<AuthSessionRecord>({
    store: createFakeStore<AuthSessionRecord>().store,
    pepper: PEPPER,
    durationMinutes: 60,
  })
  return { store, sessions, close: () => Promise.resolve() }
}

describeOAuthScenarios("MemoryAuthStore", () => Promise.resolve(memoryFixture()))

interface Setup {
  fixture: OAuthFixture
  provider: FakeProvider
  clock: ReturnType<typeof fixedClock>
  oauth: OAuthSignIn
}

function setup(
  overrides: Partial<OAuthSignInOptions> = {},
  store: MemoryAuthStore = new MemoryAuthStore(),
): Setup {
  const fixture = memoryFixture(store)
  const provider = createFakeProvider()
  const clock = fixedClock()
  const oauth = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, ...overrides })
  return { fixture, provider, clock, oauth }
}

async function failure(promise: Promise<unknown>): Promise<OAuthFailure> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(OAuthSignInError)
  return (error as OAuthSignInError).reason
}

const ANN = { sub: "sub-ann", email: "ann@example.com", email_verified: true }

describe("createOAuthSignIn: the authorization URL", () => {
  it("carries the client, the redirect URI, the scopes, the state and an S256 challenge", async () => {
    const { oauth } = setup()
    const { url, state, expiresAt } = await oauth.authorizationUrl()
    expect(`${url.origin}${url.pathname}`).toBe("https://provider.test/authorize")
    const q = url.searchParams
    expect(q.get("response_type")).toBe("code")
    expect(q.get("client_id")).toBe(FAKE_CLIENT_ID)
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI)
    expect(q.get("scope")).toBe("openid email")
    expect(q.get("state")).toBe(state)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 600_000))
  })

  it("starts every flow with a fresh state and challenge", async () => {
    const { oauth } = setup()
    const a = await oauth.authorizationUrl()
    const b = await oauth.authorizationUrl()
    expect(a.state).not.toBe(b.state)
    expect(a.url.searchParams.get("code_challenge")).not.toBe(
      b.url.searchParams.get("code_challenge"),
    )
  })

  it("keeps its own parameters when the provider's extra parameters name them", async () => {
    const provider = {
      ...fakeProviderConfig(),
      authorizationParams: { prompt: "consent", state: "fixed", client_id: "other" },
    }
    const { oauth } = setup({ provider })
    const { url, state } = await oauth.authorizationUrl()
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("state")).toBe(state)
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID)
  })

  it("names the key method after the provider id", () => {
    expect(setup().oauth.method).toBe("oauth:fake")
  })
})

describe("createOAuthSignIn: PKCE", () => {
  it("computes the S256 challenge of RFC 7636's example verifier", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  it("redeems the code with the verifier of the flow that started it", async () => {
    const { oauth, provider } = setup()
    await signInAs(oauth, provider, ANN)
    expect(provider.tokenStatuses).toEqual([200])
  })

  it("refuses a stolen code redeemed through another flow's state and verifier", async () => {
    const { oauth, provider } = setup()
    const victim = await oauth.authorizationUrl()
    const attacker = await oauth.authorizationUrl()
    const stolen = await provider.approve(victim.url, ANN)
    const query = new URLSearchParams({ code: stolen.get("code") ?? "", state: attacker.state })
    expect(await failure(oauth.handleCallback({ query, browserState: attacker.state }))).toBe(
      "token-exchange-failed",
    )
    expect(provider.tokenStatuses).toEqual([400])
  })
})

describe("createOAuthSignIn: state", () => {
  it("refuses a callback whose browser state differs, and consumes the flow", async () => {
    const { oauth, provider } = setup()
    const started = await oauth.authorizationUrl()
    const other = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    expect(await failure(oauth.handleCallback({ query, browserState: other.state }))).toBe(
      "invalid-state",
    )
    expect(await failure(oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
    expect(provider.tokenStatuses).toEqual([])
  })

  it("refuses a callback when the browser holds no state", async () => {
    const { oauth, provider } = setup()
    const started = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    for (const browserState of [undefined, null]) {
      expect(await failure(oauth.handleCallback({ query, browserState }))).toBe("invalid-state")
    }
    // The refused callback consumed the flow: the right state no longer completes it.
    expect(await failure(oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
    expect(provider.tokenStatuses).toEqual([])
  })

  it("refuses a state it never issued", async () => {
    const { oauth } = setup()
    const query = new URLSearchParams({ code: "code-1", state: "never-issued" })
    expect(await failure(oauth.handleCallback({ query, browserState: "never-issued" }))).toBe(
      "invalid-state",
    )
  })

  it("refuses a replayed callback", async () => {
    const { oauth, provider } = setup()
    const started = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    await oauth.handleCallback({ query, browserState: started.state })
    expect(await failure(oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
  })

  it("refuses a flow completed at its expiry and accepts one a millisecond before", async () => {
    const late = setup()
    const expired = await late.oauth.authorizationUrl()
    const lateQuery = await late.provider.approve(expired.url, ANN)
    late.clock.advance(600_000)
    expect(
      await failure(late.oauth.handleCallback({ query: lateQuery, browserState: expired.state })),
    ).toBe("invalid-state")

    const onTime = setup()
    const live = await onTime.oauth.authorizationUrl()
    const query = await onTime.provider.approve(live.url, ANN)
    onTime.clock.advance(599_999)
    const result = await onTime.oauth.handleCallback({ query, browserState: live.state })
    expect(result.key.subject).toBe("sub-ann")
  })

  it("honours flowTtlSeconds", async () => {
    const { oauth, provider, clock } = setup({ flowTtlSeconds: 5 })
    const started = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    clock.advance(5_000)
    expect(await failure(oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
  })

  it("answers invalid-request for a callback with no state", async () => {
    const { oauth } = setup()
    const query = new URLSearchParams({ code: "code-1" })
    expect(await failure(oauth.handleCallback({ query, browserState: "x" }))).toBe(
      "invalid-request",
    )
  })

  it("drops the oldest flow once MAX_PENDING_OAUTH_FLOWS are pending", async () => {
    const { oauth, provider } = setup()
    const oldest = await oauth.authorizationUrl()
    const oldestQuery = await provider.approve(oldest.url, ANN)
    const second = await oauth.authorizationUrl()
    const secondQuery = await provider.approve(second.url, ANN)
    for (let i = 2; i < MAX_PENDING_OAUTH_FLOWS; i++) await oauth.authorizationUrl()
    await oauth.authorizationUrl()
    expect(
      await failure(oauth.handleCallback({ query: oldestQuery, browserState: oldest.state })),
    ).toBe("invalid-state")
    const result = await oauth.handleCallback({ query: secondQuery, browserState: second.state })
    expect(result.key.subject).toBe("sub-ann")
  })
})

describe("createOAuthSignIn: a shared flow store", () => {
  it("completes a callback on a second instance that shares the flow store, once", async () => {
    const clock = fixedClock()
    const flows = createMemoryOAuthFlowStore({ clock })
    const fixture = memoryFixture()
    const provider = createFakeProvider()
    const first = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, flows })
    const second = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, flows })

    const started = await first.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    const result = await second.handleCallback({ query, browserState: started.state })
    expect(result.key.subject).toBe("sub-ann")
    expect(await failure(first.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
  })

  it("refuses a flow past its expiry even when the store still returns it", async () => {
    // A third-party store that never expires anything: take returns whatever was put.
    const kept = new Map<string, { verifier: string; expiresAt: Date }>()
    const flows: OAuthFlowStore = {
      put(state, flow, expiresAt) {
        kept.set(state, { verifier: flow.verifier, expiresAt })
        return Promise.resolve()
      },
      take(state) {
        const flow = kept.get(state) ?? null
        kept.delete(state)
        return Promise.resolve(flow)
      },
    }
    const { oauth, provider, clock } = setup({ flows })
    const stale = await oauth.authorizationUrl()
    const staleQuery = await provider.approve(stale.url, ANN)
    const fresh = await oauth.authorizationUrl()
    const freshQuery = await provider.approve(fresh.url, ANN)
    clock.advance(600_000 - 1)
    await oauth.handleCallback({ query: freshQuery, browserState: fresh.state })
    clock.advance(1)
    expect(await failure(oauth.handleCallback({ query: staleQuery, browserState: stale.state })))
      .toBe("invalid-state")
    expect(provider.tokenStatuses).toEqual([200])
  })

  it("does not share flows between instances that each keep their own", async () => {
    const { oauth: first, provider, fixture, clock } = setup()
    const second = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock })
    const started = await first.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    expect(await failure(second.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
  })
})

describe("createOAuthSignIn: the flow is cleared on every exit", () => {
  const cases: {
    name: string
    reason: OAuthFailure
    breakIt(provider: FakeProvider): void
    query?(query: URLSearchParams): URLSearchParams
  }[] = [
    {
      name: "the provider answers with an error",
      reason: "provider-error",
      breakIt: () => {},
      query: (q) => new URLSearchParams({ error: "access_denied", state: q.get("state") ?? "" }),
    },
    {
      name: "the callback carries no code",
      reason: "invalid-request",
      breakIt: () => {},
      query: (q) => new URLSearchParams({ state: q.get("state") ?? "" }),
    },
    {
      name: "the token request is refused",
      reason: "token-exchange-failed",
      breakIt: (p) => (p.tokenFailure = "status"),
    },
    {
      name: "the token request throws",
      reason: "token-exchange-failed",
      breakIt: (p) => (p.tokenFailure = "throw"),
    },
    {
      name: "the profile request is refused",
      reason: "profile-failed",
      breakIt: (p) => (p.userInfoFailure = "status"),
    },
    {
      name: "fetching the user profile throws",
      reason: "profile-failed",
      breakIt: (p) => (p.userInfoFailure = "throw"),
    },
    {
      name: "the profile does not describe a person",
      reason: "invalid-profile",
      breakIt: (p) => (p.userInfoBody = { email: "ann@example.com" }),
    },
  ]

  for (const { name, reason, breakIt, query: rewrite } of cases) {
    it(`refuses a retry of the same state after ${name}`, async () => {
      const { oauth, provider } = setup()
      const started = await oauth.authorizationUrl()
      const approved = await provider.approve(started.url, ANN)
      const query = rewrite ? rewrite(approved) : approved
      breakIt(provider)
      expect(await failure(oauth.handleCallback({ query, browserState: started.state }))).toBe(
        reason,
      )

      // The provider works again; the same callback must still be refused, before any request.
      provider.tokenFailure = null
      provider.userInfoFailure = null
      provider.userInfoBody = undefined
      const statuses = provider.tokenStatuses.length
      expect(
        await failure(oauth.handleCallback({ query: approved, browserState: started.state })),
      ).toBe("invalid-state")
      expect(provider.tokenStatuses).toHaveLength(statuses)
    })
  }
})

describe("createOAuthSignIn: the profile", () => {
  for (
    const [name, sub] of [
      ["an empty sub", ""],
      ["a sub with a lone surrogate", "sub-\uD800"],
      ["a sub with NUL", "sub-\u0000"],
      ["a sub longer than 255 characters", "s".repeat(256)],
    ]
  ) {
    it(`refuses ${name} as invalid-profile`, async () => {
      const { oauth, provider } = setup()
      expect(await failure(signInAs(oauth, provider, { sub }))).toBe("invalid-profile")
    })
  }

  it("accepts a sub of exactly 255 characters", async () => {
    const { oauth, provider } = setup()
    const result = await signInAs(oauth, provider, { sub: "s".repeat(255) })
    expect(result.key.subject).toHaveLength(255)
  })

  it("answers invalid-profile when the provider's profile reader throws", async () => {
    const provider = {
      ...fakeProviderConfig(),
      profile: () => {
        throw new Error("unexpected shape")
      },
    }
    const s = setup({ provider })
    expect(await failure(signInAs(s.oauth, s.provider, ANN))).toBe("invalid-profile")
  })

  it("keeps no address when the verified address is not one normalizeEmail accepts", async () => {
    const { oauth, provider } = setup()
    const result = await signInAs(oauth, provider, {
      sub: "sub-1",
      email: "not an address",
      email_verified: true,
    })
    expect(result.key.email).toBeNull()
    expect(result.key.provenAt).toBeNull()
  })

  it("returns the provider's profile as it was read", async () => {
    const { oauth, provider } = setup()
    const result = await signInAs(oauth, provider, { sub: "sub-1", email: "Ann@Example.com" })
    expect(result.profile).toEqual({
      subject: "sub-1",
      email: "Ann@Example.com",
      emailVerified: false,
    })
  })
})

/** A memory store whose users in `deleted` read as deleted, as a soft-deleted row would. */
class SoftDeletingStore extends MemoryAuthStore {
  readonly deleted = new Set<number>()

  override async findUser(id: number): Promise<AuthUser | null> {
    const user = await super.findUser(id)
    return user && this.deleted.has(id) ? { ...user, deletedAt: NOW } : user
  }
}

/** A memory store whose first two `findKey` calls answer only once both have been asked. */
class RacingStore extends MemoryAuthStore {
  #waiting: (() => void)[] = []
  #held = 0

  override async findKey(method: string, subject: string) {
    const answer = await super.findKey(method, subject)
    if (this.#held < 2) {
      this.#held += 1
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve)
        if (this.#waiting.length === 2) { for (const release of this.#waiting) release() }
      })
    }
    return answer
  }
}

describe("createOAuthSignIn: parallel first sign-ins", () => {
  for (
    const [name, identity] of [
      ["a verified address", ANN],
      ["no address", { sub: "sub-ann" }],
    ] as const
  ) {
    it(`reads again after a parallel callback created the key, with ${name}`, async () => {
      const store = new RacingStore()
      const { oauth, provider } = setup({}, store)
      const a = await oauth.authorizationUrl()
      const b = await oauth.authorizationUrl()
      const qa = await provider.approve(a.url, identity)
      const qb = await provider.approve(b.url, identity)
      const results = await Promise.all([
        oauth.handleCallback({ query: qa, browserState: a.state }),
        oauth.handleCallback({ query: qb, browserState: b.state }),
      ])
      expect(results.map((r) => r.outcome).sort()).toEqual([
        OAuthOutcome.SignedIn,
        OAuthOutcome.SignedUp,
      ])
      expect(results[0].key.id).toBe(results[1].key.id)
      expect(await store.listKeys(results[0].user.id)).toHaveLength(1)
    })
  }
})

describe("createOAuthSignIn: deleted users and the session", () => {
  it("refuses to sign a deleted user in by their sub", async () => {
    const store = new SoftDeletingStore()
    const { oauth, provider } = setup({}, store)
    const first = await signInAs(oauth, provider, ANN)
    store.deleted.add(first.user.id)
    expect(await failure(signInAs(oauth, provider, ANN))).toBe("user-deleted")
  })

  it("refuses to link a new sub to a deleted owner of the address", async () => {
    const store = new SoftDeletingStore()
    const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
    store.deleted.add(owner.user.id)
    const { oauth, provider } = setup({}, store)
    expect(await failure(signInAs(oauth, provider, ANN))).toBe("user-deleted")
    expect(await store.findKey("oauth:fake", ANN.sub)).toBeNull()
  })

  it("creates the session with SecondFactorStatus.NotRequired when the app decides nothing", async () => {
    const { oauth, provider } = setup()
    const result = await signInAs(oauth, provider, ANN)
    expect(result.session.session.secondFactor).toBe(SecondFactorStatus.NotRequired)
  })

  it("asks secondFactorFor about the resolved user", async () => {
    const asked: number[] = []
    const { oauth, provider } = setup({
      secondFactorFor: (user) => {
        asked.push(user.id)
        return Promise.resolve(SecondFactorStatus.Pending)
      },
    })
    const result = await signInAs(oauth, provider, ANN)
    expect(asked).toEqual([result.user.id])
    expect(result.session.session.secondFactor).toBe(SecondFactorStatus.Pending)
  })
})

describe("createOAuthSignIn: configuration", () => {
  const cases: [string, (options: OAuthSignInOptions) => OAuthSignInOptions][] = [
    ["an upper-case provider id", (o) => ({ ...o, provider: { ...o.provider, id: "Google" } })],
    ["an empty provider id", (o) => ({ ...o, provider: { ...o.provider, id: "" } })],
    [
      "a provider id of 59 characters",
      (o) => ({ ...o, provider: { ...o.provider, id: "a".repeat(59) } }),
    ],
    ["an empty client id", (o) => ({ ...o, provider: { ...o.provider, clientId: "" } })],
    ["a blank client secret", (o) => ({ ...o, provider: { ...o.provider, clientSecret: " " } })],
    [
      "an http: token endpoint",
      (o) => ({ ...o, provider: { ...o.provider, tokenEndpoint: "http://provider.test/token" } }),
    ],
    [
      "a relative authorization endpoint",
      (o) => ({ ...o, provider: { ...o.provider, authorizationEndpoint: "/authorize" } }),
    ],
    [
      "an http: user-info endpoint",
      (o) => ({ ...o, provider: { ...o.provider, userInfoEndpoint: "http://provider.test/u" } }),
    ],
    ["a relative redirect URI", (o) => ({ ...o, redirectUri: "/auth/callback" })],
    ["a javascript: redirect URI", (o) => ({ ...o, redirectUri: "javascript:alert(1)" })],
    ["a fractional flowTtlSeconds", (o) => ({ ...o, flowTtlSeconds: 1.5 })],
    ["a zero timeoutMs", (o) => ({ ...o, timeoutMs: 0 })],
  ]

  for (const [name, change] of cases) {
    it(`throws a TypeError for ${name}`, () => {
      const { fixture, provider } = setup()
      expect(() => createOAuthSignIn(change(fakeOptions(fixture, provider)))).toThrow(TypeError)
    })
  }

  it("accepts a provider id of 58 characters", () => {
    const { fixture, provider } = setup()
    const options = fakeOptions(fixture, provider, "a".repeat(58))
    expect(createOAuthSignIn(options).method).toBe(`oauth:${"a".repeat(58)}`)
  })

  it("sends the redirect URI exactly as given", async () => {
    const { oauth } = setup({ redirectUri: "https://app.test" })
    const { url } = await oauth.authorizationUrl()
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test")
  })
})

describe("createOAuthSignIn: signUp confirm", () => {
  const BOB = { sub: "sub-bob" }

  function confirming(store: MemoryAuthStore = new MemoryAuthStore(), flows?: OAuthFlowStore) {
    const fixture = memoryFixture(store)
    const provider = createFakeProvider()
    const clock = fixedClock()
    const oauth: ConfirmableOAuthSignIn = createOAuthSignIn({
      ...fakeOptions(fixture, provider),
      clock,
      signUp: "confirm",
      ...(flows ? { flows } : {}),
    })
    return { store, provider, clock, oauth }
  }

  async function pending(
    oauth: ConfirmableOAuthSignIn,
    provider: FakeProvider,
    identity: Parameters<typeof signInAs>[2],
  ): Promise<OAuthPendingSignUp> {
    const started = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, identity)
    const result = await oauth.handleCallback({ query, browserState: started.state })
    if (result.outcome !== OAuthOutcome.PendingSignUp) throw new Error("expected a pending sign-up")
    return result
  }

  it("returns a pending sign-up for a new sub and creates no user", async () => {
    const { store, provider, oauth } = confirming()
    const started = await oauth.authorizationUrl()
    const query = await provider.approve(started.url, ANN)
    const result = await oauth.handleCallback({ query, browserState: started.state })
    expect(result).toEqual({
      outcome: OAuthOutcome.PendingSignUp,
      profile: { subject: "sub-ann", email: "ann@example.com", emailVerified: true },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: new Date(NOW.getTime() + 600_000),
    })
    expect(await store.findKey("oauth:fake", "sub-ann")).toBeNull()
    expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()
  })

  it("keeps only the token's SHA-256 hash in the flow store", async () => {
    const memory = createMemoryOAuthFlowStore({ clock: fixedClock() })
    const keys: string[] = []
    const flows: OAuthFlowStore = {
      put: (key, flow, expiresAt) => {
        keys.push(key)
        return memory.put(key, flow, expiresAt)
      },
      take: (key) => memory.take(key),
    }
    const { provider, oauth } = confirming(new MemoryAuthStore(), flows)
    const { token } = await pending(oauth, provider, BOB)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`sign-up:oauth:fake:${await sha256Hex(token)}`)
    expect(keys.some((key) => key.includes(token))).toBe(false)
  })

  it("confirms a vouched-for address into a new user with a proven key (rule 3)", async () => {
    const { store, provider, oauth } = confirming()
    const { token } = await pending(oauth, provider, ANN)
    const result = await oauth.confirmSignUp(token)
    expect(result.outcome).toBe(OAuthOutcome.SignedUp)
    expect(result.key).toMatchObject({
      method: "oauth:fake",
      subject: "sub-ann",
      email: "ann@example.com",
      provenAt: NOW,
    })
    expect(result.session.session).toMatchObject({ userId: result.user.id, keyId: result.key.id })
    expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(result.user.id)
  })

  it("confirms a sub with no address into a new user with an unproven key (rule 4)", async () => {
    const { store, provider, oauth } = confirming()
    const { token } = await pending(oauth, provider, BOB)
    const result = await oauth.confirmSignUp(token)
    expect(result.outcome).toBe(OAuthOutcome.SignedUp)
    expect(result.key).toMatchObject({ subject: "sub-bob", email: null, provenAt: null })
    expect(await store.findKey("oauth:fake", "sub-bob")).toEqual(result.key)
  })

  it("accepts a token a millisecond before ten minutes and refuses one at ten minutes", async () => {
    const { store, provider, clock, oauth } = confirming()
    const early = await pending(oauth, provider, ANN)
    const late = await pending(oauth, provider, BOB)
    clock.advance(600_000 - 1)
    expect((await oauth.confirmSignUp(early.token)).outcome).toBe(OAuthOutcome.SignedUp)
    clock.advance(1)
    expect(await failure(oauth.confirmSignUp(late.token))).toBe("invalid-sign-up")
    expect(await store.findKey("oauth:fake", "sub-bob")).toBeNull()
  })

  it("refuses a token that was already confirmed", async () => {
    const { provider, oauth } = confirming()
    const { token } = await pending(oauth, provider, BOB)
    await oauth.confirmSignUp(token)
    expect(await failure(oauth.confirmSignUp(token))).toBe("invalid-sign-up")
  })

  it("refuses a token it never issued", async () => {
    const { oauth } = confirming()
    expect(await failure(oauth.confirmSignUp("a".repeat(43)))).toBe("invalid-sign-up")
    expect(await failure(oauth.confirmSignUp(""))).toBe("invalid-sign-up")
  })

  it("gives one of two parallel confirms of one token the user and refuses the other", async () => {
    const { store, provider, oauth } = confirming()
    const { token } = await pending(oauth, provider, BOB)
    const settled = await Promise.allSettled([
      oauth.confirmSignUp(token),
      oauth.confirmSignUp(token),
    ])
    const done = settled.filter((s) => s.status === "fulfilled")
    const refused = settled.filter((s) => s.status === "rejected")
    expect(done).toHaveLength(1)
    expect(refused.map((s) => (s.reason as OAuthSignInError).reason)).toEqual(["invalid-sign-up"])
    const key = await store.findKey("oauth:fake", "sub-bob")
    expect(key).not.toBeNull()
    expect(await store.listKeys(key?.userId ?? 0)).toHaveLength(1)
  })

  it("signs in when another pending sign-up of the same sub was confirmed first", async () => {
    const { provider, oauth } = confirming()
    const first = await pending(oauth, provider, BOB)
    const second = await pending(oauth, provider, BOB)
    const created = await oauth.confirmSignUp(first.token)
    const again = await oauth.confirmSignUp(second.token)
    expect(again.outcome).toBe(OAuthOutcome.SignedIn)
    expect(again.key.id).toBe(created.key.id)
  })

  it("signs an existing sub in from the callback, with no pending step (rule 1)", async () => {
    const { provider, oauth } = confirming()
    const created = await oauth.confirmSignUp((await pending(oauth, provider, BOB)).token)
    const result = await signInAs(oauth as unknown as OAuthSignIn, provider, BOB)
    expect(result.outcome).toBe(OAuthOutcome.SignedIn)
    expect(result.key.id).toBe(created.key.id)
    expect(result.session.session.userId).toBe(created.user.id)
  })

  it("links a vouched-for address to its owner from the callback, with no pending step (rule 2)", async () => {
    const store = new MemoryAuthStore()
    const owner = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
    const { provider, oauth } = confirming(store)
    const result = await signInAs(oauth as unknown as OAuthSignIn, provider, ANN)
    expect(result.outcome).toBe(OAuthOutcome.Linked)
    expect(result.user.id).toBe(owner.user.id)
    expect(result.session.session.userId).toBe(owner.user.id)
  })

  it("refuses a pending sign-up's key used as a callback state", async () => {
    const memory = createMemoryOAuthFlowStore({ clock: fixedClock() })
    const { provider, oauth } = confirming(new MemoryAuthStore(), memory)
    const { token } = await pending(oauth, provider, BOB)
    const state = `sign-up:oauth:fake:${await sha256Hex(token)}`
    const query = new URLSearchParams({ code: "code-x", state })
    expect(await failure(oauth.handleCallback({ query, browserState: state }))).toBe(
      "invalid-state",
    )
  })

  it("refuses a token issued by another sign-in that shares its flow store", async () => {
    const store = new MemoryAuthStore()
    const flows = createMemoryOAuthFlowStore({ clock: fixedClock() })
    const fixture = memoryFixture(store)
    const provider = createFakeProvider()
    const alpha = createOAuthSignIn({
      ...fakeOptions(fixture, provider, "alpha"),
      flows,
      signUp: "confirm",
    })
    const beta = createOAuthSignIn({
      ...fakeOptions(fixture, provider, "beta"),
      flows,
      signUp: "confirm",
    })
    // The victim's account at beta has subject 123; the attacker holds an alpha token for 123.
    const victim = await beta.confirmSignUp((await pending(beta, provider, { sub: "123" })).token)
    const { token } = await pending(alpha, provider, { sub: "123" })
    expect(await failure(beta.confirmSignUp(token))).toBe("invalid-sign-up")
    expect(await store.listKeys(victim.user.id)).toHaveLength(1)
    // The token still belongs to alpha.
    expect((await alpha.confirmSignUp(token)).key.method).toBe("oauth:alpha")
  })

  it("refuses a token past its expiry even when the store still returns it", async () => {
    // A third-party store that never expires anything: take returns whatever was put.
    const kept = new Map<string, OAuthTakenFlow>()
    const flows: OAuthFlowStore = {
      put(key, flow, expiresAt) {
        kept.set(key, { ...flow, expiresAt })
        return Promise.resolve()
      },
      take(key) {
        const flow = kept.get(key) ?? null
        kept.delete(key)
        return Promise.resolve(flow)
      },
    }
    const { store, provider, clock, oauth } = confirming(new MemoryAuthStore(), flows)
    const early = await pending(oauth, provider, ANN)
    const late = await pending(oauth, provider, BOB)
    clock.advance(600_000 - 1)
    expect((await oauth.confirmSignUp(early.token)).outcome).toBe(OAuthOutcome.SignedUp)
    clock.advance(1)
    expect(await failure(oauth.confirmSignUp(late.token))).toBe("invalid-sign-up")
    expect(await store.findKey("oauth:fake", "sub-bob")).toBeNull()
  })

  it("throws a TypeError for a signUp other than confirm", () => {
    const { fixture, provider } = setup()
    const options = { ...fakeOptions(fixture, provider), signUp: "later" }
    expect(() => createOAuthSignIn(options as OAuthSignInOptions)).toThrow(TypeError)
  })

  it("creates the user in the callback when signUp is left out", async () => {
    const { oauth, provider } = setup()
    expect((await signInAs(oauth, provider, BOB)).outcome).toBe(OAuthOutcome.SignedUp)
  })
})

describe("createOAuthSignIn: completeProfile", () => {
  type Complete = NonNullable<OAuthProviderConfig["completeProfile"]>

  /** A sign-in whose provider completes the profile with `complete`; `fail` answers 503 instead. */
  function completing(complete: Complete, fail = (_request: Request) => false) {
    const fixture = memoryFixture()
    const fake = createFakeProvider()
    const authorizations: string[] = []
    const oauth = createOAuthSignIn({
      ...fakeOptions(fixture, fake),
      provider: { ...fakeProviderConfig(), completeProfile: complete },
      fetch: (request) => {
        if (fail(request)) return Promise.resolve(new Response("down", { status: 503 }))
        const authorization = request.headers.get("authorization")
        if (authorization !== null) authorizations.push(authorization)
        return fake.fetch(request)
      },
    })
    return { fixture, fake, oauth, authorizations }
  }

  it("uses the profile completeProfile returns, read with the sign-in's access token", async () => {
    const { fake, oauth, authorizations } = completing(async (profile, { getJson }) => {
      const body = await getJson("https://provider.test/userinfo") as { email: string }
      return { subject: profile.subject, email: body.email, emailVerified: true }
    })
    const result = await signInAs(oauth, fake, { sub: "sub-ann", email: "ann@example.com" })
    expect(result.profile).toEqual({
      subject: "sub-ann",
      email: "ann@example.com",
      emailVerified: true,
    })
    expect(result.key).toMatchObject({ email: "ann@example.com", provenAt: NOW })
    expect(authorizations).toHaveLength(2)
    expect(authorizations[1]).toBe(authorizations[0])
    expect(authorizations[0]).toMatch(/^Bearer token-\d+$/)
  })

  for (
    const [name, complete] of [
      ["a null profile", () => Promise.resolve(null)],
      [
        "an empty subject",
        () => Promise.resolve({ subject: "", email: null, emailVerified: false }),
      ],
      [
        "a request to an http: URL",
        async (_profile, { getJson }) => {
          await getJson("http://provider.test/userinfo")
          return null
        },
      ],
    ] as [string, Complete][]
  ) {
    it(`refuses the sign-in as invalid-profile when completeProfile gives ${name}`, async () => {
      const { fixture, fake, oauth } = completing(complete)
      expect(await failure(signInAs(oauth, fake, ANN))).toBe("invalid-profile")
      expect(await fixture.store.findKey("oauth:fake", ANN.sub)).toBeNull()
    })
  }

  it("refuses the sign-in as profile-failed when a completeProfile request fails", async () => {
    const { fake, oauth } = completing(
      async (profile, { getJson }) => {
        await getJson("https://provider.test/userinfo?more")
        return profile
      },
      (request) => request.url.endsWith("?more"),
    )
    expect(await failure(signInAs(oauth, fake, ANN))).toBe("profile-failed")
  })
})
