import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryAuthStore } from "./memory-store.ts"
import { ChallengeOutcome } from "./model.ts"
import { describeAuthStoreContract, emailKey, NOW } from "./store-contract.test.ts"

describeAuthStoreContract("MemoryAuthStore", () =>
  Promise.resolve({
    store: new MemoryAuthStore({ clock: { now: () => NOW.getTime() } }),
    close: () => Promise.resolve(),
  }))

describe("MemoryAuthStore", () => {
  it("stamps createdAt and updatedAt from the injected clock", async () => {
    let now = NOW.getTime()
    const store = new MemoryAuthStore({ clock: { now: () => now } })
    const { user, key } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
    expect(user.createdAt.getTime()).toBe(NOW.getTime())
    expect(key.updatedAt.getTime()).toBe(NOW.getTime())

    now += 1000
    await store.updateKeySecret(key.id, "hash-2")
    expect((await store.findKeyById(key.id))?.updatedAt.getTime()).toBe(NOW.getTime() + 1000)
  })

  it("drops the challenges that expired by the time a new one is issued", async () => {
    const store = new MemoryAuthStore()
    const minute = 60_000
    const expiresAt = new Date(NOW.getTime() + minute)
    const challenge = { purpose: "password-reset", secretHash: "hash" }
    await store.issueChallenge({ ...challenge, subject: "old", expiresAt, now: NOW })
    const later = new Date(expiresAt.getTime())
    const laterExpiry = new Date(later.getTime() + minute)
    await store.issueChallenge({ ...challenge, subject: "new", expiresAt: laterExpiry, now: later })

    // Asked about with a time before its expiry, a kept row would still match: it is gone.
    const guess = { ...challenge, maxAttempts: 5, now: NOW }
    expect(await store.attemptChallenge({ ...guess, subject: "old" })).toBe(
      ChallengeOutcome.Missing,
    )
    expect(await store.attemptChallenge({ ...guess, subject: "new" })).toBe(
      ChallengeOutcome.Matched,
    )
  })

  it("hands out copies, so a caller cannot edit a stored row", async () => {
    const store = new MemoryAuthStore()
    const { key } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
    key.secret = "edited"
    const found = await store.findKeyById(key.id)
    expect(found?.secret).toBeNull()
  })

  it("rejects instead of throwing when the input is invalid", () => {
    const store = new MemoryAuthStore()
    const pending = store.createUserWithKey(emailKey("password", "not an address"))
    expect(pending).toBeInstanceOf(Promise)
    return pending.then(
      () => Promise.reject(new Error("expected a rejection")),
      (error: unknown) => expect(error).toBeInstanceOf(TypeError),
    )
  })
})
