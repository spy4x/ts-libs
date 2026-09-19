/**
 * A job-id keyed SSE progress broker.
 *
 * Extracted from the `MovieProgress` singleton in
 * `roley/src/lib/server/video-processing/helpers.ts:133-192`, which used a
 * `Map<number, { controllers, latestValue }>` and `ReadableStreamDefaultController`s
 * to fan progress out to connected browsers. Nothing here knows what a movie,
 * a clip or ffmpeg is: the payload is the caller's `Payload`, the job id is any
 * string or number, and the module's imports are the timer port and nothing
 * else. That is what the extraction issue asked for when it called the broker
 * "a reusable pattern independent of video".
 *
 * Behaviour, and where it differs from the source:
 *
 * - Subscribing replays the job's last payload, so a late subscriber renders
 *   immediately instead of showing 0% until the next tick (source behaviour).
 * - A subscriber is removed when its stream is cancelled, when its
 *   `AbortSignal` aborts, or when an enqueue finds the stream already closed.
 *   The source had the abort listener commented out
 *   (`helpers.ts:153-155`) and leaked a dead controller per dropped connection.
 * - `timeoutMs` closes a subscription that saw no completion, instead of
 *   holding the connection open forever.
 * - A job with no subscribers is forgotten, which bounds the map. The source
 *   did the same (`helpers.ts:176-179`).
 */

import { formatSseFrame } from "./sse-frame.ts"
import { systemTimers, type Timers } from "./timers.ts"

/** Any string or number a caller uses to name a job. */
export type ProgressJobId = string | number

/** Per-subscription wiring. */
export interface ProgressSubscribeOptions {
  /** Unsubscribes (and closes the stream) when aborted. */
  signal?: AbortSignal
  /**
   * Closes the subscription with an `error` event after this many milliseconds.
   *
   * A subscriber that joins a job which never reports, or that is abandoned by
   * a crashed producer, would otherwise hold a socket open until the client
   * gives up. `0` and negative values mean no deadline.
   */
  timeoutMs?: number
  /** Replay the job's last published payload on subscribe. Defaults to `true`. */
  replayLatest?: boolean
  /** SSE event name to use when replaying. Defaults to the job's last event name. */
  event?: string
}

/** Publishing wiring. */
export interface ProgressPublishOptions {
  /** SSE event name; defaults to `"progress"` or the job's previous name. */
  event?: string
}

/** Constructor wiring. */
export interface SseProgressBrokerOptions {
  /** Timer port; defaults to `systemTimers`. */
  timers?: Timers
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
  timeoutHandle: number | null
  signal: AbortSignal | null
  onAbort: (() => void) | null
}

interface JobEntry<Payload> {
  subscribers: Set<Subscriber>
  latest: { payload: Payload; event: string } | null
  event: string
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close()
  } catch {
    // Already closed or cancelled by the client; closing twice is not an error.
  }
}

function enqueueQuietly(
  controller: ReadableStreamDefaultController<Uint8Array>,
  bytes: Uint8Array,
): boolean {
  try {
    controller.enqueue(bytes)
    return true
  } catch {
    // The stream is closed or cancelled — the subscriber is gone.
    return false
  }
}

/**
 * Fans progress events out to per-job SSE subscribers.
 *
 * ```ts
 * const broker = new SseProgressBroker<{ percent: number }>()
 * const stream = broker.subscribe(jobId, { signal: request.signal, timeoutMs: 60_000 })
 * broker.publish(jobId, { percent: 50 })
 * broker.complete(jobId)
 * ```
 *
 * Every stream carries `text/event-stream` frames; the caller owns the response
 * headers and the `Content-Type`.
 */
export class SseProgressBroker<Payload = unknown> {
  /** Event name used for payloads published without an explicit one. */
  static readonly DEFAULT_EVENT = "progress"
  /** Event name carrying a failure message. */
  static readonly ERROR_EVENT = "error"
  /** Event name carrying the completion marker. */
  static readonly COMPLETE_EVENT = "complete"

  readonly #jobs = new Map<ProgressJobId, JobEntry<Payload>>()
  readonly #timers: Timers
  readonly #encoder = new TextEncoder()

  constructor(options: SseProgressBrokerOptions = {}) {
    this.#timers = options.timers ?? systemTimers
  }

  /** Number of live subscribers for a job. `0` means nothing is retained. */
  subscriberCount(jobId: ProgressJobId): number {
    return this.#jobs.get(jobId)?.subscribers.size ?? 0
  }

  /** Number of jobs still holding subscribers. */
  get jobCount(): number {
    return this.#jobs.size
  }

  /** Last payload published for a job, if the job is still live. */
  latestOf(jobId: ProgressJobId): Payload | undefined {
    return this.#jobs.get(jobId)?.latest?.payload
  }

