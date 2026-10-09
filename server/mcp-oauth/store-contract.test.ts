// The `OAuthStore` contract, written once and run against every store: `memory-store.test.ts` runs
// it for `MemoryOAuthStore` and `kv-store.test.ts` for `KvOAuthStore`. It holds every rule the
// authorization server relies on: single-use consents, codes and refresh tokens, revocation, grant
// records, and copies in and out.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeOAuthStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Clock } from "@spy4x/platform/universal/time"
import type {
  CodeRecord,
  GrantRecord,
  OAuthStore,
  PendingAuthorization,
  RefreshTokenRecord,
} from "./model.ts"

/** A clock the test moves by hand. */
export interface ManualClock extends Clock {
  set(now: number): void
}

/** A clock that starts at `start` and moves only when told to. */
export function manualClock(start = 1_000): ManualClock {
  let now = start
  return { now: () => now, set: (next) => (now = next) }
}

export const code: CodeRecord = {
  grantId: "g1",
  clientId: "https://claude.example/c",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "x".repeat(43),
  resource: "https://mcp.example.com/mcp",
  scope: "",
  expiresAt: 2_000,
}

export const refresh: RefreshTokenRecord = {
  grantId: "g1",
  clientId: "https://claude.example/c",
  resource: "https://mcp.example.com/mcp",
  scope: "",
  expiresAt: 5_000,
}

export const grant: GrantRecord = {
  grantId: "g1",
  clientId: "https://claude.example/c",
  resource: "https://mcp.example.com/mcp",
  scope: "",
  createdAt: 1_000,
  expiresAt: 5_000,
}

export const pending: PendingAuthorization = {
  clientId: code.clientId,
  clientName: "Claude",
  redirectUri: code.redirectUri,
  codeChallenge: code.codeChallenge,
  resource: code.resource,
  scope: "",
  state: undefined,
  expiresAt: 2_000,
}

/**
 * Registers the contract suite for one store.
 *
 * @param label Names the store in every test name.
 * @param open Returns a fresh, empty store reading `clock` for each test.
 */
