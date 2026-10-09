/**
 * Drives a flush of the offline outbox (or any async sync step) at the moments a browser gives a
 * page: when it starts, when the network returns, when the tab becomes visible, when the window
 * gains focus, and whenever the app calls `kick()`. A failed run is retried with growing delays,
 * and the network coming back replaces the wait with an immediate run.
 *
 * It never relies on Background Sync: Safari has none, and a page that is open is the only place
 * every browser lets a queue be sent from. A write queued while the app is closed is sent the next
 * time the app is opened.
 *
 * The rules:
 *
 * - **One run at a time.** A `kick()` during a run schedules exactly one more run after it, however
 *   many kicks arrive; that run starts at once and replaces any retry the finished run asked for.
 * - **Failure retries, success resets.** A flush that throws, or answers `"unreachable"`, is retried
 *   after `backoffDelay` of the number of failures in a row. A flush that completes resets it.
 * - **Any wake-up runs now.** `online`, the tab becoming visible, window focus, a page restored from
 *   the back-forward cache and `kick()` all cancel a pending retry and run at once: the person is
 *   back, and the next try should not wait out a delay chosen while they were away.
 * - **Optional polling.** With `pollIntervalMs` set, a run that completes schedules the next one
 *   that long after it ended, but only while the page is visible and online; a page that is hidden
 *   or offline waits for the wake-up that brings it back. Every run restarts the interval, and a
 *   failing run uses the backoff instead, so polling resumes only after a run completes. Off by
 *   default. `pollIntervalMs` is at most 2 147 483 647 ms, the longest delay a timer keeps.
 * - **`stop()` leaves nothing behind**: every listener removed, the retry and poll timers cleared.
 *   A run in flight finishes, and schedules nothing.
 *
 * Time, the event targets and the random source are ports, so a test needs no real timers.
 *
 * @module
 */

import { backoffDelay } from "@spy4x/platform/universal/async"
import { type Clock, createSystemClock, type TimerHandle } from "./clock.ts"
import { watchPageResume } from "./page-lifecycle.ts"

/**
 * What a flush answers. Nothing (or any value) means it completed; `"unreachable"` means it could
 * not reach the server and must be tried again later. A flush that throws counts as a failure too.
 */
export type SyncFlushResult = "unreachable" | void | undefined

/** The parts of `window` and `document` the runner listens to. The global `window` fits. */
export interface SyncRunnerTarget {
  document: {
    readonly visibilityState: string
    addEventListener(type: "visibilitychange", listener: () => void): void
    removeEventListener(type: "visibilitychange", listener: () => void): void
  }
  addEventListener(type: "online" | "pageshow" | "focus", listener: (event: Event) => void): void
  removeEventListener(type: "online" | "pageshow" | "focus", listener: (event: Event) => void): void
}

/** What a UI may show about the runner. A new object after every change. */
export interface SyncRunnerState {
  /** Whether a flush is in progress. */
  readonly running: boolean
  /** What the last run threw; `null` after a run that completed or could not reach the server. */
  readonly lastError: unknown
  /** Failed runs in a row (thrown or unreachable); `0` after a run that completed. */
  readonly failures: number
  /** When the next retry runs, in the clock's epoch milliseconds; `null` when none is waiting. */
  readonly nextRetryAt: number | null
}

/** Options of {@link createSyncRunner}. */
export interface SyncRunnerOptions {
  /** One sync step, for example `flushOutbox(outbox)`. It must settle. */
  flush(): Promise<SyncFlushResult>
  /** Where the browser events come from. Defaults to the global `window`. */
  target?: SyncRunnerTarget
  /** Timers and time. Defaults to the system clock. */
  clock?: Clock
  /** Uniform source in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. */
  random?: () => number
  /** The first retry's delay before jitter. Doubles per failure in a row. Default 1000. */
  baseDelayMs?: number
  /** The longest retry delay. Default 60 000. */
  maxDelayMs?: number
  /**
   * When set, a visible, online page runs `flush` again this long after the last run ended, with
   * no event. A positive, finite number of milliseconds, at most 2 147 483 647 (about 24.8 days; timers
   * cannot wait longer). Default: no polling.
   */
  pollIntervalMs?: number
  /** Whether the network is up. Defaults to `navigator.onLine`, or `true` without `navigator`. */
  isOnline?: () => boolean
}

/** The runner as the app uses it. */
export interface SyncRunner {
  /** Starts listening and runs once. Does nothing when already started. */
  start(): void
  /** Stops listening and cancels the retry. The run in progress finishes. */
  stop(): void
  /**
   * Runs now, or once more right after the run in progress. Resolves when that run has finished;
   * resolves at once when the runner is not started.
   */
  kick(): Promise<void>
  /** The state as of the last change. */
  getState(): SyncRunnerState
  /** Calls `listener` with the new state after every change. Returns the way to stop. */
  subscribe(listener: (state: SyncRunnerState) => void): () => void
}

