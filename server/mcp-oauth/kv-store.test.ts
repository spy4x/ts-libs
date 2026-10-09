import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { KvOAuthStore, type OAuthKv, type OAuthKvAtomic, type OAuthKvEntry } from "./kv-store.ts"
import {
  code,
  describeOAuthStoreContract,
  grant,
  manualClock,
  pending,
  refresh,
} from "./store-contract.test.ts"

interface FakeEntry {
  value: unknown
  versionstamp: string
  expireIn?: number
}

/**
 * Stand-in for `Deno.Kv` with the semantics the store relies on: a versionstamp that changes on
 * every write, atomic operations that apply all mutations or none when a check fails, and values
 * copied in and out the way Deno KV serializes them.
 *
 * `kv-store-deno.test.ts` runs the store contract on real Deno KV. This fake covers what real Deno
 * KV cannot show in a fast test: the `expireIn` each write carries, failed commits on demand, and
 * a race where both readers read before either commits. Reads resolve on a later microtask for
 * that race.
 */
function fakeKv() {
  const entries = new Map<string, FakeEntry & { key: readonly string[] }>()
  let version = 0
  let commits = 0
  const id = (key: readonly string[]) => JSON.stringify(key)

  const kv: OAuthKv & {
    entries: typeof entries
    commits: () => number
    failCommits: boolean
  } = {
    entries,
    commits: () => commits,
    failCommits: false,
    get(key) {
      const entry = entries.get(id(key))
      const read: OAuthKvEntry = entry === undefined
        ? { value: null, versionstamp: null }
        : { value: structuredClone(entry.value), versionstamp: entry.versionstamp }
      return Promise.resolve(read)
    },
    atomic() {
      const checks: { key: readonly string[]; versionstamp: string | null }[] = []
      const mutations: (() => void)[] = []
      const operation: OAuthKvAtomic = {
        check(...more) {
          checks.push(...more)
          return operation
        },
        set(key, value, options) {
          const copy = structuredClone(value)
          mutations.push(() =>
            entries.set(id(key), {
              key: [...key],
              value: copy,
              versionstamp: String(++version).padStart(20, "0"),
              expireIn: options?.expireIn,
            })
          )
          return operation
        },
        delete(key) {
          mutations.push(() => entries.delete(id(key)))
          return operation
        },
        commit() {
          commits++
          const stale = checks.some((check) =>
            (entries.get(id(check.key))?.versionstamp ?? null) !== check.versionstamp
          )
          if (stale || kv.failCommits) return Promise.resolve({ ok: false })
          for (const mutate of mutations) mutate()
          return Promise.resolve({ ok: true })
        },
      }
      return operation
    },
    async *list({ prefix }) {
      const matches = [...entries.values()].filter((entry) =>
        prefix.every((part, index) => entry.key[index] === part)
      )
      for (const entry of matches) {
        await Promise.resolve()
        yield { key: entry.key }
      }
    },
  }
  return kv
}

describeOAuthStoreContract("KvOAuthStore", (clock) => new KvOAuthStore(fakeKv(), { clock }))

describe("KvOAuthStore", () => {
  it("sets every record to expire from the database when its expiresAt passes", async () => {
    const kv = fakeKv()
    const store = new KvOAuthStore(kv, { clock: manualClock(1_000) })
    await store.savePending("p", pending)
    await store.saveCode("c", code)
    await store.saveAccessToken("a", { ...refresh, expiresAt: 1_900 })
    await store.saveRefreshToken("r", refresh)
    await store.revokeGrant("g2", 7_000)
    await store.saveGrant(grant)
    const expireIn = (...key: string[]) => kv.entries.get(JSON.stringify(key))?.expireIn
    expect(expireIn("mcp-oauth", "pending", "p")).toBe(1_000)
    expect(expireIn("mcp-oauth", "code", "c")).toBe(1_000)
    expect(expireIn("mcp-oauth", "access", "a")).toBe(900)
    expect(expireIn("mcp-oauth", "grant", "g1", "access", "a")).toBe(900)
    expect(expireIn("mcp-oauth", "refresh", "r")).toBe(4_000)
    expect(expireIn("mcp-oauth", "grant", "g1", "refresh", "r")).toBe(4_000)
    expect(expireIn("mcp-oauth", "revoked", "g2")).toBe(6_000)
    expect(expireIn("mcp-oauth", "grants", "g1")).toBe(4_000)
  })

  it("keeps two stores with different prefixes apart in one database", async () => {
    const kv = fakeKv()
    const clock = manualClock()
    const first = new KvOAuthStore(kv, { clock, prefix: ["app", "one"] })
    const second = new KvOAuthStore(kv, { clock, prefix: ["app", "two"] })
    await first.saveRefreshToken("r", refresh)
    expect(await second.findRefreshToken("r")).toBeUndefined()
    await second.saveRefreshToken("r", refresh)
    await second.revokeGrant(refresh.grantId, 3_000)
    expect(await first.findRefreshToken("r")).toBeDefined()
    expect([...kv.entries.values()].every((entry) => entry.key[0] === "app")).toBe(true)
  })

  it("removes a revoked grant's index keys and grant record along with its tokens", async () => {
    const kv = fakeKv()
    const store = new KvOAuthStore(kv, { clock: manualClock() })
    await store.saveAccessToken("a", { ...refresh })
    await store.saveRefreshToken("r", refresh)
    await store.saveGrant(grant)
    await store.revokeGrant(refresh.grantId, 3_000)
    expect([...kv.entries.values()].map((entry) => entry.key)).toEqual([
      ["mcp-oauth", "revoked", refresh.grantId],
    ])
  })

  it("leaves no token of a grant whose revocation raced the token's save", async () => {
    const kv = fakeKv()
    const store = new KvOAuthStore(kv, { clock: manualClock() })
    // The revocation commits between the save's read and its commit: the save's check fails, and
    // its retry sees the grant revoked.
    const [, refused] = await Promise.all([
      store.revokeGrant(refresh.grantId, 3_000),
      store.saveAccessToken("a1", { ...refresh }),
    ])
    expect(refused).toBe(false)
    // The save commits first: the revocation's listing finds it and deletes it.
    const [saved] = await Promise.all([
      store.saveAccessToken("a2", { ...refresh, grantId: "g2" }),
      store.revokeGrant("g2", 3_000),
    ])
    expect(saved).toBe(true)
    expect(await store.findAccessToken("a1")).toBeUndefined()
    expect(await store.findAccessToken("a2")).toBeUndefined()
  })

  it("gives up with an error instead of retrying forever when every commit conflicts", async () => {
    const kv = fakeKv()
    const store = new KvOAuthStore(kv, { clock: manualClock() })
    await store.saveCode("c", code)
    kv.failCommits = true
    const before = kv.commits()
    await expect(store.consumeCode("c")).rejects.toThrow("gave up after 32 conflicting writes")
    expect(kv.commits() - before).toBe(32)
  })

  it("refuses a prefix part that is not text", () => {
    expect(() => new KvOAuthStore(fakeKv(), { prefix: [1 as unknown as string] })).toThrow(
      TypeError,
    )
  })
})
