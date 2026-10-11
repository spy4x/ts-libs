import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  errorCodeOf,
  type OutboxAttemptFailure,
  type OutboxEvent,
  OutboxLeaseExpiredError,
  OutboxProcessor,
  type OutboxRepository,
  retryDelayMs,
} from "./processor.ts"

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventKind: "group.created",
    aggregateType: "group",
    aggregateId: "22222222-2222-4222-8222-222222222222",
    aggregateVersion: "1",
    attemptCount: 1,
    ...overrides,
  }
}

class FakeRepository implements OutboxRepository {
  processed: string[] = []
  retries: { id: string; delaySeconds: number; errorCode: string }[] = []
  claims: { limit: number; maxAttempts: number; leaseSeconds: number }[] = []

  constructor(
    private batches: OutboxEvent[][],
    private onExhausted?: () => void,
  ) {}

  claimBatch(limit: number, maxAttempts: number, leaseSeconds: number): Promise<OutboxEvent[]> {
    this.claims.push({ limit, maxAttempts, leaseSeconds })
    const batch = this.batches.shift()
    if (!batch) this.onExhausted?.()
    return Promise.resolve(batch ?? [])
  }
  repeats: (number | undefined)[] = []
  markProcessed(id: string, repeatInSeconds?: number): Promise<void> {
    this.processed.push(id)
    this.repeats.push(repeatInSeconds)
    return Promise.resolve()
  }
  scheduleRetry(
    id: string,
    delaySeconds: number,
    errorCode: string,
  ): Promise<void> {
    this.retries.push({ id, delaySeconds, errorCode })
    return Promise.resolve()
  }
}

describe("retryDelayMs", () => {
  it("doubles per attempt starting at the base delay", () => {
    expect(retryDelayMs(1, 1000, 60_000)).toBe(1000)
    expect(retryDelayMs(2, 1000, 60_000)).toBe(2000)
    expect(retryDelayMs(4, 1000, 60_000)).toBe(8000)
  })

  it("caps at the maximum delay", () => {
    expect(retryDelayMs(20, 1000, 60_000)).toBe(60_000)
  })

  it("does not overflow on an absurd attempt count", () => {
    expect(retryDelayMs(1000, 1000, 60_000)).toBe(60_000)
  })

  it("gives attempt 1's delay for attempt 0, a negative attempt and a fractional attempt", () => {
    // A first review round found this call delegating straight to
    // createExponentialBackoff(attemptCount), which computes 2 ** (attemptCount - 1)
    // and so quietly halves (or otherwise shortens) the delay for any of these three
    // instead of matching the ported original's own Math.max(0, attemptCount - 1).
    expect(retryDelayMs(0, 1000, 60_000)).toBe(1000)
    expect(retryDelayMs(-1, 1000, 60_000)).toBe(1000)
    expect(retryDelayMs(0.5, 1000, 60_000)).toBe(1000)
  })

  it("caps at the maximum delay even with a base of 0, rather than returning 0 or NaN", () => {
    // With baseMs 0, 0 * 2 ** exponent is 0 for a merely large exponent and NaN once
    // the exponent overflows 2 ** exponent to Infinity (0 * Infinity). The ported
    // original's exponent >= 32 guard exists for exactly this case.
    expect(retryDelayMs(33, 0, 60_000)).toBe(60_000)
    expect(retryDelayMs(1025, 0, 60_000)).toBe(60_000)
  })
})

describe("errorCodeOf", () => {
  it("uses the error name and truncates to the column width", () => {
    expect(errorCodeOf(new TypeError("boom"))).toBe("TypeError")
    expect(errorCodeOf("plain string")).toBe("string")

    const longName = new Error("boom")
    longName.name = "N".repeat(100)
    expect(errorCodeOf(longName).length).toBe(64)
  })

  it("falls back to Error when an Error's own name is not a string", () => {
    const error = new Error("boom")
    // Error.prototype.name is a writable string property in its type declaration only
    // — nothing at runtime stops a caller assigning something else.
    Object.assign(error, { name: 42 })
    expect(errorCodeOf(error)).toBe("Error")

    const emptyName = new Error("boom")
    emptyName.name = ""
    expect(errorCodeOf(emptyName)).toBe("Error")
  })
})

