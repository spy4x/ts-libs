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
  /**
   * Run the first tick at once instead of after one interval. The second tick is then scheduled
   * only after the first has finished, as every other tick is. A process restarted more often than
   * `intervalMs` would otherwise never run the task. Defaults to `false`.
   */
  runFirstTickNow?: boolean
  /**
   * Give up waiting on a tick after this many milliseconds: `onError` gets an error saying so, and
   * the next tick is scheduled. Without it, a task that never settles stops the runner for good.
   * The abandoned task is not cancelled, so if it settles later it may overlap a newer tick.
   * Positive and at most 2 147 483 647. Defaults to no limit.
   */
  tickTimeoutMs?: number
}

/**
 * Runs `task` every `intervalMs` until the returned function is called.
 *
 * - **A failed tick never stops the next one.** An error thrown inside a timer callback would end a
 *   server process and drop every open connection, so it goes to `onError` instead.
 * - **Ticks never overlap.** The next tick is scheduled only after the current one has finished,
 *   so a slow task makes the period longer instead of running twice at once. The period is
 *   therefore `intervalMs` plus the time the task takes.
 * - **The first tick runs after one interval**, unless `runFirstTickNow` is set: then it starts
 *   before this function returns, and the interval starts when it ends.
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
 * @throws {RangeError} When `intervalMs` is not positive or is above 2 147 483 647 (about 24.8
 *   days), the longest delay a timer takes.
 */
export function startIntervalRunner(options: IntervalRunnerOptions): () => void {
  const { task, intervalMs, onError, tickTimeoutMs } = options
  const timers = options.timers ?? systemTimerPort
  // A longer delay does not fit a timer: runtimes fire it after 1 ms instead.
  if (!fitsTimer(intervalMs)) {
    throw new RangeError("intervalMs must be from 1 to 2147483647 (about 24.8 days)")
  }
  if (tickTimeoutMs !== undefined && !fitsTimer(tickTimeoutMs)) {
    throw new RangeError("tickTimeoutMs must be from 1 to 2147483647 (about 24.8 days)")
  }
  let stopped = false
  let handle: number | undefined
  let timeoutHandle: number | undefined

  /** The tick's task, rejected after `tickTimeoutMs` when it has not settled by then. */
  const run = (): Promise<unknown> => {
    // The executor runs synchronously, so the first tick still starts before this function returns,
    // and a synchronous throw becomes a rejection.
    const work = new Promise((resolve) => resolve(task()))
    if (tickTimeoutMs === undefined) return work
    return new Promise((resolve, reject) => {
      timeoutHandle = timers.set(() => {
        timeoutHandle = undefined
        reject(new Error(`interval task did not settle within ${tickTimeoutMs} ms`))
      }, tickTimeoutMs)
      const settle = () => {
        if (timeoutHandle !== undefined) timers.clear(timeoutHandle)
        timeoutHandle = undefined
      }
      work.then((value) => {
        settle()
        resolve(value)
      }, (error) => {
        settle()
        reject(error)
      })
    })
  }

  const schedule = () => {
    handle = timers.set(tick, intervalMs)
  }
  const tick = async () => {
    handle = undefined
    try {
      await run()
    } catch (error) {
      try {
        onError(error)
      } catch {
        // A reporter that throws must not stop the runner.
      }
    }
    if (!stopped) schedule()
  }

  if (options.runFirstTickNow === true) void tick()
  else schedule()
  return () => {
    stopped = true
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
    if (timeoutHandle !== undefined) timers.clear(timeoutHandle)
    timeoutHandle = undefined
  }
}

/** Whether `ms` is a delay a timer can hold: positive and at most 2 147 483 647. */
function fitsTimer(ms: number): boolean {
  return ms > 0 && ms <= 2_147_483_647
}