  /**
   * Registers a subscriber and returns its `text/event-stream` body.
   *
   * The returned stream stays open until the caller cancels it, the injected
   * signal aborts, `complete`/`fail` runs for the job, or `timeoutMs` expires.
   */
  subscribe(
    jobId: ProgressJobId,
    options: ProgressSubscribeOptions = {},
  ): ReadableStream<Uint8Array> {
    const { signal, timeoutMs, replayLatest = true } = options
    const entry = this.#entryFor(jobId)
    let subscriber: Subscriber | null = null

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const started: Subscriber = {
          controller,
          timeoutHandle: null,
          signal: null,
          onAbort: null,
        }
        subscriber = started
        entry.subscribers.add(started)

        if (replayLatest && entry.latest !== null) {
          enqueueQuietly(
            controller,
            this.#encode({
              event: options.event ?? entry.latest.event,
              data: JSON.stringify(entry.latest.payload) ?? "null",
            }),
          )
        }

        if (timeoutMs !== undefined && timeoutMs > 0) {
          started.timeoutHandle = this.#timers.setTimeout(() => {
            this.#failSubscriber(
              jobId,
              started,
              `progress stream for job ${
                String(jobId)
              } produced no completion within ${timeoutMs} ms`,
            )
          }, timeoutMs)
        }

        if (signal) {
          const onAbort = (): void => {
            this.#removeSubscriber(jobId, started)
            closeQuietly(started.controller)
          }
          started.signal = signal
          started.onAbort = onAbort
          if (signal.aborted) {
            onAbort()
          } else {
            signal.addEventListener("abort", onAbort, { once: true })
          }
        }
      },
      cancel: () => {
        if (subscriber) {
          this.#removeSubscriber(jobId, subscriber)
        }
      },
    })
  }

  /** Sends one payload to every subscriber of a job. A job with none is a no-op. */
  publish(jobId: ProgressJobId, payload: Payload, options: ProgressPublishOptions = {}): void {
    const entry = this.#jobs.get(jobId)
    if (!entry) {
      return
    }
    const event = options.event ?? entry.event
    entry.event = event
    entry.latest = { payload, event }
    const bytes = this.#encode({ event, data: JSON.stringify(payload) ?? "null" })
    for (const subscriber of [...entry.subscribers]) {
      if (!enqueueQuietly(subscriber.controller, bytes)) {
        this.#removeSubscriber(jobId, subscriber)
      }
    }
  }

  /**
   * Closes every subscriber of a job after an optional final payload.
   *
   * The closing subscriber sees a `complete` event and then end-of-stream, so a
   * client can distinguish "finished" from "connection dropped" without
   * reconnecting.
   */
  complete(
    jobId: ProgressJobId,
    options: ProgressPublishOptions & { payload?: Payload } = {},
  ): void {
    const entry = this.#jobs.get(jobId)
    if (!entry) {
      return
    }
    if ("payload" in options) {
      this.publish(jobId, options.payload as Payload, options)
    }
    const frame = this.#encode({
      event: SseProgressBroker.COMPLETE_EVENT,
      data: JSON.stringify({ complete: true }),
    })
    for (const subscriber of [...entry.subscribers]) {
      this.#closeSubscriber(jobId, subscriber, frame)
    }
  }

  /**
   * Fails a job: every subscriber receives an `error` event and the stream ends.
   *
   * The failure is delivered in-band rather than through `controller.error()`,
   * because an errored body is indistinguishable from a dropped connection to
   * an `EventSource` client, which then reconnects to a job that is already
   * dead. A `data` frame plus end-of-stream tells the client to stop.
   */
  fail(jobId: ProgressJobId, error: unknown, options: ProgressPublishOptions = {}): void {
    const entry = this.#jobs.get(jobId)
    if (!entry) {
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const frame = this.#encode({
      event: options.event ?? SseProgressBroker.ERROR_EVENT,
      data: JSON.stringify({ message }),
    })
    for (const subscriber of [...entry.subscribers]) {
      this.#closeSubscriber(jobId, subscriber, frame)
    }
  }

  #entryFor(jobId: ProgressJobId): JobEntry<Payload> {
    const existing = this.#jobs.get(jobId)
    if (existing) {
      return existing
    }
    const created: JobEntry<Payload> = {
      subscribers: new Set(),
      latest: null,
      event: SseProgressBroker.DEFAULT_EVENT,
    }
    this.#jobs.set(jobId, created)
    return created
  }

  #encode(frame: { event: string; data: string }): Uint8Array {
    return this.#encoder.encode(formatSseFrame(frame))
  }

  #closeSubscriber(jobId: ProgressJobId, subscriber: Subscriber, frame: Uint8Array): void {
    enqueueQuietly(subscriber.controller, frame)
    this.#removeSubscriber(jobId, subscriber)
    closeQuietly(subscriber.controller)
  }

  #failSubscriber(jobId: ProgressJobId, subscriber: Subscriber, message: string): void {
    this.#closeSubscriber(
      jobId,
      subscriber,
      this.#encode({
        event: SseProgressBroker.ERROR_EVENT,
        data: JSON.stringify({ message }),
      }),
    )
  }

  #removeSubscriber(jobId: ProgressJobId, subscriber: Subscriber): void {
    if (subscriber.timeoutHandle !== null) {
      this.#timers.clearTimeout(subscriber.timeoutHandle)
      subscriber.timeoutHandle = null
    }
    if (subscriber.signal !== null && subscriber.onAbort !== null) {
      // Detaching matters as much as clearing the timer: a long-lived signal
      // that keeps the listener alive also keeps the controller reachable.
      subscriber.signal.removeEventListener("abort", subscriber.onAbort)
      subscriber.onAbort = null
      subscriber.signal = null
    }
    const entry = this.#jobs.get(jobId)
    if (!entry) {
      return
    }
    entry.subscribers.delete(subscriber)
    if (entry.subscribers.size === 0) {
      this.#jobs.delete(jobId)
    }
  }
}