describe("OutboxProcessor.drainOnce", () => {
  it("publishes and marks each claimed event", async () => {
    const published: string[] = []
    const repository = new FakeRepository([[
      event({ id: "a" }),
      event({ id: "b" }),
    ]])
    const processor = new OutboxProcessor(repository, {
      publish: (e) => {
        published.push(e.id)
        return Promise.resolve()
      },
    })

    const result = await processor.drainOnce()

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0 })
    expect(published).toEqual(["a", "b"])
    expect(repository.processed).toEqual(["a", "b"])
    expect(repository.retries).toEqual([])
  })

  it("reschedules a failing event without blocking the rest of the batch", async () => {
    const repository = new FakeRepository([[
      event({ id: "poison", attemptCount: 3 }),
      event({ id: "healthy" }),
    ]])
    const processor = new OutboxProcessor(repository, {
      publish: (e) => e.id === "poison" ? Promise.reject(new TypeError("nope")) : Promise.resolve(),
    }, { baseRetryDelayMs: 1000, maxRetryDelayMs: 60_000 })

    const result = await processor.drainOnce()

    expect(result).toEqual({ claimed: 2, published: 1, failed: 1 })
    expect(repository.processed).toEqual(["healthy"])
    // attempt 3 -> base * 2^2 = 4000ms, recorded in seconds
    expect(repository.retries).toEqual([
      { id: "poison", delaySeconds: 4, errorCode: "TypeError" },
    ])
  })

  it("reschedules a poisoned event whose thrown Error has a non-string name, and still publishes the rest", async () => {
    const published: string[] = []
    const poisonedError = new Error("boom")
    Object.assign(poisonedError, { name: 42 })
    const repository = new FakeRepository([[
      event({ id: "poison", attemptCount: 1 }),
      event({ id: "healthy" }),
    ]])
    const processor = new OutboxProcessor(repository, {
      publish: (e) => {
        if (e.id === "poison") return Promise.reject(poisonedError)
        published.push(e.id)
        return Promise.resolve()
      },
    })

    const result = await processor.drainOnce()

    expect(result).toEqual({ claimed: 2, published: 1, failed: 1 })
    expect(published).toEqual(["healthy"])
    expect(repository.processed).toEqual(["healthy"])
    expect(repository.retries).toEqual([
      { id: "poison", delaySeconds: 1, errorCode: "Error" },
    ])
  })

  it("passes the configured batch size, attempt ceiling and lease to the claim", async () => {
    const repository = new FakeRepository([[]])
    const processor = new OutboxProcessor(repository, {
      publish: () => Promise.resolve(),
    }, {
      batchSize: 7,
      maxAttempts: 3,
      leaseSeconds: 30,
    })

    await processor.drainOnce()

    expect(repository.claims).toEqual([{ limit: 7, maxAttempts: 3, leaseSeconds: 30 }])
  })

  it("claims with a non-zero default lease so a claimed row is not reclaimed", async () => {
    const repository = new FakeRepository([[]])
    await new OutboxProcessor(repository, { publish: () => Promise.resolve() }).drainOnce()
    expect(repository.claims[0].leaseSeconds).toBeGreaterThan(0)
  })

  it("reports an empty drain rather than failing", async () => {
    const processor = new OutboxProcessor(new FakeRepository([]), {
      publish: () => Promise.resolve(),
    })
    expect(await processor.drainOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    })
  })
})

