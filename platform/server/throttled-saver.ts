/**
 * Throttled atomic JSON saver.
 *
 * A long-running job marks state dirty on every item; the saver coalesces those marks and writes
 * the whole document at most once per window, so a 10k-item run performs tens of writes instead of
 * thousands. Every write is atomic (temp + rename) and every flush reports whether it actually
 * wrote, which is what makes the throttling assertable against a fake clock.
 *
 * Clock and timers are injected because a real `setTimeout` would make the tests depend on wall
 * time.
 *
 * @module
 */

import { atomicWriteJson, type TempPathOptions } from "./atomic-json.ts"
import { DEFAULT_FLUSH_INTERVAL_MS } from "../universal/constants.ts"
import type { FileSystemPort } from "./ports.ts"
import type { Clock } from "../universal/time.ts"

/** Scheduling primitives a {@link ThrottledJsonSaver} needs. */
export interface TimerPort {
  /** Run `fn` after `ms`. Returns a handle accepted by {@link TimerPort.clear}. */
  set(fn: () => void, ms: number): number
  clear(handle: number): void
}

/** Real timers. */
export const systemTimerPort: TimerPort = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (handle) => clearTimeout(handle),
}

/** Options for {@link ThrottledJsonSaver}. */
export interface ThrottledJsonSaverOptions {
  fs: FileSystemPort
  /** Document path. */
  path: string
  /** Renders the current state. Called on rotation, never per mark. */
  serialize: () => unknown
  /** Sequence source for temp paths. Defaults to a monotonic counter. */
  nextSequence?: () => number
  /** Process id for temp paths. Defaults to `Deno.pid`. */
  pid?: number
  clock?: Clock
  timers?: TimerPort
  /** Minimum milliseconds between writes. Defaults to 2000. */
  flushIntervalMs?: number
  /** Flush immediately once this many marks accumulate. Defaults to 25. */
  flushBatchSize?: number
  /** Indentation for `JSON.stringify`. */
  space?: number
  /**
   * Called when a timer-driven flush rejects, so it cannot become an unhandled rejection. An error
   * this handler throws is rethrown as an uncaught error.
   */
  onFlushError?: (error: unknown) => void
}

/**
 * Coalescing writer for one JSON document.
 *
 * {@link markDirty} never throws and never returns a promise: when a write is due it writes
 * inline, otherwise it arms a timer for the end of the window. {@link flush} is the deterministic
 * exit point — a caller finishing a run must `await saver.flush()` so the last marks are not lost.
 */
export class ThrottledJsonSaver {
  readonly #fs: FileSystemPort
  readonly #path: string
  readonly #serialize: () => unknown
  readonly #clock: Clock
  readonly #timers: TimerPort
  readonly #onFlushError: (error: unknown) => void
  readonly #pid: number
  readonly #nextSequence: (() => number) | null
  readonly #space: number
  readonly #flushIntervalMs: number
  readonly #flushBatchSize: number

  /** Bumped by every mark. The state is dirty until a write of the newest mark has landed. */
  #marked = 0
  /** The mark count captured by the newest write that reached disk. */
  #saved = 0
  #batchCount = 0
  #lastWriteAt = 0
  #timer: number | null = null
  #writes = 0
  #sequence = 0
  /**
   * Settles when the write currently in flight has finished, whether it came from a mark, the timer
   * or `flush`. Only one write runs at a time: two concurrent writes could land in either order and
   * leave the older snapshot on disk.
   */
  #inFlight: Promise<void> | null = null
  /** A write was due while another was in flight; run one more when it finishes. */
  #followUp = false

  constructor(options: ThrottledJsonSaverOptions) {
    this.#fs = options.fs
    this.#path = options.path
    this.#serialize = options.serialize
    this.#clock = options.clock ?? { now: () => Date.now() }
    this.#timers = options.timers ?? systemTimerPort
    this.#onFlushError = options.onFlushError ?? (() => {})
    this.#pid = options.pid ?? Deno.pid
    this.#nextSequence = options.nextSequence ?? null
    this.#space = options.space ?? 2
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.#flushBatchSize = options.flushBatchSize ?? 25
    // No write has happened yet, so the window opens at construction rather than at epoch 0 —
    // otherwise the first mark would always look overdue.
    this.#lastWriteAt = this.#clock.now()
  }

  /** Number of completed writes. The throttling assertion hook. */
  get writes(): number {
    return this.#writes
  }

