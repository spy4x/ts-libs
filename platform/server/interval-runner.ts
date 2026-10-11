/**
 * Runs a task again and again, and survives its failures.
 *
 * @module
 */

import { systemTimerPort, type TimerPort } from "./throttled-saver.ts"

/** Options of {@link startIntervalRunner}. */
export interface IntervalRunnerOptions {
  /** The work of one tick. A rejection or a throw is reported, and the next tick still runs. */
  task: () => unknown
  /** Milliseconds between the end of one tick and the start of the next. Positive and finite. */
  intervalMs: number
  /**
   * Called with the error of every failed tick. It must not throw; if it does, the error is
   * dropped and the runner goes on.
   */
  onError: (error: unknown) => void
  /** Scheduling; defaults to {@link systemTimerPort}. Inject a fake one in a test. */
  timers?: TimerPort
}

/**
 * Runs `task` every `intervalMs` until the returned function is called.
 *
 * - **A failed tick never stops the next one.** An error thrown inside a timer callback would end a
 *   server process and drop every open connection, so it goes to `onError` instead.
 * - **Ticks never overlap.** The next tick is scheduled only after the current one has finished,
 *   so a slow task makes the period longer instead of running twice at once. The period is
 *   therefore `intervalMs` plus the time the task takes.
 * - **The first tick runs after one interval**, not at once.
 * - **After the returned stop function is called, nothing new starts.** A tick that is already
 *   running is not interrupted, but it schedules no successor. Calling stop twice is harmless.
 *
 * @example
 * ```ts
 * const stop = startIntervalRunner({
 *   task: () => removeExpiredRows(),
 *   intervalMs: 3_600_000,
 *   onError: (error) => console.error("cleanup failed, retrying next tick", error),
 * })
 * // on shutdown
 * stop()
 * ```
 *
 * @throws {RangeError} When `intervalMs` is not a positive finite number.
 */
export function startIntervalRunner(options: IntervalRunnerOptions): () => void {
  const { task, intervalMs, onError } = options
  const timers = options.timers ?? systemTimerPort
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive number")
  }
  let stopped = false
  let handle: number | undefined

  const schedule = () => {
    handle = timers.set(tick, intervalMs)
  }
  const tick = async () => {
    handle = undefined
    try {
      await task()
    } catch (error) {
      try {
        onError(error)
      } catch {
        // A reporter that throws must not stop the runner.
      }
    }
    if (!stopped) schedule()
  }

  schedule()
  return () => {
    stopped = true
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
  }
}
