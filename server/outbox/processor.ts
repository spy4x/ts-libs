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
import { backoffDelay } from "@spy4x/platform/universal/async"

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
  /**
   * Hands back claimed events the processor never tried, because the batch ran too
   * close to the end of its lease. Undoes the attempt the claim counted and makes each
   * event available again at once. An event another worker has claimed since, or one
   * already processed, is left alone: the event's `attemptCount` is the claim it
   * belongs to.
   *
   * Optional, so a repository written before this method existed still works. Without
   * it, the untried events stay invisible until the lease expires, and their next claim
   * counts one attempt more than was ever made.
   */
  release?(events: OutboxEvent[]): Promise<void>
}

export interface OutboxProcessorOptions {
  /** Rows claimed per drain. */
  batchSize?: number
  /** A row is abandoned once this many attempts have been made. */
  maxAttempts?: number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  /**
   * How long a claimed batch stays invisible to other workers. It must comfortably
   * exceed the slowest single publish, since a lease that expires mid-publish lets a
   * second worker deliver the same event.
   *
   * It need not cover the whole batch. Before each event after the first,
   * `drainOnce` checks the time since it started the claim; when that time plus the
   * slowest publish seen so far in this batch would reach the lease, it stops and
   * hands the untried events back through `OutboxRepository.release`. The first event
   * of a batch is always tried, so a batch always makes progress.
   */
  leaseSeconds?: number
  /**
   * Milliseconds clock used to measure a batch against its lease. Defaults to
   * `Date.now`; tests pass a fake one.
   */
  now?: () => number
}

/**
 * What one `drainOnce` did. `claimed - published - failed` events were handed back
 * untried because the batch ran too close to the end of its lease.
 */
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
 * Issue #71 lists this doubling-and-capping formula as one of the retry helpers
 * duplicated across the codebase, so the final clamp to `[0, maxMs]` delegates to
 * `@spy4x/platform/universal/async`'s `backoffDelay` directly (`mode: "symmetric"`,
 * `jitterRatio: 0`, since only one worker holds a claimed row at a time via its
 * lease, so there is nothing to de-synchronise — at `jitterRatio <= 0`,
 * `"symmetric"` mode returns the capped delay unrounded and unchanged, exactly what
 * this call needs). `integrations/retry.ts`'s `createExponentialBackoff` — a thin,
 * now-`@deprecated` wrapper over the same `backoffDelay` — was used here until a
 * review found it introduces exactly the wrapper it exists to spare new code from
 * having to reimplement; calling `backoffDelay` directly needs no more code and
 * carries no deprecated name. The uncapped delay is still computed exactly as the
 * ported original computed it, because a first review round found that a direct
 * call — `createExponentialBackoff(...)  (attemptCount)` — quietly changed the
 * source's own numbers: `attemptCount` fed straight into `2 ** (attempt - 1)` gives
 * half the source's delay at `attemptCount === 0` (`baseMs / 2` instead of
 * `baseMs`), a shorter delay for a negative or fractional `attemptCount`, and — with
 * `baseMs === 0` — `0` instead of `maxMs` for a large attempt count, or `NaN` once
 * the exponent overflowed to `Infinity` (`0 * Infinity`). `Math.max(1,
 * attemptCount)` and the ported original's own `exponent >= 32 ? Infinity : …` guard
 * (needed for exactly that `0 * Infinity` case) reproduce its numbers instead; the
 * already-computed delay is handed to `backoffDelay` as `rawMs` directly, so the
 * clamp is the only part still borrowed rather than copied.
 */
export function retryDelayMs(
  attemptCount: number,
  baseMs: number = DEFAULTS.baseRetryDelayMs,
  maxMs: number = DEFAULTS.maxRetryDelayMs,
): number {
  const attempt = Math.max(1, attemptCount)
  const exponent = attempt - 1
  const uncapped = exponent >= 32 ? Infinity : baseMs * 2 ** exponent
  return backoffDelay({
    rawMs: uncapped,
    maxMs,
    jitterRatio: 0,
    mode: "symmetric",
    minFloorMs: baseMs > 0 ? 1 : 0,
  })
}

/**
 * Short, stable label recorded on the row so failures are greppable.
 *
 * Falls back to `"Error"` when `name` is not a string, the same rule
 * `integrations/retry.ts`'s `readErrorName` follows: `Error.prototype.name` is a
 * writable property, so nothing stops a caller's `Error` carrying a non-string `name`.
 * The ported original was `error.name || "Error"`, which is truthy — and therefore
 * used as-is — for any non-empty, non-zero `name`, including a number; the value then
 * reached `.slice(0, 64)` and threw `TypeError: name.slice is not a function`, which
 * `drainOnce` never caught (it is thrown by the code inside its own `catch` block), so
 * one such event stopped the whole batch instead of being rescheduled.
 */
export function errorCodeOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error
  }
  const code = typeof error.name === "string" && error.name !== "" ? error.name : "Error"
  return code.slice(0, 64)
}

export class OutboxProcessor {
  readonly #batchSize: number
  readonly #maxAttempts: number
  readonly #baseRetryDelayMs: number
  readonly #maxRetryDelayMs: number
  readonly #leaseSeconds: number
  readonly #now: () => number

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
    this.#now = options.now ?? Date.now
  }

  /**
   * Claims one batch and publishes it. A failing row is rescheduled and never blocks
   * the rest of the batch, so one poisonous event cannot stall the queue.
   *
   * The whole batch shares one lease, so publishing it one event at a time can outlast
   * the lease and let another worker claim the tail. Before each event after the first,
   * this stops once the time since the claim began plus the slowest publish seen so far
   * would reach the lease, and hands the untried events back (see `leaseSeconds`).
   * Timing starts before the claim, so it overestimates the lease already used.
   */
  async drainOnce(): Promise<DrainResult> {
    const startedAt = this.#now()
    const leaseMs = this.#leaseSeconds * 1000
    const events = await this.repository.claimBatch(
      this.#batchSize,
      this.#maxAttempts,
      this.#leaseSeconds,
    )
    let published = 0
    let failed = 0
    let slowestMs = 0

    for (const [index, event] of events.entries()) {
      const eventStartedAt = this.#now()
      if (index > 0 && eventStartedAt - startedAt + slowestMs >= leaseMs) {
        await this.repository.release?.(events.slice(index))
        break
      }
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
      slowestMs = Math.max(slowestMs, this.#now() - eventStartedAt)
    }

    return { claimed: events.length, published, failed }
  }

  /**
   * Drains until aborted, waiting `idleDelayMs` only when a drain came back empty so a
   * backlog is worked through without pausing between batches.
   *
   * A failure in `repository.claimBatch`, `scheduleRetry` or `release` rejects this call and ends
   * the loop, unchanged from the ported original; the caller must restart `run()` —
   * it does not retry itself. A failing `markProcessed` is different: it sits inside
   * `drainOnce`'s own `try`, so it is handled like a failing `publisher.publish` — the
   * row is rescheduled rather than the loop stopping, which means an event that was
   * already published can be delivered again once the retry runs.
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
