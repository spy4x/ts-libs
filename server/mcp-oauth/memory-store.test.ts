import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryOAuthStore } from "./memory-store.ts"
import type { CodeRecord, RefreshTokenRecord } from "./model.ts"

const code: CodeRecord = {
  grantId: "g1",
  clientId: "https://claude.example/c",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "x".repeat(43),
  resource: "https://mcp.example.com/mcp",
  scope: "",
  expiresAt: 2_000,
}

const refresh: RefreshTokenRecord = {
  grantId: "g1",
  clientId: "https://claude.example/c",
  resource: "https://mcp.example.com/mcp",
  scope: "",
  expiresAt: 5_000,
}

describe("MemoryOAuthStore", () => {
  it("reports a code unused once, then used on every later consume", async () => {
    let now = 1_000
    const store = new MemoryOAuthStore({ clock: { now: () => now } })
    await store.saveCode("k", code)
    expect((await store.consumeCode("k"))?.usedAt).toBeUndefined()
    now = 1_500
    expect((await store.consumeCode("k"))?.usedAt).toBe(1_000)
    expect((await store.consumeCode("k"))?.usedAt).toBe(1_000)
    expect(await store.consumeCode("missing")).toBeUndefined()
  })

  it("lets only one of two concurrent consumers see a refresh token unused", async () => {
    const store = new MemoryOAuthStore({ clock: { now: () => 1_000 } })
    await store.saveRefreshToken("k", refresh)
    const [a, b] = await Promise.all([
      store.consumeRefreshToken("k"),
      store.consumeRefreshToken("k"),
    ])
    expect([a?.usedAt, b?.usedAt].filter((usedAt) => usedAt === undefined)).toHaveLength(1)
  })

  it("hands out a pending authorization once", async () => {
    const store = new MemoryOAuthStore({ clock: { now: () => 1_000 } })
    await store.savePending("k", {
      clientId: code.clientId,
      clientName: "Claude",
      redirectUri: code.redirectUri,
      codeChallenge: code.codeChallenge,
      resource: code.resource,
      scope: "",
      state: undefined,
      expiresAt: 2_000,
    })
    expect(await store.takePending("k")).toBeDefined()
    expect(await store.takePending("k")).toBeUndefined()
  })

  it("revokes every access and refresh token of a grant and no other", async () => {
    const store = new MemoryOAuthStore({ clock: { now: () => 1_000 } })
    await store.saveAccessToken("a1", { ...refresh })
    await store.saveRefreshToken("r1", refresh)
    await store.saveAccessToken("a2", { ...refresh, grantId: "g2" })
    await store.revokeGrant("g1", 3_000)
    expect(await store.findAccessToken("a1")).toBeUndefined()
    expect(await store.consumeRefreshToken("r1")).toBeUndefined()
    expect(await store.findAccessToken("a2")).toBeDefined()
  })

  it("refuses to save tokens of a revoked grant until the revocation lapses", async () => {
    let now = 1_000
    const store = new MemoryOAuthStore({ clock: { now: () => now } })
    await store.revokeGrant("g1", 3_000)
    expect(await store.saveAccessToken("a1", { ...refresh })).toBe(false)
    expect(await store.saveRefreshToken("r1", refresh)).toBe(false)
    expect(await store.findAccessToken("a1")).toBeUndefined()
    expect(await store.consumeRefreshToken("r1")).toBeUndefined()
    expect(await store.saveAccessToken("a2", { ...refresh, grantId: "g2" })).toBe(true)
    now = 3_000
    expect(await store.saveAccessToken("a1", { ...refresh })).toBe(true)
    expect(await store.findAccessToken("a1")).toBeDefined()
  })

  it("drops expired records when a new one is saved", async () => {
    let now = 1_000
    const store = new MemoryOAuthStore({ clock: { now: () => now } })
    await store.saveAccessToken("old", { ...refresh, expiresAt: 1_500 })
    now = 1_500
    await store.saveAccessToken("new", refresh)
    expect(await store.findAccessToken("old")).toBeUndefined()
    expect(await store.findAccessToken("new")).toBeDefined()
  })

  it("hands out copies, so a caller cannot edit a stored record", async () => {
    const store = new MemoryOAuthStore({ clock: { now: () => 1_000 } })
    const saved = { ...refresh }
    await store.saveAccessToken("a", saved)
    saved.resource = "https://evil.example"
    const read = await store.findAccessToken("a")
    read!.resource = "https://evil.example"
    expect((await store.findAccessToken("a"))?.resource).toBe(refresh.resource)
  })
})
