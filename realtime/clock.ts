/**
 * Time and timer ports.
 *
 * Every timing behaviour in this package goes through a {@link Clock}, so tests drive a
 * deterministic scheduler instead of sleeping, and no module reads `Date.now` or the timer globals
 * at import time.
 */

/** Opaque handle to a scheduled callback. */
export interface TimerHandle {
  /** Identifier, unique within the clock that issued the handle. */
  readonly id: number
}

/** Time source and timer factory. Implementations: {@link createSystemClock}, `FakeClock`. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  setInterval(callback: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/**
 * Clock backed by the platform timers.
 *
 * The globals are read at call time rather than captured at import time, so the module stays safe
 * to import on a server, in a worker and in a test that replaces `globalThis`.
 */
export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    setInterval: (callback, ms) => ({
      id: Number(globalThis.setInterval(callback, ms)),
    }),
    clearInterval: (handle) => globalThis.clearInterval(handle.id),
    setTimeout: (callback, ms) => ({
      id: Number(globalThis.setTimeout(callback, ms)),
    }),
    clearTimeout: (handle) => globalThis.clearTimeout(handle.id),
  }
}
