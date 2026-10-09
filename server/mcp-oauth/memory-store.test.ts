import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { DEFAULT_MAX_PENDING, MemoryOAuthStore } from "./memory-store.ts"
import { describeOAuthStoreContract, manualClock, pending, refresh } from "./store-contract.test.ts"

describeOAuthStoreContract("MemoryOAuthStore", (clock) => new MemoryOAuthStore({ clock }))

describe("MemoryOAuthStore", () => {
  it("drops expired records when a new one is saved", async () => {
    const clock = manualClock()
    const store = new MemoryOAuthStore({ clock })
    await store.saveAccessToken("old", { ...refresh, expiresAt: 1_500 })
    clock.set(1_500)
    await store.saveAccessToken("new", refresh)
    expect(await store.findAccessToken("old")).toBeUndefined()
    expect(await store.findAccessToken("new")).toBeDefined()
  })

  it("keeps at most maxPending pending consents, dropping the oldest first", async () => {
    const store = new MemoryOAuthStore({ clock: manualClock(), maxPending: 2 })
    await store.savePending("first", pending)
    await store.savePending("second", pending)
    await store.savePending("third", pending)
    expect(await store.takePending("first")).toBeUndefined()
    expect(await store.takePending("second")).toBeDefined()
    expect(await store.takePending("third")).toBeDefined()
  })

  it("caps pending consents by default", async () => {
    const store = new MemoryOAuthStore({ clock: manualClock() })
    for (let i = 0; i <= DEFAULT_MAX_PENDING; i++) await store.savePending(`k${i}`, pending)
    expect(await store.takePending("k0")).toBeUndefined()
    expect(await store.takePending("k1")).toBeDefined()
    expect(await store.takePending(`k${DEFAULT_MAX_PENDING}`)).toBeDefined()
  })

  it("refuses a maxPending that is not a positive integer", () => {
    for (const maxPending of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MemoryOAuthStore({ maxPending })).toThrow(RangeError)
    }
  })
})