export function describeOAuthStoreContract(
  label: string,
  open: (clock: Clock) => OAuthStore,
): void {
  describe(`${label} (OAuthStore contract)`, () => {
    it("reports a code unused once, then used on every later consume", async () => {
      const clock = manualClock()
      const store = open(clock)
      await store.saveCode("k", code)
      expect((await store.consumeCode("k"))?.usedAt).toBeUndefined()
      clock.set(1_500)
      expect((await store.consumeCode("k"))?.usedAt).toBe(1_000)
      expect((await store.consumeCode("k"))?.usedAt).toBe(1_000)
      expect(await store.consumeCode("missing")).toBeUndefined()
    })

    it("accepts a code redeemed twice in parallel exactly once", async () => {
      const store = open(manualClock())
      await store.saveCode("k", code)
      const [a, b] = await Promise.all([store.consumeCode("k"), store.consumeCode("k")])
      expect([a?.usedAt, b?.usedAt].filter((usedAt) => usedAt === undefined)).toHaveLength(1)
      expect([a, b].every((record) => record?.grantId === code.grantId)).toBe(true)
    })

    it("reads a refresh token without marking it used", async () => {
      const store = open(manualClock())
      await store.saveRefreshToken("k", refresh)
      expect((await store.findRefreshToken("k"))?.usedAt).toBeUndefined()
      expect((await store.consumeRefreshToken("k"))?.usedAt).toBeUndefined()
      expect((await store.findRefreshToken("k"))?.usedAt).toBe(1_000)
      expect(await store.findRefreshToken("missing")).toBeUndefined()
    })

    it("lets only one of two concurrent consumers see a refresh token unused", async () => {
      const store = open(manualClock())
      await store.saveRefreshToken("k", refresh)
      const [a, b] = await Promise.all([
        store.consumeRefreshToken("k"),
        store.consumeRefreshToken("k"),
      ])
      expect([a?.usedAt, b?.usedAt].filter((usedAt) => usedAt === undefined)).toHaveLength(1)
    })

    it("hands out a pending authorization once", async () => {
      const store = open(manualClock())
      await store.savePending("k", pending)
      expect(await store.takePending("k")).toEqual(pending)
      expect(await store.takePending("k")).toBeUndefined()
    })

    it("hands out a pending authorization to only one of two concurrent takers", async () => {
      const store = open(manualClock())
      await store.savePending("k", pending)
      const taken = await Promise.all([store.takePending("k"), store.takePending("k")])
      expect(taken.filter((record) => record !== undefined)).toHaveLength(1)
    })

    it("revokes every access and refresh token of a grant and no other", async () => {
      const store = open(manualClock())
      await store.saveAccessToken("a1", { ...refresh })
      await store.saveRefreshToken("r1", refresh)
      await store.saveAccessToken("a2", { ...refresh, grantId: "g2" })
      await store.saveRefreshToken("r2", { ...refresh, grantId: "g2" })
      await store.revokeGrant("g1", 3_000)
      expect(await store.findAccessToken("a1")).toBeUndefined()
      expect(await store.findRefreshToken("r1")).toBeUndefined()
      expect(await store.consumeRefreshToken("r1")).toBeUndefined()
      expect(await store.findAccessToken("a2")).toBeDefined()
      expect(await store.findRefreshToken("r2")).toBeDefined()
    })

    it("refuses to save tokens of a revoked grant until the revocation lapses", async () => {
      const clock = manualClock()
      const store = open(clock)
      await store.revokeGrant("g1", 3_000)
      expect(await store.saveAccessToken("a1", { ...refresh })).toBe(false)
      expect(await store.saveRefreshToken("r1", refresh)).toBe(false)
      expect(await store.findAccessToken("a1")).toBeUndefined()
      expect(await store.consumeRefreshToken("r1")).toBeUndefined()
      expect(await store.saveAccessToken("a2", { ...refresh, grantId: "g2" })).toBe(true)
      clock.set(3_000)
      expect(await store.saveAccessToken("a1", { ...refresh })).toBe(true)
      expect(await store.findAccessToken("a1")).toBeDefined()
    })

    it("keeps the later end when a grant is revoked twice", async () => {
      const clock = manualClock()
      const store = open(clock)
      await store.revokeGrant("g1", 4_000)
      await store.revokeGrant("g1", 3_000)
      clock.set(3_500)
      expect(await store.saveAccessToken("a1", { ...refresh })).toBe(false)
    })

    it("lists unexpired grants oldest first, and forgets a revoked one", async () => {
      const clock = manualClock()
      const store = open(clock)
      expect(await store.saveGrant({ ...grant, grantId: "g2", createdAt: 1_200 })).toBe(true)
      expect(await store.saveGrant(grant)).toBe(true)
      expect(await store.saveGrant({ ...grant, grantId: "g3", expiresAt: 3_000 })).toBe(true)
      expect((await store.listGrants()).map((g) => g.grantId)).toEqual(["g1", "g3", "g2"])
      expect((await store.listGrants())[0]).toEqual(grant)
      clock.set(3_000)
      expect((await store.listGrants()).map((g) => g.grantId)).toEqual(["g1", "g2"])
      await store.revokeGrant("g1", grant.expiresAt)
      expect((await store.listGrants()).map((g) => g.grantId)).toEqual(["g2"])
    })

    it("refuses to save the record of a revoked grant", async () => {
      const store = open(manualClock())
      await store.revokeGrant("g1", 3_000)
      expect(await store.saveGrant(grant)).toBe(false)
      expect(await store.listGrants()).toEqual([])
    })

    it("hands out copies, so a caller cannot edit a stored record", async () => {
      const store = open(manualClock())
      const saved = { ...refresh }
      await store.saveAccessToken("a", saved)
      saved.resource = "https://evil.example"
      const read = await store.findAccessToken("a")
      read!.resource = "https://evil.example"
      expect((await store.findAccessToken("a"))?.resource).toBe(refresh.resource)
    })
  })
}