describe("OutboxProcessor.run", () => {
  it("keeps draining while work remains and stops once aborted", async () => {
    const controller = new AbortController()
    // Aborting exactly when the backlog runs dry keeps this deterministic and means
    // the idle wait is never reached.
    const repository = new FakeRepository(
      [[event({ id: "a" })], [event({ id: "b" })]],
      () => controller.abort(),
    )

    await new OutboxProcessor(repository, { publish: () => Promise.resolve() })
      .run(controller.signal, 10_000)

    expect(repository.processed).toEqual(["a", "b"])
    expect(repository.claims.length).toBe(3)
  })

  it("stops immediately when the signal is already aborted", async () => {
    const repository = new FakeRepository([[event()]])
    const controller = new AbortController()
    controller.abort()

    await new OutboxProcessor(repository, { publish: () => Promise.resolve() })
      .run(controller.signal)

    expect(repository.claims).toEqual([])
  })
})

interface LeasedRow {
  id: string
  availableAt: number
  attempts: number
  processed: boolean
}

/**
 * A fake repository that applies the Postgres repository's lease rule on a fake
 * clock: a claim bumps the attempt count and hides the row for `leaseSeconds`, and a
 * release undoes a claim only while the attempt count still matches it.
 */
class LeasedRepository implements OutboxRepository {
  readonly rows: LeasedRow[]
  release?: (events: OutboxEvent[]) => Promise<void>

  constructor(protected readonly clock: { now: number }, count: number, withRelease: boolean) {
    this.rows = Array.from({ length: count }, (_, i) => ({
      id: String(i + 1),
      availableAt: 0,
      attempts: 0,
      processed: false,
    }))
    if (withRelease) {
      this.release = (events) => {
        for (const released of events) {
          const row = this.#row(released.id)
          if (row.processed || row.attempts !== released.attemptCount) continue
          row.attempts--
          row.availableAt = this.clock.now
        }
        return Promise.resolve()
      }
    }
  }

  #row(id: string): LeasedRow {
    const row = this.rows.find((candidate) => candidate.id === id)
    if (!row) throw new Error(`no row ${id}`)
    return row
  }

  claimBatch(limit: number, maxAttempts: number, leaseSeconds: number): Promise<OutboxEvent[]> {
    const claimed = this.rows
      .filter((r) => !r.processed && r.availableAt <= this.clock.now && r.attempts < maxAttempts)
      .slice(0, limit)
    for (const row of claimed) {
      row.attempts++
      row.availableAt = this.clock.now + leaseSeconds * 1000
    }
    return Promise.resolve(
      claimed.map((row) => event({ id: row.id, aggregateId: row.id, attemptCount: row.attempts })),
    )
  }
  markProcessed(id: string): Promise<void> {
    this.#row(id).processed = true
    return Promise.resolve()
  }
  scheduleRetry(): Promise<void> {
    return Promise.resolve()
  }
}

