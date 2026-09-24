/**
 * Reconnect backoff: growth, cap and jitter band.
 *
 * The random source is injected, so the extremes of the band are asserted exactly rather than
 * sampled, and the cap is checked against the value a caller would actually wait for.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { DEFAULT_BACKOFF, nextBackoffDelay } from "./backoff.ts"

describe("nextBackoffDelay", () => {
  it("starts at the base delay", () => {
    expect(
      nextBackoffDelay({
        attempt: 0,
        random: () => 1,
        baseMs: 500,
        maxMs: 30_000,
      }),
    ).toBe(500)
  })

  it("doubles per attempt", () => {
    const delays = [0, 1, 2, 3].map((attempt) =>
      nextBackoffDelay({ attempt, random: () => 1, baseMs: 100, maxMs: 30_000 })
    )

    expect(delays).toEqual([100, 200, 400, 800])
  })

  it("never exceeds the cap however many attempts fail", () => {
    const delays = [0, 5, 20, 100].map((attempt) =>
      nextBackoffDelay({
        attempt,
        random: () => 1,
        baseMs: 100,
        factor: 2,
        maxMs: 400,
      })
    )

    expect(delays).toEqual([100, 400, 400, 400])
  })

  it("holds the cap for the lowest value the random source can return", () => {
    expect(
      nextBackoffDelay({
        attempt: 40,
        random: () => 0,
        baseMs: 100,
        maxMs: 400,
      }),
    ).toBe(200)
  })

  it("keeps the jittered delay inside the band", () => {
    const lowest = nextBackoffDelay({
      attempt: 2,
      random: () => 0,
      baseMs: 100,
      maxMs: 10_000,
      jitterRatio: 0.5,
    })
    const highest = nextBackoffDelay({
      attempt: 2,
      random: () => 0.999,
      baseMs: 100,
      maxMs: 10_000,
      jitterRatio: 0.5,
    })

    expect(lowest).toBe(200)
    expect(highest).toBe(400)
  })

  it("removes no wait at all when the jitter ratio is zero", () => {
    expect(
      nextBackoffDelay({
        attempt: 3,
        random: () => 0,
        baseMs: 100,
        maxMs: 10_000,
        jitterRatio: 0,
      }),
    ).toBe(800)
  })

  it("never returns more than a non-integer maxMs when the jitter ratio is zero", () => {
    // #71: an earlier extraction of this function's arithmetic rounded the capped delay, which
    // returned 101 here, above maxMs.
    expect(
      nextBackoffDelay({ attempt: 10, baseMs: 100, maxMs: 100.6, jitterRatio: 0 }),
    ).toBe(100.6)
  })

  it("still draws once and rounds when the jitter ratio is zero", () => {
    let calls = 0
    const delay = nextBackoffDelay({
      attempt: 1,
      baseMs: 101,
      factor: 1.5,
      maxMs: 10_000,
      jitterRatio: 0,
      random: () => (calls++, 0.5),
    })
    expect(delay).toBe(152)
    expect(calls).toBe(1)
  })

  it("is deterministic for a fixed random source", () => {
    const first = nextBackoffDelay({
      attempt: 3,
      random: () => 0.25,
      baseMs: 100,
      maxMs: 10_000,
    })
    const second = nextBackoffDelay({
      attempt: 3,
      random: () => 0.25,
      baseMs: 100,
      maxMs: 10_000,
    })

    expect(first).toBe(second)
  })

  it("treats a negative attempt index as the first attempt", () => {
    expect(nextBackoffDelay({ attempt: -3, random: () => 1, baseMs: 100 }))
      .toBe(100)
  })

  it("uses the documented default schedule", () => {
    expect(nextBackoffDelay({ attempt: 0, random: () => 1 })).toBe(
      DEFAULT_BACKOFF.baseMs,
    )
    expect(DEFAULT_BACKOFF.factor).toBe(2)
    expect(DEFAULT_BACKOFF.maxMs).toBe(30_000)
  })

  it("still clamps to the cap when a misbehaving random source returns 1 or more", () => {
    // #74: with a well-behaved `random` in [0, 1), the inner clamp on `capped` already keeps every
    // value at or under `maxMs`, which makes the final `Math.min(maxMs, …)` in the implementation
    // look redundant — it survived a mutation because nothing exercised the one case it actually
    // guards: a caller whose `random` breaks the documented `[0, 1)` contract. Attempt 5 with
    // `baseMs: 100, maxMs: 400` uncapped-doubles to 3200, so `capped` is 400 and `floor` is 200;
    // `random() => 1.5` would compute 200 + 1.5 * 200 = 500 without the outer clamp.
    expect(
      nextBackoffDelay({ attempt: 5, random: () => 1.5, baseMs: 100, maxMs: 400 }),
    ).toBe(400)
  })
})
