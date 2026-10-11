import type { OutboxEvent, OutboxPublisher } from "./processor.ts"

/** What runs when a job's time has come. `event.aggregateId` names what the job is about. */
export type JobHandler = (event: OutboxEvent) => Promise<void>

/** Options of {@link JobPublisher}. */
export interface JobPublisherOptions {
  /** The `aggregateType` of the outbox rows that are jobs, for example `job`. */
  aggregateType: string
  /** One handler per job, keyed by the row's `eventKind`, for example `outbox.cleanup`. */
  handlers: Readonly<Record<string, JobHandler>>
  /** Gets every row that is not a job, such as the publisher that announces changes. */
  fallback: OutboxPublisher
}

/**
 * An {@link OutboxPublisher} for an outbox that holds two kinds of rows: jobs (the delayed and
 * repeating rows `scheduleOutboxEvent` writes) and everything else. A row whose `aggregateType`
 * is the job type goes to the handler of its `eventKind`; any other row goes to `fallback`.
 *
 * A job with no handler throws a `RangeError`, so the processor retries it and then stops with
 * the error stored on the row. It never goes to `fallback` and never vanishes: a job nobody
 * handles is a deploy that forgot a handler, and that should be visible.
 *
 * ```ts
 * const publisher = new JobPublisher({
 *   aggregateType: "job",
 *   handlers: { "outbox.cleanup": () => removeOldRows(sql) },
 *   fallback: changeNotifier,
 * })
 * new OutboxProcessor(repository, publisher, { repeatEveryMs: { "outbox.cleanup": 86_400_000 } })
 * ```
 *
 * @throws TypeError from the constructor when a handler is not a function.
 */
export class JobPublisher implements OutboxPublisher {
  readonly #aggregateType: string
  readonly #handlers: Map<string, JobHandler>
  readonly #fallback: OutboxPublisher

  constructor(options: JobPublisherOptions) {
    this.#aggregateType = options.aggregateType
    this.#fallback = options.fallback
    // A map of the object's own keys: a lookup on the object itself would find `toString` and
    // the rest of `Object.prototype` for a row whose kind happens to be such a name.
    this.#handlers = new Map(Object.entries(options.handlers))
    for (const [kind, handler] of this.#handlers) {
      if (typeof handler !== "function") {
        throw new TypeError(`the handler of job ${kind} is not a function`)
      }
    }
  }

  async publish(event: OutboxEvent): Promise<void> {
    if (event.aggregateType !== this.#aggregateType) return await this.#fallback.publish(event)
    const handler = this.#handlers.get(event.eventKind)
    if (!handler) throw new RangeError(`no handler for job ${event.eventKind}`)
    await handler(event)
  }
}