describe("OutboxProcessor.drainOnce against one lease for the whole batch", () => {
  // Every publish takes 2 seconds on the fake clock, well under the 60-second default
  // lease, but 50 of them (the default batch) take 100 seconds.
  const PUBLISH_MS = 2_000

  it("does not deliver an event twice when two workers share a batch slower than the lease", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const deliveries = new Map<string, number>()
    let secondRan = false
    const publisher = {
      async publish(e: OutboxEvent) {
        deliveries.set(e.id, (deliveries.get(e.id) ?? 0) + 1)
        clock.now += PUBLISH_MS
        // A second worker polls once, 70 seconds in: past the first worker's lease.
        if (clock.now >= 70_000 && !secondRan) {
          secondRan = true
          await second.drainOnce()
        }
      },
    }
    const now = () => clock.now
    const first = new OutboxProcessor(repository, publisher, { now })
    const second = new OutboxProcessor(repository, publisher, { now })

    await first.drainOnce()
    await second.drainOnce()

    expect([...deliveries].filter(([, n]) => n > 1)).toEqual([])
    expect(deliveries.size).toBe(50)
    expect(repository.rows.every((row) => row.processed)).toBe(true)
  })

  it("stops before the lease runs out and hands the untried events back", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const processor = new OutboxProcessor(repository, {
      publish: () => {
        clock.now += PUBLISH_MS
        return Promise.resolve()
      },
    }, { now: () => clock.now })

    const result = await processor.drainOnce()

    // After 29 publishes, 58 s have passed; a 30th 2-second publish would reach 60 s.
    expect(result).toEqual({ claimed: 50, published: 29, failed: 0 })
    expect(clock.now).toBeLessThan(60_000)
    const untried = repository.rows.filter((row) => !row.processed)
    expect(untried.length).toBe(21)
    expect(untried.every((row) => row.availableAt <= clock.now)).toBe(true)
  })

  it("counts an attempt only for events that were actually tried", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const tried = new Map<string, number>()
    const processor = new OutboxProcessor(repository, {
      publish: (e) => {
        tried.set(e.id, (tried.get(e.id) ?? 0) + 1)
        clock.now += PUBLISH_MS
        return Promise.resolve()
      },
    }, { now: () => clock.now })

    // Drain until the queue is empty, as `run` would.
    while ((await processor.drainOnce()).claimed > 0) {
      clock.now += 1
    }

    expect(tried.size).toBe(50)
    for (const row of repository.rows) {
      expect({ id: row.id, attempts: row.attempts }).toEqual({
        id: row.id,
        attempts: tried.get(row.id),
      })
    }
  })

  it("still stops at the lease when the repository cannot release, leaving the rest leased", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, false)
    const deliveries: string[] = []
    const processor = new OutboxProcessor(repository, {
      publish: (e) => {
        deliveries.push(e.id)
        clock.now += PUBLISH_MS
        return Promise.resolve()
      },
    }, { now: () => clock.now })

    const result = await processor.drainOnce()

    expect(result.published).toBe(29)
    expect(deliveries.length).toBe(29)
    // The untried rows stay hidden until the lease they were claimed under expires.
    expect(await repository.claimBatch(50, 10, 60)).toEqual([])
  })

  it("always tries the first event of a batch, so even a zero lease still makes progress", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 3, true)
    const processor = new OutboxProcessor(repository, {
      publish: () => {
        clock.now += PUBLISH_MS
        return Promise.resolve()
      },
    }, { leaseSeconds: 0, now: () => clock.now })

    expect(await processor.drainOnce()).toEqual({ claimed: 3, published: 1, failed: 0 })
  })
})

