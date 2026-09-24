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
import type { ClockPort, FileSystemPort } from "./ports.ts"

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
  clock?: ClockPort
  timers?: TimerPort
  /** Minimum milliseconds between writes. Defaults to 2000. */
  flushIntervalMs?: number
  /** Flush immediately once this many marks accumulate. Defaults to 25. */
  flushBatchSize?: number
  /** Indentation for `JSON.stringify`. */
  space?: number
  /** Called when a timer-driven flush rejects, so it cannot become an unhandled rejection. */
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
  readonly #clock: ClockPort
  readonly #timers: TimerPort
  readonly #onFlushError: (error: unknown) => void
  readonly #pid: number
  readonly #nextSequence: (() => number) | null
  readonly #space: number
  readonly #flushIntervalMs: number
  readonly #flushBatchSize: number

  #dirty = false
  #batchCount = 0
  #lastWriteAt = 0
  #timer: number | null = null
  #writes = 0
  #sequence = 0
  /** The detached write currently in flight, so `flush` can wait for it. */
  #inFlight: Promise<boolean> | null = null

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

  /** Whether a write is due but not yet performed. */
  get dirty(): boolean {
    return this.#dirty
  }

  /** Record a change. Writes inline when the batch size or the window is reached. */
  markDirty(): void {
    this.#dirty = true
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
      if (!this.#dirty) return
      this.#writeDetached()
    }, this.#flushIntervalMs - (now - this.#lastWriteAt))
  }

  /**
   * Write now when anything is pending, and cancel any timer.
   *
   * A detached write may already be in flight; `flush` waits for it before deciding, so its
   * postcondition is "whatever was marked before this call is on disk" rather than "a write was
   * started". A caller finishing a run can therefore `await saver.flush()` exactly once.
   *
   * A timer-driven failure is reported through `onFlushError` — there is no caller to reject. An
   * explicit `flush()` rejects, because the caller is waiting and must know the state was not
   * saved.
   *
   * @returns whether a write happened during this call.
   */
  async flush(): Promise<boolean> {
    this.#cancelTimer()
    const pending = this.#inFlight
    if (pending) {
      // A failure of the earlier write has already been reported; this call reports on its own work.
      await pending.catch(() => {})
    }
    if (!this.#dirty) return false
    return await this.#write()
  }

  /** Cancel a pending timer without writing. Marks stay dirty. */
  dispose(): void {
    this.#cancelTimer()
  }

  #cancelTimer(): void {
    if (this.#timer === null) return
    this.#timers.clear(this.#timer)
    this.#timer = null
  }

  #writeDetached(): void {
    this.#cancelTimer()
    const pending = this.#write()
      .catch((error) => {
        this.#onFlushError(error)
        return false
      })
      .finally(() => {
        if (this.#inFlight === pending) this.#inFlight = null
      })
    this.#inFlight = pending
  }

  async #write(): Promise<boolean> {
    const options: TempPathOptions = {
      pid: this.#pid,
      sequence: this.#nextSequence ? this.#nextSequence() : this.#sequence++,
    }
    // Snapshot and clear state before the await: a mark landing while the write is in flight must
    // re-arm the timer against the post-write baseline rather than be swallowed by this write.
    const snapshot = this.#serialize()
    const wasDirty = this.#dirty
    const markedDuringWindow = this.#batchCount
    this.#dirty = false
    this.#batchCount = 0
    try {
      await atomicWriteJson(this.#fs, this.#path, snapshot, options, this.#space)
    } catch (error) {
      // The write failed, so the state on disk is still the OLD document. Restoring `dirty` is what
      // stops a failed write from silently discarding the mark: without it a caller's `flush()`
      // would report "nothing to do" and the change would never reach disk.
      this.#dirty = wasDirty
      this.#batchCount = markedDuringWindow
      throw error
    }
    this.#lastWriteAt = this.#clock.now()
    this.#writes++
    return true
  }
}
