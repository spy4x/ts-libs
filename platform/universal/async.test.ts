import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { debounce, sleep } from "./async.ts"
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
