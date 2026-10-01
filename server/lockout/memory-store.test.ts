import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryLockoutStore } from "./memory-store.ts"
import { describeLockoutStoreContract } from "./store-contract.test.ts"

describeLockoutStoreContract("MemoryLockoutStore", ({ createMissing }) => {
  const store = new MemoryLockoutStore({ createMissing })
  return Promise.resolve({
    store,
    track: (subject) => Promise.resolve(store.track(subject)),
    read: (subject) => Promise.resolve(store.get(subject)),
    close: () => Promise.resolve(),
  })
})

describe("MemoryLockoutStore", () => {
  it("hands out copies, so a caller cannot edit a stored counter", async () => {
    const store = new MemoryLockoutStore()
    await store.update("ann", (current) => current && { ...current, failures: 3 })
    const read = store.get("ann")
    if (read === undefined) throw new Error("expected a counter")
    read.failures = 0
    expect(store.get("ann")?.failures).toBe(3)
  })

  it('counts the number 1 and the string "1" as one subject', async () => {
    const store = new MemoryLockoutStore()
    await store.update(1, (current) => current && { ...current, failures: 2 })
    await store.update("1", (current) => current && { ...current, failures: current.failures + 1 })
    expect(store.get(1)?.failures).toBe(3)
    expect(store.get("1")?.failures).toBe(3)
  })

  it("rejects instead of throwing when the change throws", () => {
    const store = new MemoryLockoutStore()
    const pending = store.update("ann", () => {
      throw new RangeError("boom")
    })
    expect(pending).toBeInstanceOf(Promise)
    return pending.then(
      () => Promise.reject(new Error("expected a rejection")),
      (error: unknown) => expect(error).toBeInstanceOf(RangeError),
    )
  })
})
