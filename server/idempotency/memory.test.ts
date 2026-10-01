import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MemoryIdempotencyStore } from "./memory.ts"
import { describeIdempotencyStoreContract } from "./store-contract.test.ts"

describeIdempotencyStoreContract("MemoryIdempotencyStore", () => {
  let now = Date.UTC(2001, 0, 1)
  const store = new MemoryIdempotencyStore({ now: () => now })
  return Promise.resolve({
    store,
    advance: (ms: number) => {
      now += ms
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  })
})

describe("MemoryIdempotencyStore options", () => {
  const claim = { userId: 1, key: "k", commandName: "C", requestHash: "h" }

  it("takes over an unfinished claim after the configured lease", async () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ leaseSeconds: 2, now: () => now })
    await store.begin(claim)
    now = 1_000
    expect((await store.begin(claim)).status).toBe("in_progress")
    now = 3_000
    expect((await store.begin(claim)).status).toBe("claimed")
  })

  it("forgets a key after the configured retention", async () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ retentionDays: 1, now: () => now })
    const outcome = await store.begin(claim)
    if (outcome.status !== "claimed") throw new Error(`expected a claim`)
    await store.complete(1, "k", outcome.token, 1)
    now = 2 * 86_400_000
    expect((await store.begin(claim)).status).toBe("claimed")
  })

  it("refuses a lease that is not a finite number above zero", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => new MemoryIdempotencyStore({ leaseSeconds: bad })).toThrow(RangeError)
    }
  })

  it("refuses a retention that is not a finite number above zero", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => new MemoryIdempotencyStore({ retentionDays: bad })).toThrow(RangeError)
    }
  })
})