describe("OutboxProcessor slowestPublishMs floor", () => {
  // The issue's case: a 30-second lease, 1-second publishes, and event 29 takes 5
  // seconds and starts at 28 seconds, where 28 + 1 < 30 lets the unfloored drain go on.
  const LEASE_SECONDS = 30

  async function runTwoWorkers(slowestPublishMs: number | undefined) {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const deliveries = new Map<string, number>()
    let secondRan = false
    const publisher = {
      async publish(e: OutboxEvent) {
        deliveries.set(e.id, (deliveries.get(e.id) ?? 0) + 1)
        clock.now += e.id === "29" ? 5_000 : 1_000
        // A second worker polls once the first worker's lease is over.
        if (clock.now >= LEASE_SECONDS * 1000 && !secondRan) {
          secondRan = true
          await second.drainOnce()
        }
      },
    }
    const options = { leaseSeconds: LEASE_SECONDS, now: () => clock.now, slowestPublishMs }
    const first = new OutboxProcessor(repository, publisher, options)
    const second = new OutboxProcessor(repository, publisher, options)
    const firstResult = await first.drainOnce()
    // Then a worker keeps draining until the queue is empty, as `run` would.
    while ((await second.drainOnce()).claimed > 0) clock.now += 1
    return {
      firstResult,
      duplicated: [...deliveries].filter(([, n]) => n > 1).map(([id]) => id),
      delivered: deliveries.size,
    }
  }

  it("never delivers a publish no slower than the floor twice, even when it is the slowest so far", async () => {
    const { duplicated, delivered } = await runTwoWorkers(5_000)

    expect(duplicated).toEqual([])
    expect(delivered).toBe(50)
  })

  it("keeps today's prediction when the floor is left out, so the same case delivers event 29 twice", async () => {
    const { firstResult, duplicated } = await runTwoWorkers(undefined)

    expect(firstResult).toEqual({ claimed: 50, published: 29, failed: 0 })
    expect(duplicated).toEqual(["29"])
  })

  it("stops earlier than the observed slowest publish would when the floor is larger", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const processor = new OutboxProcessor(repository, {
      publish: () => {
        clock.now += 1_000
        return Promise.resolve()
      },
    }, { leaseSeconds: LEASE_SECONDS, now: () => clock.now, slowestPublishMs: 5_000 })

    // After 25 publishes, 25 s + 5 s reaches the 30 s lease.
    expect(await processor.drainOnce()).toEqual({ claimed: 50, published: 25, failed: 0 })
  })

  it("lets an observed publish slower than the floor raise the prediction", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    const processor = new OutboxProcessor(repository, {
      publish: () => {
        clock.now += 10_000
        return Promise.resolve()
      },
    }, { leaseSeconds: LEASE_SECONDS, now: () => clock.now, slowestPublishMs: 1_000 })

    // After the first 10 s publish the prediction is 10 s, not the 1 s floor: the second
    // runs (10 + 10 < 30), the third would reach 20 + 10 = 30 s.
    expect(await processor.drainOnce()).toEqual({ claimed: 50, published: 2, failed: 0 })
  })

  it("does not stop a batch on the default floor: a zero-length publish still fits the last millisecond", async () => {
    class SlowClaim extends LeasedRepository {
      override claimBatch(limit: number, maxAttempts: number, leaseSeconds: number) {
        this.clock.now += 999
        return super.claimBatch(limit, maxAttempts, leaseSeconds)
      }
    }
    const clock = { now: 0 }
    const repository = new SlowClaim(clock, 3, true)
    const processor = new OutboxProcessor(repository, {
      publish: () => Promise.resolve(),
    }, { leaseSeconds: 1, now: () => clock.now })

    // 999 ms used by the claim; instant publishes, so 999 + 0 < 1000 for every event.
    expect(await processor.drainOnce()).toEqual({ claimed: 3, published: 3, failed: 0 })
  })

  it("keeps the slowest publish of the batch, not the latest one, as the prediction", async () => {
    const clock = { now: 0 }
    const repository = new LeasedRepository(clock, 50, true)
    let calls = 0
    const processor = new OutboxProcessor(repository, {
      publish: () => {
        clock.now += calls++ === 0 ? 10_000 : 1_000
        return Promise.resolve()
      },
    }, { leaseSeconds: LEASE_SECONDS, now: () => clock.now })

    // The 10 s publish stays the prediction: stops once 10 s + elapsed reaches 30 s,
    // that is after 10 s + 10 x 1 s = 20 s, so 11 publishes.
    expect(await processor.drainOnce()).toEqual({ claimed: 50, published: 11, failed: 0 })
  })

  it("refuses a floor that reaches the lease", () => {
    const repository = new LeasedRepository({ now: 0 }, 0, true)
    const publisher = { publish: () => Promise.resolve() }

    expect(() =>
      new OutboxProcessor(repository, publisher, { leaseSeconds: 30, slowestPublishMs: 40_000 })
    ).toThrow(RangeError)
    expect(() =>
      new OutboxProcessor(repository, publisher, { leaseSeconds: 30, slowestPublishMs: 30_000 })
    ).toThrow(RangeError)
    expect(() =>
      new OutboxProcessor(repository, publisher, { leaseSeconds: 30, slowestPublishMs: 29_999 })
    ).not.toThrow()
  })

  it("refuses a negative, infinite or NaN floor at construction", () => {
    const repository = new LeasedRepository({ now: 0 }, 0, true)
    const publisher = { publish: () => Promise.resolve() }

    for (const bad of [-1, Infinity, -Infinity, NaN]) {
      expect(() => new OutboxProcessor(repository, publisher, { slowestPublishMs: bad }))
        .toThrow(RangeError)
    }
    expect(() => new OutboxProcessor(repository, publisher, { slowestPublishMs: 0 }))
      .not.toThrow()
  })
})

