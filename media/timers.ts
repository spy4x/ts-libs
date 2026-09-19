/**
 * The timer port.
 *
 * Anything that schedules work takes its timers from here, so tests can drive
 * deadlines deterministically instead of sleeping. `test-doubles.ts` ships
 * `FakeTimers` for that; production passes `systemTimers`.
 */

/** Scheduling primitives, injectable. */
export interface Timers {
  /** Schedules `handler` after `delayMs` and returns a handle. */
  setTimeout(handler: () => void, delayMs: number): number
  /** Cancels a pending handle. Cancelling an unknown handle is a no-op. */
  clearTimeout(handle: number): void
}

/** The real platform timers. */
export const systemTimers: Timers = {
  setTimeout: (handler: () => void, delayMs: number): number => setTimeout(handler, delayMs),
  clearTimeout: (handle: number): void => clearTimeout(handle),
}
