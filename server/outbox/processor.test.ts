import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  errorCodeOf,
  type OutboxEvent,
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
  markProcessed(id: string): Promise<void> {
    this.processed.push(id)
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

  constructor(private readonly clock: { now: number }, count: number, withRelease: boolean) {
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
