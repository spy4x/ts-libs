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
})

describe("errorCodeOf", () => {
  it("uses the error name and truncates to the column width", () => {
    expect(errorCodeOf(new TypeError("boom"))).toBe("TypeError")
    expect(errorCodeOf("plain string")).toBe("string")

    const longName = new Error("boom")
    longName.name = "N".repeat(100)
    expect(errorCodeOf(longName).length).toBe(64)
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
