import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Clock, Sleeper } from "./retry.ts"
import {
  createExponentialBackoff,
  describeErrorKind,
  describeTransportError,
  isPermanentStatus,
  isTransientStatus,
  parseRetryAfterMs,
  runWithRetry,
} from "./retry.ts"

interface RecordingTimer {
  /** Manual time source, so no test ever reads wall time. */
  clock: Clock
  sleep: Sleeper
  /** Durations requested, in order. */
  delays: number[]
}

/**
 * A sleeper that records instead of waiting, plus the manual clock it advances
 * by the requested amount — so `totalBudgetMs` is exercised without wall time.
 */
const recordingTimer = (): RecordingTimer => {
  const delays: number[] = []
  let now = 0
  return {
    delays,
    clock: () => now,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
}

const policy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  totalBudgetMs: 60_000,
  jitterRatio: 0,
}

describe("parseRetryAfterMs", () => {
  it("reads the delay-seconds form", () => {
    expect(parseRetryAfterMs("2")).toBe(2000)
    expect(parseRetryAfterMs(" 0.5 ")).toBe(500)
  })

  it("ignores an HTTP-date, a negative number and a non-number", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined()
    expect(parseRetryAfterMs("-3")).toBeUndefined()
    expect(parseRetryAfterMs("soon")).toBeUndefined()
    expect(parseRetryAfterMs(null)).toBeUndefined()
  })

  it("treats a blank header as absent, not as zero", () => {
    // `0` is a valid delay, so returning it for an empty header would delete all
    // backoff: the caller would retry immediately and hammer the endpoint it is
    // backing off from. Measured live before the fix: a bare `Retry-After:`
    // produced delays [1, 1] where `null` produced [552, 1009].
    expect(parseRetryAfterMs("")).toBeUndefined()
    expect(parseRetryAfterMs("   ")).toBeUndefined()
    expect(parseRetryAfterMs("\t\n")).toBeUndefined()
    // An explicit zero is still a zero.
    expect(parseRetryAfterMs("0")).toBe(0)
  })

  it("does not let a blank Retry-After collapse the backoff schedule", async () => {
    const policy = {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      totalBudgetMs: 60_000,
      jitterRatio: 0,
    }
    const backoff = createExponentialBackoff(policy)
    const blank = parseRetryAfterMs("")
    const timer = recordingTimer()
    await runWithRetry<number>({
      policy,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: (attempt) => backoff(attempt, blank),
      attempt: (attempt) => Promise.resolve({ failed: true, value: attempt }),
    })
    expect(blank).toBeUndefined()
    expect(timer.delays).toEqual([1000, 2000])
  })
})

describe("createExponentialBackoff", () => {
  const backoff = createExponentialBackoff(policy)

  it("doubles from the base delay", () => {
    expect(backoff(1)).toBe(1000)
    expect(backoff(2)).toBe(2000)
    expect(backoff(3)).toBe(4000)
  })

  it("clamps to maxDelayMs", () => {
    expect(backoff(10)).toBe(10_000)
  })

  it("prefers Retry-After over the computed backoff, still clamped", () => {
    expect(backoff(1, 2000)).toBe(2000)
    expect(backoff(1, 60_000)).toBe(10_000)
    expect(backoff(1, 0)).toBe(0)
  })
})

describe("status classification", () => {
  it("treats 429 and 5xx as transient", () => {
    expect(isTransientStatus(429)).toBe(true)
    expect(isTransientStatus(500)).toBe(true)
    expect(isTransientStatus(503)).toBe(true)
  })

  it("treats 4xx other than 429 as permanent", () => {
    expect(isPermanentStatus(400)).toBe(true)
    expect(isPermanentStatus(404)).toBe(true)
    expect(isTransientStatus(400)).toBe(false)
    expect(isTransientStatus(404)).toBe(false)
  })
})

