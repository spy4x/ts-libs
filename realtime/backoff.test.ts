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
})
