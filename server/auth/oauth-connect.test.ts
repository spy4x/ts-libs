// Connecting a provider to a signed-in user (`connectUrl` and `handleConnectCallback`), against the
// in-process fake provider from `oauth-scenarios.test.ts`. Every rule runs twice: with pending flows
// in the memory store, and in the key-value store over a fake client.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SessionManager } from "../sign-in/mod.ts"

import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord, AuthUser } from "./model.ts"
import {
  createKvOAuthFlowStore,
  createMemoryOAuthFlowStore,
  createOAuthSignIn,
  type OAuthFailure,
  type OAuthFlowKv,
  type OAuthFlowStore,
  OAuthOutcome,
  type OAuthSignIn,
  OAuthSignInError,
} from "./oauth.ts"
import {
  createFakeProvider,
  type FakeIdentity,
  fakeOptions,
  type FakeProvider,
  fixedClock,
  PEPPER,
} from "./oauth-scenarios.test.ts"
import { emailKey, NOW } from "./store-contract.test.ts"

type TestClock = ReturnType<typeof fixedClock>

/** A key-value client in memory whose `take` is atomic, as `GETDEL` is. */
function fakeKv(): OAuthFlowKv & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    set(key, value) {
      values.set(key, value)
      return Promise.resolve()
    },
    take(key) {
      const value = values.get(key) ?? null
      values.delete(key)
      return Promise.resolve(value)
    },
  }
}

/** A store whose users can be marked deleted, and that counts the users it creates. */
class WatchedStore extends MemoryAuthStore {
  readonly deleted = new Set<number>()
  usersCreated = 0

  override async findUser(id: number): Promise<AuthUser | null> {
    const user = await super.findUser(id)
    return user && this.deleted.has(id) ? { ...user, deletedAt: NOW } : user
  }

  override createUserWithKey(
    ...args: Parameters<MemoryAuthStore["createUserWithKey"]>
  ): ReturnType<MemoryAuthStore["createUserWithKey"]> {
    this.usersCreated++
    return super.createUserWithKey(...args)
  }
}

interface Setup {
  store: WatchedStore
  provider: FakeProvider
  clock: TestClock
  oauth: OAuthSignIn
  /** How many sessions were created. */
  sessionsCreated(): number
  /** A user with a proven password key for `email`; counted in `store.usersCreated`. */
  user(email: string): Promise<AuthUser>
}

function setup(flows: (clock: TestClock) => OAuthFlowStore): Setup {
  const store = new WatchedStore()
  const sessions = new SessionManager<AuthSessionRecord>({
    store: createFakeStore<AuthSessionRecord>().store,
    pepper: PEPPER,
    durationMinutes: 60,
  })
  let sessionsCreated = 0
  const create = sessions.create.bind(sessions)
  sessions.create = (...args) => {
    sessionsCreated++
    return create(...args)
  }
  const provider = createFakeProvider()
  const clock = fixedClock()
  const fixture = { store, sessions, close: () => Promise.resolve() }
  const oauth = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, flows: flows(clock) })
  return {
    store,
    provider,
    clock,
    oauth,
    sessionsCreated: () => sessionsCreated,
    user: async (email) => (await store.createUserWithKey(emailKey("password", email, NOW))).user,
  }
}

async function failure(promise: Promise<unknown>): Promise<OAuthFailure> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(OAuthSignInError)
  return (error as OAuthSignInError).reason
}

/** Runs a whole connect flow for `userId`, approved at the provider as `identity`. */
async function connectAs(
  { oauth, provider }: Setup,
  userId: number,
  identity: FakeIdentity,
) {
  const started = await oauth.connectUrl(userId)
  const query = await provider.approve(started.url, identity)
  return await oauth.handleConnectCallback({ query, browserState: started.state, userId })
}

/** A provider identity whose vouched-for address is not the account's. */
const WORK = { sub: "sub-work", email: "ann@work.example", email_verified: true }

const FLOW_STORES: [string, (clock: TestClock) => OAuthFlowStore][] = [
  ["memory flow store", (clock) => createMemoryOAuthFlowStore({ clock })],
  ["key-value flow store", (clock) => createKvOAuthFlowStore(fakeKv(), { clock })],
]

