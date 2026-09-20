import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Clock, RandomSource, Sleeper } from "./retry.ts"
import {
  createExponentialBackoff,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeErrorKind,
  describeTransportError,
  isPermanentStatus,
  isRequestTimeout,
  isTransientStatus,
  parseRetryAfterMs,
  releaseResponseBody,
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

describe("createExponentialBackoff jitter", () => {
  // `jitterRatio: 0.2` is the value the issue names as "the shipped default" —
  // ntfy's and healthchecks' actual shipped policies both use `jitterRatio: 0`
  // (their ported sources never used jitter, see the last test below), so a
  // nonzero ratio is what it takes to exercise this code path at all.
  const jitteredPolicy = { ...policy, jitterRatio: 0.2 }

  it("draws the jitter from the injected random source, not from the attempt number", () => {
    // Before the fix, jitter was `(attempt * 2654435761 + retryAfterMs) % 1000`:
    // a pure function of its inputs, so every process asking for the same
    // attempt computed the exact same "jittered" delay — the opposite of what
    // jitter exists for.
    const low = createExponentialBackoff(jitteredPolicy, () => 0)
    const high = createExponentialBackoff(jitteredPolicy, () => 1)
    expect(low(1)).not.toBe(high(1))
    expect(low(1)).toBe(800)
    expect(high(1)).toBe(1200)
  })

  it("gives two independent random sources different delays for the same attempt", () => {
    // The issue's own acceptance criterion: "two processes do not get identical
    // delays." Two fixed-but-different sources stand in for two processes.
    const processA = createExponentialBackoff(jitteredPolicy, () => 0.1)
    const processB = createExponentialBackoff(jitteredPolicy, () => 0.9)
    expect(processA(2)).not.toBe(processB(2))
  })

  it("keeps every draw inside the documented +/-jitterRatio span", () => {
    const clamped = 1000 // backoff(1) with no jitter applied
    const span = clamped * jitteredPolicy.jitterRatio
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = createExponentialBackoff(jitteredPolicy, () => random)(1)
      expect(delay).toBeGreaterThanOrEqual(clamped - span)
      expect(delay).toBeLessThanOrEqual(clamped + span)
    }
  })

  it("still clamps a jittered delay to maxDelayMs", () => {
    const nearCeiling = { ...jitteredPolicy, baseDelayMs: 9500, maxDelayMs: 10_000 }
    expect(createExponentialBackoff(nearCeiling, () => 1)(1)).toBe(10_000)
  })

  it("is wired to Math.random by default, not to another deterministic stand-in", () => {
    const original = Math.random
    try {
      Math.random = () => 0.9
      expect(createExponentialBackoff(jitteredPolicy)(1)).toBe(1160)
    } finally {
      Math.random = original
    }
  })

  it("returns the unjittered delay when jitterRatio is 0, regardless of the random source", () => {
    // ntfy's and healthchecks' shipped policies both use `jitterRatio: 0`, the
    // early-return path here — their ported sources never used jitter.
    const random: RandomSource = () => 1
    expect(createExponentialBackoff({ ...policy, jitterRatio: 0 }, random)(1)).toBe(1000)
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

describe("isRequestTimeout", () => {
  it("recognises the TimeoutError AbortSignal.timeout() produces", () => {
    expect(isRequestTimeout(new DOMException("The signal timed out", "TimeoutError"))).toBe(true)
  })

  it("does not mistake an ordinary transport failure for a timeout", () => {
    expect(isRequestTimeout(new TypeError("Invalid URL: 'https://x.invalid/'"))).toBe(false)
    expect(isRequestTimeout(new DOMException("aborted", "AbortError"))).toBe(false)
  })

  it("does not throw on a non-Error value", () => {
    expect(isRequestTimeout("TimeoutError")).toBe(false)
    expect(isRequestTimeout(undefined)).toBe(false)
  })
})

describe("DEFAULT_REQUEST_TIMEOUT_MS", () => {
  it("is a positive, finite bound", () => {
    // The bound this whole fix exists to add: before it, no client attached any
    // timeout to a request, so a server that accepted a connection and never
    // answered blocked the caller forever.
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_REQUEST_TIMEOUT_MS)).toBe(true)
  })
})

describe("releaseResponseBody", () => {
  it("cancels a response's body without reading it", async () => {
    const response = new Response("unread payload")
    expect(response.bodyUsed).toBe(false)
    await releaseResponseBody(response)
    expect(response.bodyUsed).toBe(true)
  })

  it("does nothing for a response with no body", async () => {
    const response = new Response(null, { status: 204 })
    expect(response.body).toBeNull()
    await expect(releaseResponseBody(response)).resolves.toBeUndefined()
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

  it("passes the shrinking remaining budget to each attempt", async () => {
    // Before this, `attempt` only ever saw its own index: `totalBudgetMs` bounded
    // when the *next retry* could be scheduled, never what a single attempt's
    // own request was allowed to take — which is how a request with a generous
    // timeout of its own could run well past the budget it was meant to respect.
    const timer = recordingTimer()
    const seen: number[] = []
    await runWithRetry<number>({
      policy,
      sleep: timer.sleep,
      clock: timer.clock,
      backoff: createExponentialBackoff(policy),
      attempt: (attempt, remainingBudgetMs) => {
        seen.push(remainingBudgetMs)
        return Promise.resolve({ failed: true, value: attempt })
      },
    })
    // startedAt is 0; 1000ms and 2000ms of recorded sleep are subtracted from
    // the 60,000ms budget before attempts 2 and 3 see what is left of it.
    expect(seen).toEqual([60_000, 59_000, 57_000])
  })

  it("floors the remaining budget at zero when a sleep runs slightly long", async () => {
    // A real `setTimeout` can fire a little late under load, so the actual
    // elapsed time after a sleep can exceed what the pre-sleep fit check
    // estimated. `remainingBudgetMs` must never go negative when that happens.
    let now = 0
    const tight = { ...policy, maxAttempts: 2, totalBudgetMs: 1000 }
    const seen: number[] = []
    await runWithRetry<number>({
      policy: tight,
      sleep: (ms) => {
        now += ms + 50 // 50ms later than requested
        return Promise.resolve()
      },
      clock: () => now,
      backoff: () => 1000, // exactly the budget, so the pre-sleep fit check still allows it
      attempt: (attempt, remainingBudgetMs) => {
        seen.push(remainingBudgetMs)
        return Promise.resolve({ failed: true, value: attempt })
      },
    })
    expect(seen).toEqual([1000, 0])
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

/**
 * An `Error` whose `name` holds a value that is not a string, which the
 * `string` declaration on `Error.name` does not prevent — the property is
 * writable.
 */
const errorWithRawName = (value: unknown): unknown => {
  const error = new TypeError("boom")
  Object.defineProperty(error, "name", { value })
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

  it("refuses a Symbol name, which would otherwise throw out of the template", () => {
    // `${name}` on a Symbol throws `TypeError: Cannot convert a Symbol value to
    // a string`. The read was guarded but the value was not, so this rejection
    // escaped `describeTransportError` and rejected `send` with it.
    const described = describeTransportError(errorWithRawName(Symbol("not a string")))
    expect(described).toBe("transport failure (url withheld)")
  })

  it("refuses an object name whose toString throws", () => {
    // The interpolation is what would have run the caller's `toString`; the
    // name is refused before any string conversion happens.
    const described = describeTransportError(
      errorWithRawName({
        toString() {
          throw new Error("caller text")
        },
      }),
    )
    expect(described).toBe("transport failure (url withheld)")
    expect(described).not.toContain("caller text")
  })

  it("falls back to the plain wording for a stringifiable but non-string name", () => {
    // Ruling: a non-string is not coerced. `null` and `42` are caller text in a
    // returned, loggable field, so they read as an absent name rather than as
    // "null: transport failure (url withheld)" / "42: transport failure …".
    expect(describeTransportError(errorWithRawName(null))).toBe("transport failure (url withheld)")
    expect(describeTransportError(errorWithRawName(42))).toBe("transport failure (url withheld)")
  })

  it("still names a real platform error, so the refusal is not unconditional", () => {
    expect(describeTransportError(errorWithRawName("TypeError"))).toBe(
      "TypeError: transport failure (url withheld)",
    )
  })
})

describe("describeErrorKind", () => {
  it("names a real platform class, so the allowlist is not empty", () => {
    expect(describeErrorKind(new TypeError("boom"))).toBe("TypeError")
    expect(describeErrorKind(new RangeError("boom"))).toBe("RangeError")
    // Folded in from the deleted ops/notify/retry-guards.test.ts (#67): the ops
    // copy's example was SyntaxError, which this file's allowlist case had not
    // exercised.
    expect(describeErrorKind(new SyntaxError("boom"))).toBe("SyntaxError")
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
