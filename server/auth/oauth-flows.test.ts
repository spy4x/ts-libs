// The flow stores in the unit tier: the shared contract on the memory store and on the key-value
// store over an in-process fake client, then what only one of them does.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createKvOAuthFlowStore,
  createMemoryOAuthFlowStore,
  MAX_PENDING_OAUTH_FLOWS,
  type OAuthFlowKv,
} from "./oauth-flows.ts"
import {
  describeOAuthFlowStoreContract,
  type FlowStoreFixture,
} from "./oauth-flows-contract.test.ts"
import { fixedClock } from "./oauth-scenarios.test.ts"

/** A key-value client in memory whose `take` is atomic, as `GETDEL` is. Records every `set`. */
function fakeKv(): OAuthFlowKv & { values: Map<string, string>; sets: [string, number][] } {
  const values = new Map<string, string>()
  const sets: [string, number][] = []
  return {
    values,
    sets,
    set(key, value, ttlSec) {
      sets.push([key, ttlSec])
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

function fixture(make: (clock: ReturnType<typeof fixedClock>) => FlowStoreFixture["store"]) {
  return () => {
    const clock = fixedClock()
    return Promise.resolve({
      store: make(clock),
      advance: clock.advance,
      now: clock.now,
      close: () => Promise.resolve(),
    })
  }
}

describeOAuthFlowStoreContract("memory", fixture((clock) => createMemoryOAuthFlowStore({ clock })))
describeOAuthFlowStoreContract(
  "key-value over a fake client",
  fixture((clock) => createKvOAuthFlowStore(fakeKv(), { clock })),
)

const MINUTE = 60_000

describe("createMemoryOAuthFlowStore", () => {
  it("drops the oldest flow once maxFlows are pending", async () => {
    const clock = fixedClock()
    const store = createMemoryOAuthFlowStore({ clock, maxFlows: 3 })
    const expiresAt = new Date(clock.now() + 10 * MINUTE)
    for (const state of ["a", "b", "c", "d"]) await store.put(state, { verifier: state }, expiresAt)
    expect(await store.take("a")).toBeNull()
    expect(await store.take("b")).toEqual({ verifier: "b", expiresAt })
    expect(await store.take("d")).toEqual({ verifier: "d", expiresAt })
  })

  it("keeps MAX_PENDING_OAUTH_FLOWS flows by default", async () => {
    const clock = fixedClock()
    expect(MAX_PENDING_OAUTH_FLOWS).toBe(10_000)
    const store = createMemoryOAuthFlowStore({ clock })
    const expiresAt = new Date(clock.now() + 10 * MINUTE)
    for (let i = 0; i < MAX_PENDING_OAUTH_FLOWS; i++) {
      await store.put(`s${i}`, { verifier: `${i}` }, expiresAt)
    }
    expect(await store.take("s0")).toEqual({ verifier: "0", expiresAt })
    await store.put("s-extra-1", { verifier: "x" }, expiresAt)
    await store.put("s-extra-2", { verifier: "y" }, expiresAt)
    expect(await store.take("s1")).toBeNull()
    expect(await store.take("s2")).toEqual({ verifier: "2", expiresAt })
  })

  it("throws a TypeError for a maxFlows that is not a positive integer", () => {
    for (const maxFlows of [0, -1, 1.5, Number.NaN]) {
      expect(() => createMemoryOAuthFlowStore({ maxFlows })).toThrow(TypeError)
    }
  })
})

/** 2100-01-01T00:00:00Z: a value with this expiry is refused for its shape, not for its age. */
const FAR_FUTURE = Date.UTC(2100, 0, 1)

describe("createKvOAuthFlowStore", () => {
  it("writes under the prefix with the lifetime rounded up to a whole second", async () => {
    const clock = fixedClock()
    const kv = fakeKv()
    const store = createKvOAuthFlowStore(kv, { clock })
    await store.put("s1", { verifier: "v" }, new Date(clock.now() + 1500))
    const custom = createKvOAuthFlowStore(kv, { clock, keyPrefix: "app:" })
    await custom.put("s2", { verifier: "v" }, new Date(clock.now() + 600_000))
    expect(kv.sets).toEqual([["oauth-flow:s1", 2], ["app:s2", 600]])
  })

  it("writes nothing for a flow that has already expired", async () => {
    const clock = fixedClock()
    const kv = fakeKv()
    const store = createKvOAuthFlowStore(kv, { clock })
    await store.put("s1", { verifier: "v" }, new Date(clock.now()))
    expect(kv.sets).toEqual([])
  })

  it("reads a value it did not write as no flow, and deletes it", async () => {
    const kv = fakeKv()
    const store = createKvOAuthFlowStore(kv, { clock: fixedClock() })
    const foreign = [
      "not json",
      "null",
      `"text"`,
      `{"verifier":1,"expiresAt":${FAR_FUTURE}}`,
      `{"verifier":"v"}`,
    ]
    for (const [i, value] of foreign.entries()) {
      kv.values.set(`oauth-flow:s${i}`, value)
      expect(await store.take(`s${i}`)).toBeNull()
    }
    expect(kv.values.size).toBe(0)
  })
})