for (const [label, flows] of FLOW_STORES) {
  describe(`createOAuthSignIn: connect, ${label}`, () => {
    it("adds the identity to the signed-in user when its address is not the account's", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const result = await connectAs(s, ann.id, WORK)
      expect(result.outcome).toBe(OAuthOutcome.Connected)
      expect(result.user.id).toBe(ann.id)
      expect(result.key).toMatchObject({
        userId: ann.id,
        method: "oauth:fake",
        subject: WORK.sub,
        email: WORK.email,
        provenAt: NOW,
      })
      expect(result.profile).toEqual({ subject: WORK.sub, email: WORK.email, emailVerified: true })
      expect((await s.store.findKey("oauth:fake", WORK.sub))?.userId).toBe(ann.id)
    })

    it("adds the identity to the user the flow was started for, not to the owner of its address", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const bob = await s.user("bob@example.com")
      const result = await connectAs(s, ann.id, { ...WORK, email: "bob@example.com" })
      expect(result.outcome).toBe(OAuthOutcome.Connected)
      expect(result.key.userId).toBe(ann.id)
      // Bob still owns the address: Ann's key carries none.
      expect(result.key.email).toBeNull()
      expect(result.key.provenAt).toBeNull()
      expect(await s.store.findUserIdByProvenEmail("bob@example.com")).toBe(bob.id)
    })

    it("keeps the address, proven, when the user connecting already owns it proven", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const result = await connectAs(s, ann.id, { ...WORK, email: "ann@example.com" })
      expect(result.outcome).toBe(OAuthOutcome.Connected)
      expect(result.key).toMatchObject({ userId: ann.id, email: "ann@example.com", provenAt: NOW })
      expect(await s.store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.id)
    })

    it("deletes another user's unproven key for the address the connected identity vouches for", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const claimant = await s.store.createUserWithKey(emailKey("password", WORK.email))
      const result = await connectAs(s, ann.id, WORK)
      expect(result.key).toMatchObject({ userId: ann.id, email: WORK.email, provenAt: NOW })
      expect(await s.store.listKeys(claimant.user.id)).toEqual([])
    })

    it("keeps no address on the key when the provider does not vouch for it", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const result = await connectAs(s, ann.id, { ...WORK, email_verified: false })
      expect(result.key.email).toBeNull()
      expect(result.key.provenAt).toBeNull()
    })

    it("refuses an identity that belongs to another user as identity-taken, and writes nothing", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const bob = await s.user("bob@example.com")
      await connectAs(s, bob.id, WORK)
      expect(await failure(connectAs(s, ann.id, WORK))).toBe("identity-taken")
      expect((await s.store.findKey("oauth:fake", WORK.sub))?.userId).toBe(bob.id)
      expect(await s.store.listKeys(ann.id)).toHaveLength(1)
    })

    it("answers AlreadyConnected for an identity this user already has, and adds no second key", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const first = await connectAs(s, ann.id, WORK)
      const second = await connectAs(s, ann.id, WORK)
      expect(second.outcome).toBe(OAuthOutcome.AlreadyConnected)
      expect(second.key).toEqual(first.key)
      expect(await s.store.listKeys(ann.id)).toHaveLength(2)
    })

    it("creates no user and no session", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      await connectAs(s, ann.id, WORK)
      await connectAs(s, ann.id, WORK)
      await connectAs(s, ann.id, { sub: "sub-bare" })
      expect(s.store.usersCreated).toBe(1)
      expect(s.sessionsCreated()).toBe(0)
    })

    it("sends an S256 challenge and redeems the code with the flow's verifier", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      expect(started.url.searchParams.get("state")).toBe(started.state)
      expect(started.url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(started.url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(started.expiresAt).toEqual(new Date(NOW.getTime() + 600_000))
      const query = await s.provider.approve(started.url, WORK)
      await s.oauth.handleConnectCallback({ query, browserState: started.state, userId: ann.id })
      expect(s.provider.tokenStatuses).toEqual([200])
    })

    it("refuses a stolen code redeemed through another connect flow's state and verifier", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const bob = await s.user("bob@example.com")
      const victim = await s.oauth.connectUrl(ann.id)
      const attacker = await s.oauth.connectUrl(bob.id)
      const stolen = await s.provider.approve(victim.url, WORK)
      const query = new URLSearchParams({ code: stolen.get("code") ?? "", state: attacker.state })
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: attacker.state, userId: bob.id }),
        ),
      ).toBe("token-exchange-failed")
      expect(s.provider.tokenStatuses).toEqual([400])
      expect(await s.store.findKey("oauth:fake", WORK.sub)).toBeNull()
    })

    it("refuses a replayed connect callback", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const query = await s.provider.approve(started.url, WORK)
      const input = { query, browserState: started.state, userId: ann.id }
      await s.oauth.handleConnectCallback(input)
      expect(await failure(s.oauth.handleConnectCallback(input))).toBe("invalid-state")
    })

    it("refuses a connect callback whose browser state differs, and consumes the flow", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const query = await s.provider.approve(started.url, WORK)
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: "another", userId: ann.id }),
        ),
      ).toBe("invalid-state")
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: started.state, userId: ann.id }),
        ),
      ).toBe("invalid-state")
      expect(s.provider.tokenStatuses).toEqual([])
    })

    it("refuses a connect flow completed at its expiry and accepts one a millisecond before", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const late = await s.oauth.connectUrl(ann.id)
      const early = await s.oauth.connectUrl(ann.id)
      const lateQuery = await s.provider.approve(late.url, WORK)
      const earlyQuery = await s.provider.approve(early.url, WORK)
      s.clock.advance(600_000 - 1)
      const result = await s.oauth.handleConnectCallback({
        query: earlyQuery,
        browserState: early.state,
        userId: ann.id,
      })
      expect(result.outcome).toBe(OAuthOutcome.Connected)
      s.clock.advance(1)
      expect(
        await failure(
          s.oauth.handleConnectCallback({
            query: lateQuery,
            browserState: late.state,
            userId: ann.id,
          }),
        ),
      ).toBe("invalid-state")
    })

    it("refuses a connect callback made by another signed-in user", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const bob = await s.user("bob@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const query = await s.provider.approve(started.url, WORK)
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: started.state, userId: bob.id }),
        ),
      ).toBe("invalid-state")
      expect(await s.store.findKey("oauth:fake", WORK.sub)).toBeNull()
      expect(s.provider.tokenStatuses).toEqual([])
    })

    it("refuses a connect flow at the sign-in callback, and signs nobody in or up", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const query = await s.provider.approve(started.url, WORK)
      expect(await failure(s.oauth.handleCallback({ query, browserState: started.state }))).toBe(
        "invalid-state",
      )
      expect(s.store.usersCreated).toBe(1)
      expect(s.sessionsCreated()).toBe(0)
      expect(await s.store.findKey("oauth:fake", WORK.sub)).toBeNull()
    })

    it("refuses a connect flow's store key used as a sign-in callback state, without asking the store", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const approved = await s.provider.approve(started.url, WORK)
      const key = `connect:oauth:fake:${started.state}`
      const query = new URLSearchParams({ code: approved.get("code") ?? "", state: key })
      expect(await failure(s.oauth.handleCallback({ query, browserState: key }))).toBe(
        "invalid-state",
      )
      expect(s.store.usersCreated).toBe(1)
      expect(s.sessionsCreated()).toBe(0)
      // The crafted key never reached the store, so the flow is still there for its own callback.
      const result = await s.oauth.handleConnectCallback({
        query: approved,
        browserState: started.state,
        userId: ann.id,
      })
      expect(result.outcome).toBe(OAuthOutcome.Connected)
    })

    it("refuses a sign-in flow at the connect callback, and links nothing", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.authorizationUrl()
      const query = await s.provider.approve(started.url, WORK)
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: started.state, userId: ann.id }),
        ),
      ).toBe("invalid-state")
      expect(await s.store.listKeys(ann.id)).toHaveLength(1)
      expect(s.provider.tokenStatuses).toEqual([])
    })

    it("answers provider-error when the person declines, and consumes the flow", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const declined = new URLSearchParams({ error: "access_denied", state: started.state })
      const input = { query: declined, browserState: started.state, userId: ann.id }
      expect(await failure(s.oauth.handleConnectCallback(input))).toBe("provider-error")
      expect(await failure(s.oauth.handleConnectCallback(input))).toBe("invalid-state")
    })

    it("refuses to start a connect flow for a deleted or unknown user", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      s.store.deleted.add(ann.id)
      expect(await failure(s.oauth.connectUrl(ann.id))).toBe("user-deleted")
      expect(await failure(s.oauth.connectUrl(ann.id + 1))).toBe("user-deleted")
    })

    it("refuses to connect to a user deleted after the flow started", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      const started = await s.oauth.connectUrl(ann.id)
      const query = await s.provider.approve(started.url, WORK)
      s.store.deleted.add(ann.id)
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: started.state, userId: ann.id }),
        ),
      ).toBe("user-deleted")
      expect(await s.store.findKey("oauth:fake", WORK.sub)).toBeNull()
    })

    it("throws a TypeError for a user id that is not a positive integer", async () => {
      const s = setup(flows)
      for (const userId of [0, -1, 1.5, Number.NaN, "1" as unknown as number]) {
        const error = await s.oauth.connectUrl(userId).then(() => null, (caught) => caught)
        expect(error).toBeInstanceOf(TypeError)
      }
    })

    it("lets the connected identity sign the user in afterwards", async () => {
      const s = setup(flows)
      const ann = await s.user("ann@example.com")
      await connectAs(s, ann.id, WORK)
      const started = await s.oauth.authorizationUrl()
      const query = await s.provider.approve(started.url, WORK)
      const signedIn = await s.oauth.handleCallback({ query, browserState: started.state })
      expect(signedIn.outcome).toBe(OAuthOutcome.SignedIn)
      expect(signedIn.user.id).toBe(ann.id)
    })
  })
}

