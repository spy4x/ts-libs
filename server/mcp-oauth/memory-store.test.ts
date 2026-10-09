import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryOAuthStore } from "./memory-store.ts"
import { describeOAuthStoreContract, manualClock, refresh } from "./store-contract.test.ts"

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
})