  /** Whether a change has been marked that is not yet on disk. Stays true while its write runs. */
  get dirty(): boolean {
    return this.#marked !== this.#saved
  }

  /**
   * Record a change. Writes inline when the batch size or the window is reached. When a write is
   * already in flight, one follow-up write of the newest state runs as soon as it finishes.
   */
  markDirty(): void {
    this.#marked++
    this.#batchCount++
    const now = this.#clock.now()
    if (
      this.#batchCount >= this.#flushBatchSize ||
      now - this.#lastWriteAt >= this.#flushIntervalMs
    ) {
      this.#writeDetached()
      return
    }
    if (this.#timer !== null) return
    this.#timer = this.#timers.set(() => {
      this.#timer = null
      if (!this.dirty) return
      this.#writeDetached()
    }, this.#flushIntervalMs - (now - this.#lastWriteAt))
  }

  /**
   * Write now when anything is pending, and cancel any timer.
   *
   * A detached write, and the follow-up it schedules, may already be in flight; `flush` waits for
   * them only until the marks made before the call are on disk, so its postcondition is "whatever
   * was marked before this call is on disk" rather than "a write was started". A caller finishing
   * a run can therefore `await saver.flush()` exactly once.
   *
   * A timer-driven failure is reported through `onFlushError` — there is no caller to reject. An
   * explicit `flush()` rejects, because the caller is waiting and must know the state was not
   * saved.
   *
   * @returns whether a write happened during this call.
   */
  async flush(): Promise<boolean> {
    this.#cancelTimer()
    // Only the marks made before this call count. Waiting for later ones too would never end while
    // a producer keeps marking during slow writes.
    const target = this.#marked
    // Loop: a finished write may have started a follow-up, and another `flush` may have started its
    // own write while this one waited. A failure of an earlier write has already been reported;
    // this call reports on its own work.
    while (this.#inFlight && this.#saved < target) await this.#inFlight
    if (this.#saved >= target) return false
    const write = this.#write()
    this.#track(write)
    return await write
  }

  /** Cancel a pending timer and any follow-up write without writing. Marks stay dirty. */
  dispose(): void {
    this.#cancelTimer()
    this.#followUp = false
  }

  #cancelTimer(): void {
    if (this.#timer === null) return
    this.#timers.clear(this.#timer)
    this.#timer = null
  }

  #writeDetached(): void {
    this.#cancelTimer()
    if (this.#inFlight) {
      this.#followUp = true
      return
    }
    this.#track(this.#write().catch((error) => this.#reportFlushError(error)))
  }

  /**
   * Hand a detached write's failure to `onFlushError`. A handler that throws is rethrown outside
   * the write chain, so it surfaces as an uncaught error instead of disappearing into it.
   */
  #reportFlushError(error: unknown): void {
    try {
      this.#onFlushError(error)
    } catch (handlerError) {
      queueMicrotask(() => {
        throw handlerError
      })
    }
  }

  /** Record `write` as the one in flight, and start the follow-up a mark asked for once it ends. */
  #track(write: Promise<unknown>): void {
    const settled: Promise<void> = write.then(noop, noop).then(() => {
      if (this.#inFlight !== settled) return
      this.#inFlight = null
      if (!this.#followUp) return
      this.#followUp = false
      if (this.dirty) this.#writeDetached()
    })
    this.#inFlight = settled
  }

  async #write(): Promise<boolean> {
    const options: TempPathOptions = {
      pid: this.#pid,
      sequence: this.#nextSequence ? this.#nextSequence() : this.#sequence++,
    }
    // Capture the mark count with the snapshot: a mark landing while the write is in flight is
    // newer than this snapshot, so it keeps the saver dirty after the write lands.
    const snapshot = this.#serialize()
    const covers = this.#marked
    const markedDuringWindow = this.#batchCount
    this.#batchCount = 0
    try {
      await atomicWriteJson(this.#fs, this.#path, snapshot, options, this.#space)
    } catch (error) {
      // The write failed, so the state on disk is still the OLD document and `#saved` is unchanged:
      // the saver stays dirty, so a caller's `flush()` still writes the change.
      this.#batchCount += markedDuringWindow
      throw error
    }
    this.#saved = covers
    this.#lastWriteAt = this.#clock.now()
    this.#writes++
    return true
  }
}

function noop(): void {}