describe("createOAuthSignIn: connect, a flow store that drops the connect field", () => {
  /** A third-party store written before connect flows existed: it keeps only the verifier. */
  function droppingStore(clock: TestClock): OAuthFlowStore {
    const inner = createMemoryOAuthFlowStore({ clock })
    return {
      put: (state, flow, expiresAt) => inner.put(state, { verifier: flow.verifier }, expiresAt),
      take: (state) => inner.take(state),
    }
  }

  it("refuses the connect callback instead of connecting", async () => {
    const s = setup(droppingStore)
    const ann = await s.user("ann@example.com")
    const started = await s.oauth.connectUrl(ann.id)
    const query = await s.provider.approve(started.url, WORK)
    expect(
      await failure(
        s.oauth.handleConnectCallback({ query, browserState: started.state, userId: ann.id }),
      ),
    ).toBe("invalid-state")
  })

  it("refuses the connect flow's store key used as a sign-in callback state", async () => {
    const s = setup(droppingStore)
    const ann = await s.user("ann@example.com")
    const started = await s.oauth.connectUrl(ann.id)
    const approved = await s.provider.approve(started.url, WORK)
    const key = `connect:oauth:fake:${started.state}`
    const query = new URLSearchParams({ code: approved.get("code") ?? "", state: key })
    expect(await failure(s.oauth.handleCallback({ query, browserState: key }))).toBe(
      "invalid-state",
    )
    expect(s.store.usersCreated).toBe(1)
    expect(s.sessionsCreated()).toBe(0)
    expect(s.provider.tokenStatuses).toEqual([])
  })

  it("never asks the store about a state that is not 43 base64url characters, at either callback", async () => {
    const taken: string[] = []
    const s = setup((clock) => {
      const inner = createMemoryOAuthFlowStore({ clock })
      return {
        put: inner.put,
        take: (key) => {
          taken.push(key)
          return inner.take(key)
        },
      }
    })
    const ann = await s.user("ann@example.com")
    const shapes = [
      "connect:oauth:fake:not-a-state",
      "sign-up:oauth:fake:0123",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}:`,
    ]
    for (const state of shapes) {
      const query = new URLSearchParams({ code: "any", state })
      expect(await failure(s.oauth.handleCallback({ query, browserState: state }))).toBe(
        "invalid-state",
      )
      expect(
        await failure(
          s.oauth.handleConnectCallback({ query, browserState: state, userId: ann.id }),
        ),
      ).toBe("invalid-state")
    }
    expect(taken).toEqual([])
    // A state of the right shape is looked up, at the sign-in key and at the connect key.
    const query = new URLSearchParams({ code: "any", state: "a".repeat(43) })
    await failure(s.oauth.handleCallback({ query, browserState: "a".repeat(43) }))
    await failure(
      s.oauth.handleConnectCallback({ query, browserState: "a".repeat(43), userId: ann.id }),
    )
    expect(taken).toEqual(["a".repeat(43), `connect:oauth:fake:${"a".repeat(43)}`])
  })

  it("refuses a connect flow at the sign-in callback on a store that ignores the key prefix", async () => {
    // A store that keys every flow by the bare state: only the flow's own `connect` field tells the
    // two kinds apart.
    const s = setup((clock) => {
      const inner = createMemoryOAuthFlowStore({ clock })
      const bare = (key: string) => key.slice(key.lastIndexOf(":") + 1)
      return {
        put: (key, flow, expiresAt) => inner.put(bare(key), flow, expiresAt),
        take: (key) => inner.take(bare(key)),
      }
    })
    const ann = await s.user("ann@example.com")
    const started = await s.oauth.connectUrl(ann.id)
    const query = await s.provider.approve(started.url, WORK)
    expect(await failure(s.oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
    expect(s.store.usersCreated).toBe(1)
    expect(s.sessionsCreated()).toBe(0)
  })

  it("still refuses the connect flow at the sign-in callback", async () => {
    const s = setup(droppingStore)
    const ann = await s.user("ann@example.com")
    const started = await s.oauth.connectUrl(ann.id)
    const query = await s.provider.approve(started.url, WORK)
    expect(await failure(s.oauth.handleCallback({ query, browserState: started.state }))).toBe(
      "invalid-state",
    )
    expect(s.store.usersCreated).toBe(1)
    expect(s.sessionsCreated()).toBe(0)
  })
})