describe("OutboxProcessor repeatEveryMs", () => {
  const ok = { publish: () => Promise.resolve() }

  it("asks for the next run, in seconds, only for a kind that repeats", async () => {
    const repository = new FakeRepository([[
      event({ id: "nightly", eventKind: "nightly.cleanup" }),
      event({ id: "plain", eventKind: "group.created" }),
    ]])
    const processor = new OutboxProcessor(repository, ok, {
      repeatEveryMs: { "nightly.cleanup": 86_400_000 },
    })

    await processor.drainOnce()

    expect(repository.processed).toEqual(["nightly", "plain"])
    expect(repository.repeats).toEqual([86_400, undefined])
  })

  it("asks for no next run when the publish fails", async () => {
    const repository = new FakeRepository([[event({ eventKind: "nightly.cleanup" })]])
    const processor = new OutboxProcessor(
      repository,
      { publish: () => Promise.reject(new Error("down")) },
      { repeatEveryMs: { "nightly.cleanup": 1000 } },
    )

    await processor.drainOnce()

    expect(repository.processed).toEqual([])
    expect(repository.retries.length).toBe(1)
  })

  it("refuses an interval that is zero, negative or not finite", () => {
    for (const ms of [0, -1, Infinity, NaN]) {
      expect(() => new OutboxProcessor(new FakeRepository([]), ok, { repeatEveryMs: { k: ms } }))
        .toThrow(RangeError)
    }
  })
})

/** A repository that can also give events up and find lost ones, as the Postgres one can. */
class GivingUpRepository extends FakeRepository {
  givenUp: { id: string; errorCode: string; repeatInSeconds?: number }[] = []
  lostQueries: { maxAttempts: number; limit: number }[] = []
  /** What the next `findLost` returns. */
  lost: OutboxEvent[] = []
  /** What `giveUp` answers: `false` plays another worker having given the event up first. */
  marks = true

  giveUp(id: string, errorCode: string, repeatInSeconds?: number): Promise<boolean> {
    this.givenUp.push({ id, errorCode, repeatInSeconds })
    return Promise.resolve(this.marks)
  }
  findLost(maxAttempts: number, limit: number): Promise<OutboxEvent[]> {
    this.lostQueries.push({ maxAttempts, limit })
    const lost = this.lost
    this.lost = []
    return Promise.resolve(lost)
  }
}

/** Runs `body` with `console.error` collected instead of printed. */
async function withSilencedConsoleError(body: (logged: unknown[][]) => Promise<void>) {
  const original = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    await body(logged)
  } finally {
    console.error = original
  }
}