describe("runWithRetry", () => {
  it("returns after the first non-failing attempt", async () => {
    const timer = recordingTimer()
    let calls = 0
    const run = await runWithRetry<number>({
      policy,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(policy),
      attempt: () => {
        calls++
        return Promise.resolve({ failed: false, value: 7 })
      },
    })
    expect(calls).toBe(1)
    expect(run.attempts).toBe(1)
    expect(run.waitedMs).toBe(0)
    expect(run.result).toBe(7)
  })

  it("retries a transient failure and reports the total attempts", async () => {
    const timer = recordingTimer()
    const run = await runWithRetry<number>({
      policy,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(policy),
      attempt: (attempt) => Promise.resolve({ failed: attempt < 2, value: attempt }),
    })
    expect(run.attempts).toBe(2)
    expect(timer.delays).toEqual([1000])
    expect(run.result).toBe(2)
  })

  it("gives up after maxAttempts on a persistent failure", async () => {
    const timer = recordingTimer()
    let calls = 0
    const run = await runWithRetry<string>({
      policy,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(policy),
      attempt: () => {
        calls++
        return Promise.resolve({ failed: true, value: "down" })
      },
    })
    expect(calls).toBe(3)
    expect(run.attempts).toBe(3)
    expect(timer.delays).toEqual([1000, 2000])
    expect(run.result).toBe("down")
  })

  it("stops before a delay that would exceed totalBudgetMs", async () => {
    const timer = recordingTimer()
    const tight = { ...policy, maxAttempts: 10, totalBudgetMs: 2500 }
    const run = await runWithRetry<number>({
      policy: tight,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(tight),
      attempt: (attempt) => Promise.resolve({ failed: true, value: attempt }),
    })
    // 1000, then 2000 does not fit in the remaining 1500ms.
    expect(timer.delays).toEqual([1000])
    expect(run.attempts).toBe(2)
  })

  it("makes exactly one attempt when maxAttempts is 1", async () => {
    const timer = recordingTimer()
    let calls = 0
    const run = await runWithRetry<number>({
      policy: { ...policy, maxAttempts: 1 },
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(policy),
      attempt: () => {
        calls++
        return Promise.resolve({ failed: true, value: calls })
      },
    })
    expect(calls).toBe(1)
    expect(run.attempts).toBe(1)
    expect(timer.delays).toEqual([])
  })
})

/**
 * Both copies of this module are asserted separately — `retry-drift.test.ts`
 * proves the bytes match, which is not the same as proving either copy behaves
 * — so each one carries its own guard tests for `describeTransportError` and
 * `describeErrorKind`.
 */

/** An `Error` whose `name` getter throws, as a caller's hostile payload can supply. */
const errorWithThrowingName = (message: string): unknown =>
  new (class extends Error {
    override get name(): string {
      throw new TypeError(message)
    }
  })("boom")

/** An `Error` wearing whatever name the caller set, which `Error.name` allows. */
const errorNamed = (name: string): unknown => {
  const error = new TypeError("boom")
  Object.defineProperty(error, "name", { value: name })
  return error
}

describe("describeTransportError", () => {
  it("names a platform error class and withholds the URL", () => {
    expect(
      describeTransportError(
        new TypeError(`Invalid URL: 'https://hooks.slack.invalid/services/T/B/REALTOKENISH'`),
      ),
    ).toBe("TypeError: transport failure (url withheld)")
  })

  it("returns instead of throwing when the name getter itself throws", () => {
    // An unguarded `cause.name` read propagated this throw, which is what made
    // a `Promise<SlackResult>` reject.
    const described = describeTransportError(
      errorWithThrowingName(`Invalid URL: 'https://hooks.slack.invalid/T/B/REALTOKENISH'`),
    )
    expect(described).toBe("transport failure (url withheld)")
    expect(described).not.toContain("REALTOKENISH")
  })

  it("refuses a caller-set name, so the field cannot carry caller text", () => {
    // Only the classes the platform throws are named; a name the caller chose is
    // not one of them. The `Error` fallback is what the result reports instead.
    expect(describeErrorKind(errorNamed("REALTOKENISH"))).toBe("Error")
  })
})

describe("describeErrorKind", () => {
  it("names a real platform class, so the allowlist is not empty", () => {
    expect(describeErrorKind(new TypeError("boom"))).toBe("TypeError")
    expect(describeErrorKind(new RangeError("boom"))).toBe("RangeError")
  })

  it("reports Error for a caller-set name", () => {
    // `Error.name` is writable, so it is caller text: `REALTOKENISH` is 12
    // alphabetic characters, which the previous `/^[A-Za-z]{1,32}$/` admitted.
    expect(describeErrorKind(errorNamed("REALTOKENISH"))).toBe("Error")
    expect(describeErrorKind(errorNamed("A".repeat(32)))).toBe("Error")
  })

  it("reports Error for a URL-shaped name, as it did before the allowlist", () => {
    expect(describeErrorKind(errorNamed("https://hooks.slack.invalid/T/B/REALTOKENISH"))).toBe(
      "Error",
    )
  })

  it("returns instead of throwing when the name getter itself throws", () => {
    expect(describeErrorKind(errorWithThrowingName("Invalid URL: 'https://x.invalid/TOKEN'"))).toBe(
      "Error",
    )
  })

  it("never stringifies a non-Error, so a hostile toString cannot run", () => {
    expect(describeErrorKind("REALTOKENISH")).toBe("Error")
    expect(describeErrorKind(undefined)).toBe("Error")
    expect(
      describeErrorKind({
        toString: () => {
          throw new TypeError("REALTOKENISH")
        },
      }),
    ).toBe("Error")
  })
})
