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
  /**
   * Marks the event done. With `repeatInSeconds`, also writes the event's next run, that many
   * seconds from now, in the same atomic step, so a crash can leave neither no next run nor two.
   */
  markProcessed(id: string, repeatInSeconds?: number): Promise<void>
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
  /**
   * Gives an unprocessed event up for good: closes it (the same mark `markProcessed` sets, so no
   * claim, `release` or `findLost` ever returns it again) and stores `errorCode` on it. A closed
   * event with an error code is one that was given up; `markProcessed` clears the code.
   *
   * With `repeatInSeconds`, also writes the event's next run, that many seconds from now, in the
   * same atomic step, unless another unprocessed event of the same kind and aggregate already
   * waits. Closing and a repeating `markProcessed` must exclude each other on the row, so that a
   * worker that outlived its lease and then succeeds writes no second next run.
   *
   * Resolves to `true` when this call closed the event, and to `false` when it was already
   * processed or given up; then it changes nothing.
   *
   * Optional, and called only by a processor with `onAttemptFailed` or `repeatAfterGiveUp`. Without
   * it the processor ends a last attempt with `scheduleRetry`, as it always has.
   */
  giveUp?(id: string, errorCode: string, repeatInSeconds?: number): Promise<boolean>
  /**
   * Returns up to `limit` unprocessed events that used up `maxAttempts` and whose last claim ran
   * out at least one more lease length ago, with the error code stored on each: nobody reported
   * an outcome for their last attempt. Read-only; the processor gives each one up, and that is
   * what stops it from being returned again.
   *
   * Optional, and used only together with `giveUp`. Without the pair, a processor never learns of
   * such an event.
   */
  findLost?(maxAttempts: number, limit: number): Promise<LostOutboxEvent[]>
}

/** An event {@link OutboxRepository.findLost} returns. */
export interface LostOutboxEvent extends OutboxEvent {
  /** The error name an earlier failed attempt stored on the row, or `null`. */
  lastErrorCode: string | null
}

/**
 * Where an attempt failed. `publish`: the publisher threw. `markProcessed`: the publisher
 * succeeded and writing the "processed" mark threw, so the event is delivered again on the next
 * attempt. `lease`: nobody reported an outcome for the event's last attempt, even one whole lease
 * length after its lease ran out.
 */
export type OutboxFailureStage = "publish" | "markProcessed" | "lease"

/** One failed attempt, as `OutboxProcessorOptions.onAttemptFailed` gets it. */
export interface OutboxAttemptFailure {
  event: OutboxEvent
  /**
   * What the publisher or `markProcessed` threw. For the `lease` stage, an
   * {@link OutboxLeaseExpiredError}.
   */
  error: unknown
  /** The attempt that failed, counted from 1: the event's `attemptCount`. */
  attempt: number
  /** The processor's `maxAttempts`. */
  maxAttempts: number
  /**
   * `true` when the event is now given up. With a repository that has `giveUp`, the event is then
   * closed, no attempt ever starts on it again, and it is reported once, by the worker that
   * closed it.
   */
  lastAttempt: boolean
  stage: OutboxFailureStage
  /**
   * Only for the `lease` stage: the error name an earlier failed attempt had stored on the row, or
   * `null` when none was stored. The row keeps that name; `OutboxLeaseExpired` is stored only on
   * a row that had none.
   */
  storedErrorCode?: string | null
}

/**
 * The `error` of a failure in the `lease` stage: the event's last attempt ended with no outcome
 * reported. Its `name`, `OutboxLeaseExpired`, is stored as the error code of a row that had none.
 */