describe("OutboxProcessor onAttemptFailed", () => {
  const down = new TypeError("down")
  const failing = { publish: () => Promise.reject(down) }

  it("tells every failed attempt with its event, error, attempt number and ceiling", async () => {
    const first = event({ id: "a", attemptCount: 1 })
    const second = event({ id: "b", attemptCount: 2 })
    const repository = new FakeRepository([[first, second]])
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, failing, {
      maxAttempts: 3,
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    await processor.drainOnce()

    expect(failures).toEqual([
      {
        event: first,
        error: down,
        attempt: 1,
        maxAttempts: 3,
        lastAttempt: false,
        stage: "publish",
      },
      {
        event: second,
        error: down,
        attempt: 2,
        maxAttempts: 3,
        lastAttempt: false,
        stage: "publish",
      },
    ])
    expect(repository.retries.map((retry) => retry.id)).toEqual(["a", "b"])
  })

  it("says so when the failed attempt was the last one", async () => {
    const repository = new FakeRepository([[event({ attemptCount: 3 })]])
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, failing, {
      maxAttempts: 3,
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    await processor.drainOnce()

    expect(failures.map((failure) => failure.lastAttempt)).toEqual([true])
    expect(failures[0].attempt).toBe(3)
  })

  it("tells nothing about an event that was published", async () => {
    const repository = new FakeRepository([[event()]])
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    expect(await processor.drainOnce()).toEqual({ claimed: 1, published: 1, failed: 0 })
    expect(failures).toEqual([])
  })

  it("tells a failure to write the processed mark apart from a failed publish", async () => {
    const lost = new Error("connection lost")
    class UnmarkableRepository extends FakeRepository {
      override markProcessed(): Promise<void> {
        return Promise.reject(lost)
      }
    }
    const repository = new UnmarkableRepository([[event()]])
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    await processor.drainOnce()

    expect(failures.map((failure) => [failure.stage, failure.error])).toEqual([[
      "markProcessed",
      lost,
    ]])
    expect(repository.retries.length).toBe(1)
  })

  it("keeps draining and still writes the retry when the callback throws or rejects", async () => {
    await withSilencedConsoleError(async (logged) => {
      const repository = new FakeRepository([[event({ id: "a" }), event({ id: "b" })]])
      let calls = 0
      const processor = new OutboxProcessor(repository, failing, {
        onAttemptFailed: () => {
          if (++calls === 1) throw new Error("logger broke")
          return Promise.reject(new Error("logger broke again"))
        },
      })

      expect(await processor.drainOnce()).toEqual({ claimed: 2, published: 0, failed: 2 })
      expect(repository.retries.map((retry) => retry.id)).toEqual(["a", "b"])
      expect(logged.length).toBe(2)
    })
  })

  it("waits for an asynchronous callback before it writes the retry", async () => {
    const repository = new FakeRepository([[event()]])
    const order: string[] = []
    const processor = new OutboxProcessor(repository, failing, {
      onAttemptFailed: async () => {
        // A timer, not a microtask: a processor that did not wait would be long past the retry.
        await new Promise((resolve) => setTimeout(resolve, 0))
        order.push(`told, ${repository.retries.length} retries written`)
      },
    })

    await processor.drainOnce()

    expect(order).toEqual(["told, 0 retries written"])
    expect(repository.retries.length).toBe(1)
  })

  it("gives a last attempt up instead of scheduling a retry, when the repository can", async () => {
    const repository = new GivingUpRepository([[
      event({ id: "early", attemptCount: 2 }),
      event({ id: "last", attemptCount: 3, eventKind: "nightly.cleanup" }),
    ]])
    const processor = new OutboxProcessor(repository, failing, {
      maxAttempts: 3,
      repeatEveryMs: { "nightly.cleanup": 86_400_000 },
      onAttemptFailed: () => {},
    })

    await processor.drainOnce()

    expect(repository.retries.map((retry) => retry.id)).toEqual(["early"])
    // No next run: `repeatAfterGiveUp` is off.
    expect(repository.givenUp).toEqual([{
      id: "last",
      errorCode: "TypeError",
      repeatInSeconds: undefined,
    }])
  })

  it("tells an event whose last attempt was lost, as the lease stage", async () => {
    const repository = new GivingUpRepository([])
    const lost = event({ id: "lost", attemptCount: 3 })
    repository.lost = [lost]
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, failing, {
      maxAttempts: 3,
      batchSize: 7,
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    expect(await processor.drainOnce()).toEqual({ claimed: 0, published: 0, failed: 0 })

    expect(repository.lostQueries).toEqual([{ maxAttempts: 3, limit: 7 }])
    expect(repository.givenUp).toEqual([{
      id: "lost",
      errorCode: "OutboxLeaseExpired",
      repeatInSeconds: undefined,
    }])
    expect(failures.length).toBe(1)
    expect(failures[0]).toMatchObject({
      event: lost,
      attempt: 3,
      maxAttempts: 3,
      lastAttempt: true,
      stage: "lease",
    })
    expect(failures[0].error).toBeInstanceOf(OutboxLeaseExpiredError)
  })

  it("does not tell a lost event that another worker gave up first", async () => {
    const repository = new GivingUpRepository([])
    repository.lost = [event({ attemptCount: 3 })]
    repository.marks = false
    const failures: OutboxAttemptFailure[] = []
    const processor = new OutboxProcessor(repository, failing, {
      maxAttempts: 3,
      onAttemptFailed: (failure) => void failures.push(failure),
    })

    await processor.drainOnce()

    expect(repository.givenUp.length).toBe(1)
    expect(failures).toEqual([])
  })

  it("neither gives up nor looks for lost events without the callback", async () => {
    const repository = new GivingUpRepository([[event({ attemptCount: 3 })]])
    repository.lost = [event({ id: "lost", attemptCount: 3 })]
    const processor = new OutboxProcessor(repository, failing, { maxAttempts: 3 })

    await processor.drainOnce()

    expect(repository.retries.length).toBe(1)
    expect(repository.givenUp).toEqual([])
    expect(repository.lostQueries).toEqual([])
  })
})

describe("OutboxProcessor repeatAfterGiveUp", () => {
  const failing = { publish: () => Promise.reject(new TypeError("down")) }
  const options = {
    maxAttempts: 3,
    repeatEveryMs: { "nightly.cleanup": 86_400_000 },
    repeatAfterGiveUp: true,
  }

  it("asks for the next run of a repeating job that fails its last attempt", async () => {
    const repository = new GivingUpRepository([[
      event({ id: "nightly", eventKind: "nightly.cleanup", attemptCount: 3 }),
      event({ id: "plain", eventKind: "group.created", attemptCount: 3 }),
    ]])

    await new OutboxProcessor(repository, failing, options).drainOnce()

    expect(repository.givenUp).toEqual([
      { id: "nightly", errorCode: "TypeError", repeatInSeconds: 86_400 },
      { id: "plain", errorCode: "TypeError", repeatInSeconds: undefined },
    ])
    expect(repository.retries).toEqual([])
  })

  it("asks for no next run while the job still has attempts left", async () => {
    const repository = new GivingUpRepository([[
      event({ eventKind: "nightly.cleanup", attemptCount: 2 }),
    ]])

    await new OutboxProcessor(repository, failing, options).drainOnce()

    expect(repository.givenUp).toEqual([])
    expect(repository.retries.length).toBe(1)
  })

  it("asks for the next run of a repeating job whose last attempt was lost", async () => {
    const repository = new GivingUpRepository([])
    repository.lost = [event({ id: "nightly", eventKind: "nightly.cleanup", attemptCount: 3 })]

    await new OutboxProcessor(repository, failing, options).drainOnce()

    expect(repository.givenUp).toEqual([
      { id: "nightly", errorCode: "OutboxLeaseExpired", repeatInSeconds: 86_400 },
    ])
  })

  it("refuses a repository that cannot give up or cannot find lost events", () => {
    class OnlyGivingUp extends FakeRepository {
      giveUp(): Promise<boolean> {
        return Promise.resolve(true)
      }
    }
    for (const repository of [new FakeRepository([]), new OnlyGivingUp([])]) {
      expect(() => new OutboxProcessor(repository, failing, options)).toThrow(TypeError)
    }
    expect(() => new OutboxProcessor(new GivingUpRepository([]), failing, options)).not.toThrow()
  })
})