/**
 * A flush for {@link createSyncRunner} that sends an outbox. `Outbox.flush` stops at the first
 * write that cannot reach the server and says nothing, so this reads the queue after it: a write
 * still pending means the server was not reached, and the runner retries.
 */
export function flushOutbox(
  outbox: {
    flush(): Promise<void>
    entries(): readonly { readonly status: "pending" | "conflict" }[]
  },
): () => Promise<SyncFlushResult> {
  return async () => {
    await outbox.flush()
    return outbox.entries().some((entry) => entry.status === "pending") ? "unreachable" : undefined
  }
}

/** The longest timer delay a browser keeps; a larger one fires after 1 ms, which would loop. */
const MAX_POLL_INTERVAL_MS = 2_147_483_647

/** The runner: see the module documentation for the rules it keeps. */
export function createSyncRunner(options: SyncRunnerOptions): SyncRunner {
  const clock = options.clock ?? createSystemClock()
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 60_000
  const pollIntervalMs = options.pollIntervalMs
  if (
    pollIntervalMs !== undefined &&
    (typeof pollIntervalMs !== "number" || !Number.isFinite(pollIntervalMs) ||
      pollIntervalMs <= 0 ||
      pollIntervalMs > MAX_POLL_INTERVAL_MS)
  ) {
    throw new RangeError(
      `pollIntervalMs must be a positive finite number of at most ${MAX_POLL_INTERVAL_MS} ms, got ${pollIntervalMs}`,
    )
  }
  const isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine !== false)
  const listeners = new Set<(state: SyncRunnerState) => void>()
  let state: SyncRunnerState = { running: false, lastError: null, failures: 0, nextRetryAt: null }
  let active = false
  let again = false
  let inProgress = false
  let retry: TimerHandle | undefined
  let poll: TimerHandle | undefined
  let current: Promise<void> | undefined
  let unlisten: (() => void) | undefined

  function update(patch: Partial<SyncRunnerState>): void {
    state = { ...state, ...patch }
    // A listener that throws must not stop the run it was told about, or every later run.
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch (error) {
        console.error("sync runner: a state listener threw", error)
      }
    }
  }

  function cancelRetry(): void {
    if (retry) clock.clearTimeout(retry)
    retry = undefined
  }

  function cancelPoll(): void {
    if (poll) clock.clearTimeout(poll)
    poll = undefined
  }

  function pageIsLive(): boolean {
    const target = options.target ?? (globalThis as unknown as SyncRunnerTarget)
    return target.document.visibilityState !== "hidden" && isOnline()
  }

  function schedulePoll(): void {
    if (pollIntervalMs === undefined || !pageIsLive()) return
    poll = clock.setTimeout(() => {
      poll = undefined
      // Hidden or offline now: stay quiet; the wake-up that returns the person runs it.
      if (active && pageIsLive()) void kick()
    }, pollIntervalMs)
  }

  function scheduleRetry(): void {
    const delay = backoffDelay({
      rawMs: baseDelayMs * 2 ** Math.max(0, state.failures - 1),
      maxMs: maxDelayMs,
      jitterRatio: 0.2,
      mode: "downward",
      random: options.random,
    })
    retry = clock.setTimeout(() => {
      retry = undefined
      void kick()
    }, delay)
    update({ nextRetryAt: clock.now() + delay })
  }

  async function run(): Promise<void> {
    inProgress = true
    cancelRetry()
    cancelPoll()
    update({ running: true, nextRetryAt: null })
    try {
      do {
        again = false
        let failed = false
        try {
          const result = await options.flush()
          if (result === "unreachable") {
            failed = true
            update({ failures: state.failures + 1, lastError: null })
          } else {
            update({ failures: 0, lastError: null })
          }
        } catch (error) {
          failed = true
          update({ failures: state.failures + 1, lastError: error })
        }
        // A kick that arrived meanwhile runs at once, in place of the wait this failure would set.
        if (failed && !again && active) scheduleRetry()
        else if (!failed && !again && active) schedulePoll()
      } while (again && active)
    } finally {
      again = false
      inProgress = false
      update({ running: false })
    }
  }

  function kick(): Promise<void> {
    if (!active) return Promise.resolve()
    if (inProgress) {
      again = true
      return current ?? Promise.resolve()
    }
    current = run()
    return current
  }

  return {
    start() {
      if (active) return
      active = true
      const target = options.target ?? (globalThis as unknown as SyncRunnerTarget)
      const onFocus = () => void kick()
      const stopResume = watchPageResume(() => void kick(), target)
      target.addEventListener("focus", onFocus)
      unlisten = () => {
        stopResume()
        target.removeEventListener("focus", onFocus)
      }
      void kick()
    },
    stop() {
      if (!active) return
      active = false
      unlisten?.()
      unlisten = undefined
      cancelRetry()
      cancelPoll()
      if (state.nextRetryAt !== null) update({ nextRetryAt: null })
    },
    kick,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