export class OutboxLeaseExpiredError extends Error {
  override name = "OutboxLeaseExpired"
  constructor() {
    super("the last attempt ended with no outcome: its worker died or outlived its lease")
  }
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
   *
   * That check predicts the next publish from the slowest one so far in the batch, so
   * it is a heuristic, not a guarantee. A publish slower than every earlier one in the
   * batch, started close to the end of the lease, can still run past it and be
   * delivered twice, even when it is much shorter than the lease. A longer lease alone
   * does not close this window, because the check stops at the same margin before the
   * end of any lease. Two things close it: the whole batch fitting in the lease (that
   * is, `leaseSeconds` exceeding `batchSize` times the slowest expected publish), or
   * `slowestPublishMs`.
   *
   * The rule, with `slowestPublishMs` set: a publish no slower than `slowestPublishMs`
   * is never delivered twice because of the lease. Three things fall outside it: a
   * worker that crashes mid-publish (its lease still expires and the event is
   * delivered again), a publish that takes longer than `slowestPublishMs`, and the
   * first event of a batch. That event is always tried, so the rule also assumes the
   * claim returns within the lease minus `slowestPublishMs`.
   */
  leaseSeconds?: number
  /**
   * The slowest single publish the caller expects, in milliseconds. Optional; without
   * it the drain's behaviour is unchanged.
   *
   * It is a floor for the prediction in `leaseSeconds`: `drainOnce` stops before an
   * event when the time used so far plus the larger of this value and the slowest
   * publish observed in the batch would reach the lease. So a publish no slower than
   * this value is never delivered twice because of the lease, whatever order the
   * publish times come in. The rule does not cover a worker that crashes mid-publish, a
   * publish slower than this value, or the first event of a batch: that event is always
   * tried, so the rule also assumes the claim returns within the lease minus this value.
   * A higher value stops batches earlier, so it needs a lease long enough to fit
   * several publishes of that length or a batch makes little progress.
   *
   * The value must cover the publish plus marking the row processed: the row stays
   * claimable until that commits, and the observed slowest time already includes
   * `markProcessed`.
   *
   * Must be a finite number of at least 0 and, when given, below `leaseSeconds * 1000`;
   * anything else throws a `RangeError` at construction.
   */
  slowestPublishMs?: number
  /**
   * Event kinds that repeat, each with its interval in milliseconds. After such an event is
   * published, the repository writes the same event again to run one interval later, so a nightly
   * job is one row that reschedules itself. A run that fails keeps its own retry schedule and
   * reschedules only once it succeeds; one that fails until `maxAttempts` ends the chain, with its
   * error stored, unless `repeatAfterGiveUp` is set. Use {@link ensureScheduledOutboxEvent} at
   * start-up to begin a chain.
   */
  repeatEveryMs?: Readonly<Record<string, number>>
  /**
   * Keeps a repeating event's chain alive when a run is given up. Off by default: the chain ends,
   * as described under `repeatEveryMs`. With `true`, giving up an event whose kind is in
   * `repeatEveryMs` also writes its next run one interval later, in the same atomic step, whether
   * the last attempt failed in this processor or was lost with its worker. One bad night then
   * costs one run. The given-up event is closed with its error code kept, as described under
   * `onAttemptFailed`.
   *
   * Exactly one next run is written, whatever happens around it: a worker that outlived its lease
   * and succeeds after its event was given up writes none, and no next run is written while
   * another unprocessed event of the same kind and aggregate waits.
   *
   * Needs a repository with `giveUp` and `findLost`, such as `PostgresOutboxRepository`; any other
   * throws a `TypeError` at construction.
   */
  repeatAfterGiveUp?: boolean
  /**
   * Told every failed attempt, and every event that is given up: see {@link OutboxAttemptFailure}.
   * Meant for a log line or an alert. Absent by default, and then the processor behaves exactly as
   * it did before this option existed.
   *
   * It is called, never awaited: a callback that is slow or never settles holds nothing up, and
   * the retry is written without waiting for it. Whatever it throws or rejects with is written to
   * `console.error` and otherwise ignored.
   *
   * With a repository that has `giveUp` and `findLost`, such as `PostgresOutboxRepository`, this
   * option (and `repeatAfterGiveUp`) changes what giving up does to the row. Without it, a
   * given-up row stays unprocessed for good. With it, the row is closed: `processed_at` is set
   * and its error code stays, so it is never claimed again, even after `maxAttempts` is raised,
   * and `ensureScheduledOutboxEvent` no longer counts it as waiting.
   *
   * Each drain also looks for events whose last attempt was lost: out of attempts, with nobody
   * having reported an outcome one whole lease length after the lease ran out. Each is given up
   * and then reported once, with stage `lease`. Three things to know about that stage:
   *
   * - The library cannot tell a dead worker from one that is alive and more than twice its lease
   *   late. For such a worker, the publish it is in may still complete after the report; a
   *   failure of it is not reported a second time. No attempt starts after the report: an event
   *   the slow worker had claimed in the same batch and not started yet is given up untried, and
   *   its `release` leaves it closed.
   * - A row given up earlier by a processor without this option (every row given up before the
   *   option was set) is reported the same way on the first drain, although its last attempt
   *   failed and was not lost. `storedErrorCode` carries the error name that attempt stored, and
   *   the row keeps it.
   * - The row is closed before the callback is called, so that two workers never both report it. A
   *   process that dies between the two never reports that row; it stays closed with its error
   *   code.
   */
  onAttemptFailed?: (failure: OutboxAttemptFailure) => void | Promise<void>
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
 * An `attemptCount` below 1 counts as 1, and an exponent of 32 or more is treated as an infinite
 * delay, so `baseMs === 0` never computes `0 * Infinity`. The clamp to `[0, maxMs]` is
 * `backoffDelay` from `@spy4x/platform/universal/async`, with no jitter: only the worker holding
 * the row's lease retries it, so there is nothing to de-synchronise.
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
  readonly #repeatEveryMs: Readonly<Record<string, number>>
  readonly #slowestPublishMs: number
  readonly #onAttemptFailed: OutboxProcessorOptions["onAttemptFailed"]
  readonly #repeatAfterGiveUp: boolean
  /** Whether a last attempt ends with `giveUp` instead of `scheduleRetry`. */
  readonly #givesUp: boolean
  /** Whether each drain looks for events whose last attempt was lost. */
  readonly #findsLost: boolean

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
    this.#repeatEveryMs = options.repeatEveryMs ?? {}
    for (const [kind, ms] of Object.entries(this.#repeatEveryMs)) {
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new RangeError(`repeatEveryMs for ${kind} must be a finite number above 0, got ${ms}`)
      }
    }
    const floor = options.slowestPublishMs ?? 0
    if (!Number.isFinite(floor) || floor < 0) {
      throw new RangeError(
        `slowestPublishMs must be a finite number of at least 0, got ${floor}`,
      )
    }
    if (options.slowestPublishMs !== undefined && floor >= this.#leaseSeconds * 1000) {
      throw new RangeError(
        `slowestPublishMs (${floor}) must be below the lease of ${this.#leaseSeconds * 1000} ms`,
      )
    }
    this.#slowestPublishMs = floor
    this.#onAttemptFailed = options.onAttemptFailed
    this.#repeatAfterGiveUp = options.repeatAfterGiveUp === true
    const tracks = this.#onAttemptFailed !== undefined || this.#repeatAfterGiveUp
    this.#givesUp = tracks && typeof repository.giveUp === "function"
    this.#findsLost = this.#givesUp && typeof repository.findLost === "function"
    if (this.#repeatAfterGiveUp && !this.#findsLost) {
      throw new TypeError("repeatAfterGiveUp needs a repository with giveUp and findLost")
    }
  }

  /**
   * Claims one batch and publishes it. A failing row is rescheduled and never blocks
   * the rest of the batch, so one poisonous event cannot stall the queue.
   *
   * The whole batch shares one lease, so publishing it one event at a time can outlast
   * the lease and let another worker claim the tail. Before each event after the first,
   * this stops once the time since the claim began plus the slowest publish seen so far
   * (or `slowestPublishMs`, when larger) would reach the lease, and hands the untried
   * events back (see `leaseSeconds`).
   * Timing starts before the claim, so it overestimates the lease already used. The
   * next publish is predicted from the slowest one so far, so an unusually slow publish
   * started near the end of the lease can still be delivered twice, without
   * `slowestPublishMs` or when it is slower than that value.
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
    let slowestMs = this.#slowestPublishMs

    for (const [index, event] of events.entries()) {
      const eventStartedAt = this.#now()
      if (index > 0 && eventStartedAt - startedAt + slowestMs >= leaseMs) {
        await this.repository.release?.(events.slice(index))
        break
      }
      let stage: OutboxFailureStage = "publish"
      try {
        await this.publisher.publish(event)
        stage = "markProcessed"
        const repeatMs = this.#repeatEveryMs[event.eventKind]
        if (repeatMs === undefined) await this.repository.markProcessed(event.id)
        else await this.repository.markProcessed(event.id, repeatMs / 1000)
        published++
      } catch (error) {
        failed++
        const lastAttempt = event.attemptCount >= this.#maxAttempts
        if (lastAttempt && this.#givesUp) {
          // Closing comes first and decides who reports: `false` means another worker found this
          // attempt lost, gave the event up and reported it while this publish was still running.
          if (await this.#giveUp(event, errorCodeOf(error))) this.#report(event, error, stage)
        } else {
          this.#report(event, error, stage)
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
      slowestMs = Math.max(slowestMs, this.#now() - eventStartedAt)
    }

    if (this.#findsLost) {
      const error = new OutboxLeaseExpiredError()
      const lost = await this.repository.findLost!(this.#maxAttempts, this.#batchSize)
      for (const { lastErrorCode, ...event } of lost) {
        // The row keeps the error name a failed attempt stored. `false`: another worker gave it
        // up between the search and here, and reported it.
        const closed = await this.#giveUp(event, lastErrorCode ?? errorCodeOf(error))
        if (closed) this.#report(event, error, "lease", lastErrorCode)
      }
    }

    return { claimed: events.length, published, failed }
  }

  /** Gives the event up and, for a repeating kind with `repeatAfterGiveUp`, writes its next run. */
  async #giveUp(event: OutboxEvent, errorCode: string): Promise<boolean> {
    const repeatMs = this.#repeatAfterGiveUp ? this.#repeatEveryMs[event.eventKind] : undefined
    if (repeatMs === undefined) return await this.repository.giveUp!(event.id, errorCode)
    return await this.repository.giveUp!(event.id, errorCode, repeatMs / 1000)
  }

  /**
   * Tells `onAttemptFailed` without waiting for it, and keeps whatever it throws or rejects with
   * away from the drain.
   */
  #report(
    event: OutboxEvent,
    error: unknown,
    stage: OutboxFailureStage,
    storedErrorCode?: string | null,
  ): void {
    if (this.#onAttemptFailed === undefined) return
    const failure: OutboxAttemptFailure = {
      event,
      error,
      attempt: event.attemptCount,
      maxAttempts: this.#maxAttempts,
      lastAttempt: event.attemptCount >= this.#maxAttempts,
      stage,
    }
    if (stage === "lease") failure.storedErrorCode = storedErrorCode ?? null
    const log = (thrown: unknown) => console.error("outbox: onAttemptFailed threw", thrown)
    try {
      Promise.resolve(this.#onAttemptFailed(failure)).catch(log)
    } catch (thrown) {
      log(thrown)
    }
  }

  /**
   * Drains until aborted, waiting `idleDelayMs` only when a drain came back empty so a
   * backlog is worked through without pausing between batches.
   *
   * A failure in `repository.claimBatch`, `scheduleRetry`, `release`, `giveUp` or `findLost`
   * rejects this call and ends the loop; the caller must restart `run()` — it does not retry
   * itself. A failing `markProcessed` is different: it sits inside
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
