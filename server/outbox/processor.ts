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
 * Issue #71 lists this doubling-and-capping formula as one of the retry helpers
 * duplicated across the codebase, so the final clamp to `[0, maxMs]` delegates to
 * `@ts-libs/integrations`'s `createExponentialBackoff` (with `jitterRatio: 0`, since
 * only one worker holds a claimed row at a time via its lease, so there is nothing to
 * de-synchronise). The uncapped delay is still computed exactly as the ported
 * original computed it, because a first review round found that a direct call —
 * `createExponentialBackoff(...)  (attemptCount)` — quietly changed the source's own
 * numbers: `attemptCount` fed straight into `createExponentialBackoff`'s `2 **
 * (attempt - 1)` gives half the source's delay at `attemptCount === 0` (`baseMs / 2`
 * instead of `baseMs`), a shorter delay for a negative or fractional `attemptCount`,
 * and — with `baseMs === 0` — `0` instead of `maxMs` for a large attempt count, or
 * `NaN` once the exponent overflowed to `Infinity` (`0 * Infinity`). `Math.max(1,
 * attemptCount)` and the ported original's own `exponent >= 32 ? Infinity : …` guard
 * (needed for exactly that `0 * Infinity` case) reproduce its numbers instead;
 * `createExponentialBackoff`'s `retryAfterMs` parameter — meant for a provider's
 * `Retry-After` header — is repurposed to hand it that already-computed delay, so the
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
  return createExponentialBackoff({ baseDelayMs: baseMs, maxDelayMs: maxMs, jitterRatio: 0 })(
    attempt,
    uncapped,
  )
}

/**
 * Short, stable label recorded on the row so failures are greppable.
 *
 * Falls back to `"Error"` when `name` is not a string, the same rule
 * `integrations/retry.ts`'s `readErrorName` follows: `Error.prototype.name` is a
 * writable property, so nothing stops a caller's `Error` carrying a non-string `name`.
 * The ported original was `error.name || "Error"`, which is truthy — and therefore
 * used as-is — for any non-empty, non-zero `name`, including a number; the value then
 * reached `.slice(64)` and threw `TypeError: name.slice is not a function`, which
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
   *
   * A failure in `repository.claimBatch`, `markProcessed` or `scheduleRetry` itself
   * (a database blip, unlike a failing `publisher.publish`, which `drainOnce` already
   * catches and reschedules) rejects this call and ends the loop — unchanged from the
   * ported original. The caller must restart `run()` after such a rejection; it does
   * not retry itself.
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
