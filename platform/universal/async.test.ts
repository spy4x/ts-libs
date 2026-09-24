import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { backoffDelay, debounce, sleep } from "./async.ts"
import { DEFAULT_DEBOUNCE_DELAY } from "./constants.ts"

describe("sleep", () => {
  it("resolves after at least the requested delay", async () => {
    const start = performance.now()
    await sleep(5)
    expect(performance.now() - start).toBeGreaterThanOrEqual(4)
  })

  it("resolves immediately for a zero delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined()
  })
})

describe("debounce", () => {
  /** Collects calls and lets a test run pending timers deterministically. */
  function recorder() {
    const calls: unknown[][] = []
    const debounced = debounce((...args: unknown[]) => void calls.push(args), 5)
    return { calls, debounced }
  }

  it("reports a pending invocation before the delay elapses", () => {
    const { debounced, calls } = recorder()
    debounced(1)
    expect(debounced.pending()).toBe(true)
    expect(calls.length).toBe(0)
    debounced.cancel()
  })

  it("invokes once with the last arguments after the delay", async () => {
    const { debounced, calls } = recorder()
    debounced("first")
    debounced("second")
    debounced("third")
    await sleep(20)
    expect(calls).toEqual([["third"]])
    expect(debounced.pending()).toBe(false)
  })

  it("drops a queued invocation when cancelled", async () => {
    const { debounced, calls } = recorder()
    debounced("only")
    debounced.cancel()
    await sleep(20)
    expect(calls).toEqual([])
    expect(debounced.pending()).toBe(false)
  })

  it("allows a new invocation after one has fired", async () => {
    const { debounced, calls } = recorder()
    debounced("a")
    await sleep(20)
    debounced("b")
    await sleep(20)
    expect(calls).toEqual([["a"], ["b"]])
  })

  it("exposes the documented default delay", () => {
    expect(DEFAULT_DEBOUNCE_DELAY).toBe(300)
  })
})

describe("backoffDelay", () => {
  it("returns the capped raw delay unchanged when jitterRatio is 0 or less", () => {
    expect(
      backoffDelay({ rawMs: 1000, maxMs: 10_000, jitterRatio: 0, mode: "symmetric" }),
    ).toBe(1000)
    expect(
      backoffDelay({ rawMs: 20_000, maxMs: 10_000, jitterRatio: -1, mode: "downward" }),
    ).toBe(10_000)
  })

  it("clamps a raw delay below zero up to zero before jittering", () => {
    expect(
      backoffDelay({ rawMs: -50, maxMs: 10_000, jitterRatio: 0, mode: "symmetric" }),
    ).toBe(0)
  })

  describe("symmetric mode", () => {
    it("jitters both above and below the capped delay", () => {
      const low = backoffDelay({
        rawMs: 1000,
        maxMs: 10_000,
        jitterRatio: 0.2,
        mode: "symmetric",
        random: () => 0,
      })
      const high = backoffDelay({
        rawMs: 1000,
        maxMs: 10_000,
        jitterRatio: 0.2,
        mode: "symmetric",
        random: () => 1,
      })
      expect(low).toBe(800)
      expect(high).toBe(1200)
    })

    it("re-clamps a jittered delay to maxMs", () => {
      expect(
        backoffDelay({
          rawMs: 9500,
          maxMs: 10_000,
          jitterRatio: 0.2,
          mode: "symmetric",
          random: () => 1,
        }),
      ).toBe(10_000)
    })

    it("floors a jittered delay at minFloorMs", () => {
      expect(
        backoffDelay({
          rawMs: 1000,
          maxMs: 10_000,
          jitterRatio: 1,
          mode: "symmetric",
          minFloorMs: 1,
          random: () => 0,
        }),
      ).toBe(1)
    })

    it("defaults minFloorMs to 0", () => {
      expect(
        backoffDelay({
          rawMs: 1000,
          maxMs: 10_000,
          jitterRatio: 1,
          mode: "symmetric",
          random: () => 0,
        }),
      ).toBe(0)
    })
  })

  describe("downward mode", () => {
    it("only ever removes wait, never adds it", () => {
      const lowest = backoffDelay({
        rawMs: 400,
        maxMs: 10_000,
        jitterRatio: 0.5,
        mode: "downward",
        random: () => 0,
      })
      const highest = backoffDelay({
        rawMs: 400,
        maxMs: 10_000,
        jitterRatio: 0.5,
        mode: "downward",
        random: () => 0.999,
      })
      expect(lowest).toBe(200)
      expect(highest).toBe(400)
    })

    it("clamps jitterRatio to 0.999 so the band never collapses to zero", () => {
      expect(
        backoffDelay({
          rawMs: 400,
          maxMs: 10_000,
          jitterRatio: 1,
          mode: "downward",
          random: () => 0,
        }),
      ).toBe(0)
    })

    it("re-clamps to maxMs when the random source breaks its [0, 1) contract", () => {
      expect(
        backoffDelay({
          rawMs: 400,
          maxMs: 400,
          jitterRatio: 0.5,
          mode: "downward",
          random: () => 1.5,
        }),
      ).toBe(400)
    })
  })

  it("draws from Math.random by default", () => {
    const original = Math.random
    try {
      Math.random = () => 0
      expect(backoffDelay({ rawMs: 400, maxMs: 10_000, jitterRatio: 0.5, mode: "downward" }))
        .toBe(200)
    } finally {
      Math.random = original
    }
  })
})
