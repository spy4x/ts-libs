/**
 * Transactional outbox drain.
 *
 * Commands write an outbox row in the same transaction as the state change, so the
 * event and the change are committed atomically. This module drains those committed
 * rows and hands them to a publisher.
 *
 * Rows carry identity only — aggregate, version, kind — and never a payload.
 * Consumers use them to decide that something changed and to pull the authoritative
 * state, which keeps the outbox out of the correctness path.
 */
import { createExponentialBackoff } from "@ts-libs/integrations"

/**
 * One outbox row.
 *
 * The ported original (`template/libs/server/outbox/+index.ts`) also carried
 * `groupId` and `actorUserId` — the template's own data model, not something a
 * generic outbox needs. A consumer that wants to route or filter on more than
 * `aggregateType`/`aggregateId` pulls the authoritative row, per the module doc
 * above; that is the whole point of an identity-only outbox. Dropped here rather
 * than kept as optional fields, since a library-level type should not carry an
 * application's foreign keys at all.
 */
export interface OutboxEvent {
  id: string
  eventKind: string
  aggregateType: string
  aggregateId: string
  /** BIGINT, carried as a decimal string so large values survive JSON. */
  aggregateVersion: string
  /** Includes the attempt being made now, so a first delivery reads as 1. */
  attemptCount: number
}

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>
}

export interface OutboxRepository {
  claimBatch(limit: number, maxAttempts: number, leaseSeconds: number): Promise<OutboxEvent[]>
  markProcessed(id: string): Promise<void>
  scheduleRetry(
    id: string,
    delaySeconds: number,
    errorCode: string,
  ): Promise<void>
}

export interface OutboxProcessorOptions {
  /** Rows claimed per drain. */
  batchSize?: number
  /** A row is abandoned once this many attempts have been made. */
  maxAttempts?: number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  /**
   * How long a claimed row stays invisible to other workers. Must comfortably
   * exceed the slowest expected publish, since a lease that expires mid-publish
   * lets a second worker deliver the same event.
   */
  leaseSeconds?: number
}

export interface DrainResult {
  claimed: number
  published: number
  failed: number
}

const DEFAULTS = {
  batchSize: 50,
  maxAttempts: 10,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 5 * 60_000,
  leaseSeconds: 60,
} as const

/**
 * Exponential backoff on the attempt just made, so the first failure waits `baseMs`
 * and each later one doubles up to `maxMs`.
 *
 * A thin wrapper over `@ts-libs/integrations`'s `createExponentialBackoff`, with
 * `jitterRatio: 0`. Issue #71 lists this exact doubling-and-capping formula as one of
 * the retry helpers duplicated across the codebase; the ported original recomputed it
 * by hand, including its own overflow guard for a very large `attemptCount`. That
 * guard is not needed here — `createExponentialBackoff` clamps with `Math.min` after
 * the power, so an exponent large enough to overflow to `Infinity` still clamps to
 * `maxMs` correctly. No jitter: only one worker holds a claimed row at a time (the
 * lease), so there is nothing to de-synchronise the way jitter de-synchronises a
 * fleet of independent reconnecting clients.
 */
export function retryDelayMs(
  attemptCount: number,
  baseMs: number = DEFAULTS.baseRetryDelayMs,
  maxMs: number = DEFAULTS.maxRetryDelayMs,
): number {
  return createExponentialBackoff({ baseDelayMs: baseMs, maxDelayMs: maxMs, jitterRatio: 0 })(
    attemptCount,
  )
}

/** Short, stable label recorded on the row so failures are greppable. */
export function errorCodeOf(error: unknown): string {
  const name = error instanceof Error ? (error.name || "Error") : typeof error
  return name.slice(0, 64)
}

export class OutboxProcessor {
  readonly #batchSize: number
  readonly #maxAttempts: number
  readonly #baseRetryDelayMs: number
  readonly #maxRetryDelayMs: number
  readonly #leaseSeconds: number

  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: OutboxPublisher,
    options: OutboxProcessorOptions = {},
  ) {
    this.#batchSize = options.batchSize ?? DEFAULTS.batchSize
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULTS.baseRetryDelayMs
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULTS.maxRetryDelayMs
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULTS.leaseSeconds
  }

  /**
   * Claims one batch and publishes it. A failing row is rescheduled and never blocks
   * the rest of the batch, so one poisonous event cannot stall the queue.
   */
  async drainOnce(): Promise<DrainResult> {
    const events = await this.repository.claimBatch(
      this.#batchSize,
      this.#maxAttempts,
      this.#leaseSeconds,
    )
    let published = 0
    let failed = 0

    for (const event of events) {
      try {
        await this.publisher.publish(event)
        await this.repository.markProcessed(event.id)
        published++
      } catch (error) {
        failed++
        const delayMs = retryDelayMs(
          event.attemptCount,
          this.#baseRetryDelayMs,
          this.#maxRetryDelayMs,
        )
        await this.repository.scheduleRetry(
          event.id,
          delayMs / 1000,
          errorCodeOf(error),
        )
      }
    }

    return { claimed: events.length, published, failed }
  }

  /**
   * Drains until aborted, waiting `idleDelayMs` only when a drain came back empty so a
   * backlog is worked through without pausing between batches.
   */
  async run(signal: AbortSignal, idleDelayMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      const result = await this.drainOnce()
      if (signal.aborted || result.claimed > 0) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(onDone, idleDelayMs)
        function onDone() {
          clearTimeout(timer)
          signal.removeEventListener("abort", onDone)
          resolve()
        }
        signal.addEventListener("abort", onDone, { once: true })
      })
    }
  }
}
